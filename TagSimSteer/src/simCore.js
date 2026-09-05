// Headless vehicle physics for the tag-axle bus, extracted from
// ../tag-steering-simulator.jsx so it can be stepped from a training/replay
// loop with no React, no DOM, and no requestAnimationFrame — just
// `stepSim(state, vehicle, action, dt)` called as fast as a caller likes.
//
// This is a deliberate fork, not an import back into the component (yet):
// the live component's drive loop also interleaves this math with
// trail-recording, the boundary speed governor, and the boundary auto-steer
// feature, none of which are core vehicle dynamics. Keep the math here
// numerically identical to its counterpart in tag-steering-simulator.jsx —
// a policy trained against this module is only useful if it behaves the same
// way when replayed inside the real simulator.

// ---------- math helpers ----------
export const toRad = (d) => (d * Math.PI) / 180;
export const toDeg = (r) => (r * 180) / Math.PI;
// Signed angle difference, wrapped to (-π, π].
export const wrapAngle = (r) => Math.atan2(Math.sin(r), Math.cos(r));

export function rotatePt(p, ang) {
  const c = Math.cos(ang), s = Math.sin(ang);
  return { x: p.x * c - p.y * s, y: p.x * s + p.y * c };
}

// ---------- wheel/geometry constants ----------
export const WHEEL_HALF_LEN = 0.42, WHEEL_HALF_W = 0.16;
export const DUAL_GAP = 0.28; // centre-to-centre spacing of a dual (twin) tyre pair

function wheelLocalPts(halfLen, halfW) {
  return [
    { x: halfLen, y: halfW }, { x: halfLen, y: -halfW },
    { x: -halfLen, y: -halfW }, { x: -halfLen, y: halfW },
  ];
}

function wheelStaticCorners(center, angleRad, halfLen = WHEEL_HALF_LEN, halfW = WHEEL_HALF_W) {
  const local = wheelLocalPts(halfLen, halfW);
  return local.map((lp) => {
    const r = rotatePt(lp, angleRad);
    return { x: center.x + r.x, y: center.y + r.y };
  });
}

// ---------- geometry model (steady-state cornering kinematics) ----------
// Verbatim copy of computeGeometry() from tag-steering-simulator.jsx — see that
// file's module docstring and TagSimSteer/CLAUDE.md for the coordinate
// convention (chassis-local x=forward, y=left) and wheel-numbering convention.
export function computeGeometry(params) {
  const { Lfd, Ldt, Fo, Ro, Wb, Tw, deltaFdeg, tagRatio, lockoutOn, lockoutSpeed, speed } = params;
  const isStraight = deltaFdeg === 0;
  const deltaF = toRad(deltaFdeg);

  let R = null;
  let idealDeltaT = 0;
  if (!isStraight) {
    R = Lfd / Math.tan(deltaF);
    idealDeltaT = -Math.atan(Ldt / R);
  }
  const tagLocked = lockoutOn && speed >= lockoutSpeed;
  const appliedDeltaT = isStraight ? 0 : tagLocked ? 0 : idealDeltaT * tagRatio;
  const scrubDeg = isStraight ? 0 : toDeg(idealDeltaT - appliedDeltaT);

  const halfW = Wb / 2, halfT = Tw / 2;
  const bodyCorners = {
    FL: { x: Lfd + Fo, y: halfW }, FR: { x: Lfd + Fo, y: -halfW },
    RL: { x: -(Ldt + Ro), y: halfW }, RR: { x: -(Ldt + Ro), y: -halfW },
  };
  const wheelCenters = {
    frontL: { x: Lfd, y: halfT }, frontR: { x: Lfd, y: -halfT },
    driveL: { x: 0, y: halfT }, driveR: { x: 0, y: -halfT },
    tagL: { x: -Ldt, y: halfT }, tagR: { x: -Ldt, y: -halfT },
  };

  let C = null, outerRadius = 0, radii = {}, offTracking = null, turningDiameter = null, frontOuterWheelRadius = 0;
  let mow1 = 0, mow2 = 0, tailSwing7 = 0, tailSwing8 = 0;
  const w3Center = { x: 0, y: halfT + DUAL_GAP / 2 };
  const w4Center = { x: 0, y: halfT - DUAL_GAP / 2 };
  const w6Center = { x: 0, y: -halfT - DUAL_GAP / 2 };
  if (!isStraight) {
    C = { x: 0, y: R };
    const allPts = { ...bodyCorners, ...wheelCenters, w3: w3Center, w4: w4Center, w6: w6Center };
    const steeredWheels = [
      { key: "frontL", center: wheelCenters.frontL, angle: deltaF },
      { key: "frontR", center: wheelCenters.frontR, angle: deltaF },
      { key: "tagL", center: wheelCenters.tagL, angle: appliedDeltaT },
      { key: "tagR", center: wheelCenters.tagR, angle: appliedDeltaT },
    ];
    steeredWheels.forEach((sw) => {
      wheelStaticCorners(sw.center, sw.angle).forEach((corner, i) => {
        allPts[sw.key + "_corner" + i] = corner;
      });
    });
    for (const k in allPts) {
      const p = allPts[k];
      radii[k] = Math.hypot(p.x - C.x, p.y - C.y);
    }
    outerRadius = Math.max(...Object.values(radii));
    offTracking = Math.abs(radii.w3 - radii.w6);
    turningDiameter = 2 * outerRadius;
    frontOuterWheelRadius = Math.max(
      ...Object.keys(radii).filter((k) => k.startsWith("frontL_corner") || k.startsWith("frontR_corner")).map((k) => radii[k])
    );
    mow1 = radii.frontL - radii.FL;
    mow2 = radii.frontR - radii.FR;
    tailSwing7 = radii.RL - radii.tagL;
    tailSwing8 = radii.RR - radii.tagR;
  }

  const straightHalfExtent = ((Lfd + Fo + Ldt + Ro) / 2) * 1.35;

  return {
    isStraight, deltaFdeg, deltaF, R, idealDeltaT, appliedDeltaT, tagLocked, scrubDeg,
    bodyCorners, wheelCenters, C, radii, outerRadius, offTracking, turningDiameter, frontOuterWheelRadius,
    mow1, mow2, tailSwing7, tailSwing8,
    straightHalfExtent, Lfd, Ldt, Fo, Ro, Wb, Tw,
  };
}

export function poseTransform(p, pose) {
  const c = Math.cos(pose.theta), s = Math.sin(pose.theta);
  return { x: pose.x + p.x * c - p.y * s, y: pose.y + p.x * s + p.y * c };
}

// ---------- steering: resolution + rate limiting ----------
export const MAX_LOCK_DEG = 50;
export const LOCK_TO_LOCK_SECONDS = 4;

export const STEER_STEPS = (() => {
  const vals = [];
  for (let i = -100; i <= 100; i++) vals.push(Math.round(i * 5) / 10);
  return vals;
})();

export function closestSteerIndex(val) {
  let best = 0, bestDiff = Infinity;
  for (let i = 0; i < STEER_STEPS.length; i++) {
    const d = Math.abs(STEER_STEPS[i] - val);
    if (d < bestDiff) { bestDiff = d; best = i; }
  }
  return best;
}

const STEER_RATE_RATIO = 2;
const STEER_MIN_RATE = (MAX_LOCK_DEG * Math.log(STEER_RATE_RATIO)) / ((LOCK_TO_LOCK_SECONDS / 2) * (STEER_RATE_RATIO - 1));
const STEER_MAX_RATE = STEER_MIN_RATE * STEER_RATE_RATIO;
const STEER_RATE_K = (STEER_MAX_RATE - STEER_MIN_RATE) / MAX_LOCK_DEG;

// Max angular rate (deg/s) the applied angle may change at, given its current unsigned angle.
export function steerRampRate(absAngleDeg) {
  const a = Math.min(MAX_LOCK_DEG, Math.max(0, absAngleDeg));
  return STEER_MIN_RATE + STEER_RATE_K * a;
}

export const clampSteerDeg = (deg) => Math.min(MAX_LOCK_DEG, Math.max(-MAX_LOCK_DEG, deg));

// ---------- driving controls: throttle / brake ----------
export const MAX_SPEED_KMH = 90;
const ZERO_TO_MAX_SECONDS = 12.5;
const THROTTLE_ACCEL_RATIO = 3;
const MAX_SPEED_MS = MAX_SPEED_KMH / 3.6;
const THROTTLE_ACCEL_HIGH = (MAX_SPEED_MS * Math.log(THROTTLE_ACCEL_RATIO)) / (ZERO_TO_MAX_SECONDS * (THROTTLE_ACCEL_RATIO - 1));
const THROTTLE_ACCEL_LOW = THROTTLE_ACCEL_HIGH * THROTTLE_ACCEL_RATIO;

export function throttleAccel(speedKmh) {
  const t = Math.min(1, speedKmh / MAX_SPEED_KMH);
  return THROTTLE_ACCEL_LOW + (THROTTLE_ACCEL_HIGH - THROTTLE_ACCEL_LOW) * t;
}

export const BRAKE_RAMP_SECONDS = 3;
const BRAKE_DECEL_INITIAL = 1.5;
const BRAKE_DECEL_MAX = 5.5;

export function brakeDecel(heldSeconds) {
  const t = Math.min(1, heldSeconds / BRAKE_RAMP_SECONDS);
  return BRAKE_DECEL_INITIAL + (BRAKE_DECEL_MAX - BRAKE_DECEL_INITIAL) * t;
}

// ---------- vehicle defaults ----------
// Confirmed dimensions of the reference BCC Volvo/Scania 6x2 tag-axle bus
// (fleet #5054) — see TagSimSteer/CLAUDE.md. Tw has no compliance-plate
// figure and remains an estimate.
export const DEFAULT_VEHICLE = {
  Lfd: 7.0, Ldt: 1.4, Fo: 2.75, Ro: 3.35, Wb: 2.48, Tw: 2.1,
  tagRatio: 1.0, lockoutOn: true, lockoutSpeed: 25,
};

// A single rAF frame in the live sim never integrates more than this much
// dt in one go (a backgrounded tab, a slow frame) — matches the drive loop's
// own clamp so headless steps stay comparable to live playback.
export const MAX_STEP_DT = 0.05;

// ---------- headless step ----------
// state:  { pose: {x,y,theta}, speedKmh, appliedSteerDeg, brakeHeldSeconds }
//   appliedSteerDeg/pose follow the UI-facing sign convention used by the
//   component's `steerInput` (positive = steer right); deltaFdeg = -appliedSteerDeg.
// vehicle: geometry + tag-axle params, see DEFAULT_VEHICLE.
// action: { steerTargetDeg, throttle: bool, brake: bool }
export function createInitialState(pose = { x: 0, y: 0, theta: 0 }) {
  return { pose, speedKmh: 0, appliedSteerDeg: 0, brakeHeldSeconds: 0 };
}

export function stepSim(state, vehicle, action, dtIn) {
  const dt = Math.min(dtIn, MAX_STEP_DT);
  const steerTargetDeg = clampSteerDeg(action.steerTargetDeg ?? 0);

  // 1. Steering rate limit — chase the target at steerRampRate(current angle),
  // same as the component's independent ramp effect.
  const diff = steerTargetDeg - state.appliedSteerDeg;
  let appliedSteerDeg;
  if (Math.abs(diff) < 1e-9) {
    appliedSteerDeg = steerTargetDeg;
  } else {
    const maxStep = steerRampRate(Math.abs(state.appliedSteerDeg)) * dt;
    appliedSteerDeg = Math.abs(diff) <= maxStep ? steerTargetDeg : state.appliedSteerDeg + Math.sign(diff) * maxStep;
  }

  // 2. Speed — brake wins over throttle, matching the drive loop; no key held = coast.
  let speedKmh = state.speedKmh;
  let brakeHeldSeconds = state.brakeHeldSeconds;
  if (action.brake) {
    brakeHeldSeconds += dt;
    speedKmh = Math.max(0, speedKmh - brakeDecel(brakeHeldSeconds) * 3.6 * dt);
  } else {
    brakeHeldSeconds = 0;
    if (action.throttle) {
      speedKmh = Math.min(MAX_SPEED_KMH, speedKmh + throttleAccel(speedKmh) * 3.6 * dt);
    }
  }

  // 3. Geometry at the newly-ramped steer angle (deltaFdeg = -appliedSteerDeg).
  const geom = computeGeometry({ ...vehicle, deltaFdeg: -appliedSteerDeg, speed: speedKmh });

  // 4. Pose integration (dead-reckoning Euler step), only while actually moving.
  let pose = state.pose;
  if (speedKmh > 0) {
    const v = (speedKmh * 1000) / 3600;
    const omega = geom.isStraight ? 0 : v / geom.R;
    pose = {
      x: pose.x + v * dt * Math.cos(pose.theta),
      y: pose.y + v * dt * Math.sin(pose.theta),
      theta: pose.theta + omega * dt,
    };
  }

  return { pose, speedKmh, appliedSteerDeg, brakeHeldSeconds, geom };
}
