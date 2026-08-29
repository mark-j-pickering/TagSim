import React, { useState, useEffect, useRef, useMemo } from "react";

// ---------- constants ----------
const VB = 1000;
const MARGIN = 60;

// ---------- math helpers ----------
const toRad = (d) => (d * Math.PI) / 180;
const toDeg = (r) => (r * 180) / Math.PI;

function rotatePt(p, ang) {
  const c = Math.cos(ang), s = Math.sin(ang);
  return { x: p.x * c - p.y * s, y: p.x * s + p.y * c };
}

// ---------- geometry model ----------
function computeGeometry(params) {
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
  const w3Center = { x: 0, y: halfT + DUAL_GAP / 2 }; // leftmost (nearside outer)
  const w4Center = { x: 0, y: halfT - DUAL_GAP / 2 }; // nearside inner
  const w6Center = { x: 0, y: -halfT - DUAL_GAP / 2 }; // rightmost (offside outer)
  if (!isStraight) {
    C = { x: 0, y: R };
    const allPts = { ...bodyCorners, ...wheelCenters, w3: w3Center, w4: w4Center, w6: w6Center };
    // Front and tag wheels steer, so their corners can swing outside their own centre's radius at
    // high lock — fold the actual rotated footprint in, not just the centre point, so wheels like
    // #2 are fully covered by the outer envelope.
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
    const innerDriveRadius = R > 0 ? radii.w3 : radii.w6; // #3 is the inner drive wheel on a left turn, #6 on a right turn
    offTracking = Math.abs(radii.w3 - radii.w6); // drive axle's own swept width, 3-to-6
    turningDiameter = 2 * outerRadius;
    frontOuterWheelRadius = Math.max(
      ...Object.keys(radii).filter((k) => k.startsWith("frontL_corner") || k.startsWith("frontR_corner")).map((k) => radii[k])
    );
    // "Mowing the grass": how far the front overhang corner (FL/FR) swings past its own wheel's
    // path (1 or 2) — positive means the nose cuts in beyond where that wheel tracks.
    mow1 = radii.frontL - radii.FL;
    mow2 = radii.frontR - radii.FR;
    // Tail swing distance: how far each rear corner sits from its own same-side tag wheel's path
    // (RL vs #7 nearside, RR vs #8 offside) — whichever side is currently outside the curve reads
    // as the meaningful "swing" figure; the other reads the inside corner's tuck-in instead.
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

function poseTransform(p, pose) {
  const c = Math.cos(pose.theta), s = Math.sin(pose.theta);
  return { x: pose.x + p.x * c - p.y * s, y: pose.y + p.x * s + p.y * c };
}

function computeView(geom, pose, viewMode) {
  if (viewMode === "bus") {
    // Fixed scale: the vehicle's own length occupies roughly a third of the map height,
    // regardless of steering — camera just follows the bus.
    const vehicleLength = geom.Lfd + geom.Fo + geom.Ldt + geom.Ro;
    const scale = ((VB / 3) / vehicleLength) * 1.2;
    return { scale, originX: VB / 2 + pose.y * scale, originY: VB / 2 + pose.x * scale };
  }
  let center, fitExtent;
  if (geom.isStraight) {
    center = { x: pose.x, y: pose.y };
    fitExtent = geom.straightHalfExtent;
  } else {
    center = poseTransform(geom.C, pose); // turn centre stays centred, in current world position
    fitExtent = geom.outerRadius * 1.05; // fit the whole swept circle, no clipping
  }
  const scale = (VB / 2 - MARGIN) / fitExtent;
  return { scale, originX: VB / 2 + center.y * scale, originY: VB / 2 + center.x * scale };
}

function toScreen(view, p) {
  return { x: view.originX - p.y * view.scale, y: view.originY - p.x * view.scale };
}

function longLineScreen(yOffset, pose, view) {
  const p1 = toScreen(view, poseTransform({ x: 1000, y: yOffset }, pose));
  const p2 = toScreen(view, poseTransform({ x: -1000, y: yOffset }, pose));
  return { p1, p2 };
}

function longBandPoints(yLo, yHi, pose, view) {
  const corners = [
    { x: 1000, y: yHi }, { x: 1000, y: yLo }, { x: -1000, y: yLo }, { x: -1000, y: yHi },
  ].map((p) => toScreen(view, poseTransform(p, pose)));
  return ptsToPath(corners);
}

// Radial dimension line: from a fixed chassis point (e.g. a body corner) inward/outward along the
// line to the turn centre, out to a target radius (e.g. that corner's own wheel's path radius) —
// this is "perpendicular to the arc" since a circle's radius is perpendicular to its tangent.
function radialDimWorldPoints(cornerChassisPoint, targetRadius, geom, pose) {
  const cornerWorld = poseTransform(cornerChassisPoint, pose);
  const Cworld = poseTransform(geom.C, pose);
  const dx = cornerWorld.x - Cworld.x, dy = cornerWorld.y - Cworld.y;
  const dist = Math.hypot(dx, dy) || 1;
  const targetWorld = { x: Cworld.x + (dx / dist) * targetRadius, y: Cworld.y + (dy / dist) * targetRadius };
  return { corner: cornerWorld, target: targetWorld };
}

function DimLine({ p1, p2, color, label }) {
  const dx = p2.x - p1.x, dy = p2.y - p1.y;
  const len = Math.hypot(dx, dy) || 1;
  const px = (-dy / len) * 5, py = (dx / len) * 5;
  const midX = (p1.x + p2.x) / 2, midY = (p1.y + p2.y) / 2;
  return (
    <g>
      <line x1={p1.x} y1={p1.y} x2={p2.x} y2={p2.y} stroke={color} strokeWidth="1.6" opacity="0.95" />
      <line x1={p1.x - px} y1={p1.y - py} x2={p1.x + px} y2={p1.y + py} stroke={color} strokeWidth="1.2" opacity="0.95" />
      <line x1={p2.x - px} y1={p2.y - py} x2={p2.x + px} y2={p2.y + py} stroke={color} strokeWidth="1.2" opacity="0.95" />
      {label && (
        <text x={midX + 7} y={midY - 5} fontFamily="'Space Mono',monospace" fontSize="10.5" fill={color} style={{ paintOrder: "stroke", stroke: COL.panelAlt, strokeWidth: 3 }}>
          {label}
        </text>
      )}
    </g>
  );
}

// ---------- wheel polygon ----------
const WHEEL_HALF_LEN = 0.42, WHEEL_HALF_W = 0.16;
const DUAL_HALF_LEN = 0.42, DUAL_HALF_W = 0.085; // narrower single tyre within a dual pair
const DUAL_GAP = 0.28; // centre-to-centre spacing of a dual (twin) tyre pair

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

function ptsToPath(pts) {
  return pts.map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(" ");
}

// Steering resolution: fine (0.15°) near straight-ahead where a coarse step would otherwise
// collapse several distinct, very-large-radius turns into "straight"; coarser (0.5°) beyond ±3°
// where the extra precision doesn't matter.
const STEER_STEPS = (() => {
  const vals = [];
  for (let i = -76; i <= -7; i++) vals.push(i * 0.5); // -38.0 to -3.5, 0.5° steps
  for (let i = -20; i <= 20; i++) vals.push(Math.round(i * 15) / 100); // -3.0 to 3.0, 0.15° steps
  for (let i = 7; i <= 76; i++) vals.push(i * 0.5); // 3.5 to 38.0, 0.5° steps
  return vals;
})();

function closestSteerIndex(val) {
  let best = 0, bestDiff = Infinity;
  for (let i = 0; i < STEER_STEPS.length; i++) {
    const d = Math.abs(STEER_STEPS[i] - val);
    if (d < bestDiff) { bestDiff = d; best = i; }
  }
  return best;
}
const COL = {
  bg: "#0b1c30", panel: "#0e2338", panelAlt: "#0a1a2c",
  grid: "rgba(200,225,245,0.05)", gridMajor: "rgba(200,225,245,0.10)",
  outline: "#eef6fb", outlineFill: "rgba(238,246,251,0.045)",
  front: "#ffb937", drive: "#8fa9bd", tag: "#ff7a56",
  pathOuter: "#7fd1e0", pathInner: "#ff7a56", dim: "#9fc3db",
  tailSwing: "#ffd166",
  w3: "#c9f24a", w6: "#b18aff",
  text: "#eaf2f8", textDim: "#7d99b0", amber: "#ffb937",
};

function Slider({ label, unit, value, min, max, step, onChange, accent = COL.amber }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}>
        <span style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 12.5, letterSpacing: 0.5, color: COL.textDim, textTransform: "uppercase" }}>{label}</span>
        <span style={{ fontFamily: "'Space Mono', monospace", fontSize: 12.5, color: COL.text }}>{value.toFixed(step < 1 ? 2 : 0)}{unit}</span>
      </div>
      <input
        type="range" min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        style={{ width: "100%", accentColor: accent, height: 4 }}
      />
    </div>
  );
}

function SteppedSlider({ label, unit, value, steps, onChange, accent = COL.amber }) {
  const index = closestSteerIndex(value);
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}>
        <span style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 12.5, letterSpacing: 0.5, color: COL.textDim, textTransform: "uppercase" }}>{label}</span>
        <span style={{ fontFamily: "'Space Mono', monospace", fontSize: 12.5, color: COL.text }}>{value % 1 === 0 ? value.toFixed(0) : value.toFixed(2)}{unit}</span>
      </div>
      <input
        type="range" min={0} max={steps.length - 1} step={1} value={index}
        onChange={(e) => onChange(steps[parseInt(e.target.value, 10)])}
        style={{ width: "100%", accentColor: accent, height: 4 }}
      />
    </div>
  );
}

function ReadCell({ label, value, accent }) {
  return (
    <div style={{ padding: "8px 10px", borderRight: `1px solid rgba(200,225,245,0.10)` }}>
      <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 10.5, letterSpacing: 0.6, color: COL.textDim, textTransform: "uppercase" }}>{label}</div>
      <div style={{ fontFamily: "'Space Mono', monospace", fontSize: 15, color: accent || COL.text, marginTop: 2 }}>{value}</div>
    </div>
  );
}

// ---------- main component ----------
export default function BusSteeringSimulator() {
  const [Lfd, setLfd] = useState(6.0);
  const [Ldt, setLdt] = useState(2.3);
  const [Fo, setFo] = useState(2.6);
  const [Ro, setRo] = useState(1.9);
  const [Wb, setWb] = useState(2.55);
  const [Tw, setTw] = useState(2.1);
  // steerInput: positive = steer right (offside), negative = steer left (nearside) — reversed vs. the raw geometry angle
  const [steerInput, setSteerInput] = useState(-22);
  const deltaFdeg = -steerInput;
  const [tagRatio, setTagRatio] = useState(1.0);
  const [lockoutOn, setLockoutOn] = useState(true);
  const [lockoutSpeed, setLockoutSpeed] = useState(25);
  const [speed, setSpeed] = useState(12);
  const [showBand, setShowBand] = useState(true);
  const [animating, setAnimating] = useState(false);
  const [showGeom, setShowGeom] = useState(false);
  const [gridOpen, setGridOpen] = useState(true);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [viewMode, setViewMode] = useState("circle");

  const [pose, setPose] = useState({ x: 0, y: 0, theta: 0 });
  const rafRef = useRef(null);
  const lastTRef = useRef(null);
  const geomRef = useRef(null);
  const speedRef = useRef(speed);

  const geom = useMemo(
    () => computeGeometry({ Lfd, Ldt, Fo, Ro, Wb, Tw, deltaFdeg, tagRatio, lockoutOn, lockoutSpeed, speed }),
    [Lfd, Ldt, Fo, Ro, Wb, Tw, deltaFdeg, tagRatio, lockoutOn, lockoutSpeed, speed]
  );
  geomRef.current = geom;
  speedRef.current = speed;

  // Only reset the vehicle's position when the physical dimensions change (a different-size bus
  // means the old pose isn't meaningful). Steering, tag ratio and lockout changes leave the bus
  // exactly where it is — only the swept-path circles update to match the new radius.
  useEffect(() => { setPose({ x: 0, y: 0, theta: 0 }); }, [Lfd, Ldt, Fo, Ro, Wb, Tw]);

  // Left/Right arrow keys nudge the steering lock, unless focus is on a form control (which
  // already has its own arrow-key behaviour, e.g. another slider).
  useEffect(() => {
    function onKeyDown(e) {
      if (e.target && (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA")) return;
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        setSteerInput((v) => STEER_STEPS[Math.max(0, closestSteerIndex(v) - 1)]);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        setSteerInput((v) => STEER_STEPS[Math.min(STEER_STEPS.length - 1, closestSteerIndex(v) + 1)]);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // Dead-reckoning integration: reads the current geometry/speed from refs each frame, so changing
  // the steering lock mid-drive just changes the curvature the bus is following from where it is,
  // rather than restarting the loop or resetting position.
  useEffect(() => {
    if (!animating) { lastTRef.current = null; return; }
    function step(t) {
      if (lastTRef.current == null) lastTRef.current = t;
      const dt = Math.min((t - lastTRef.current) / 1000, 0.05);
      lastTRef.current = t;
      const g = geomRef.current;
      const v = (speedRef.current * 1000) / 3600;
      const omega = g.isStraight ? 0 : v / g.R;
      setPose((prev) => ({
        x: prev.x + v * dt * Math.cos(prev.theta),
        y: prev.y + v * dt * Math.sin(prev.theta),
        theta: prev.theta + omega * dt,
      }));
      rafRef.current = requestAnimationFrame(step);
    }
    rafRef.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(rafRef.current);
  }, [animating]);

  // The auto-blend near straight-ahead (below) is already smooth by construction — it's a
  // continuous function of the steering angle, which itself moves in small steps. What needs an
  // explicit animated pan is only a genuine mode switch (the Bus/Circle button). Outside of that
  // short transition, the camera tracks its target exactly every frame — no drift, no lag — so a
  // circle centre stays pinned dead-centre while turning, and bus-centric tracks the bus exactly.
  function computeEffectiveView(mode) {
    const busView = computeView(geom, pose, "bus");
    if (mode === "bus") return busView;
    const circleView = computeView(geom, pose, "circle");
    const t = Math.max(0, Math.min(1, (3 - Math.abs(geom.deltaFdeg)) / 3));
    const lerp = (a, b) => a + (b - a) * t;
    return {
      scale: lerp(circleView.scale, busView.scale),
      originX: lerp(circleView.originX, busView.originX),
      originY: lerp(circleView.originY, busView.originY),
    };
  }

  const targetView = computeEffectiveView(viewMode);

  const [transition, setTransition] = useState(null); // { fromMode, startTime } | null
  const [transitionT, setTransitionT] = useState(1);
  const TRANSITION_MS = 450;

  function selectViewMode(newMode) {
    if (newMode === viewMode) return;
    setTransition({ fromMode: viewMode, startTime: performance.now() });
    setTransitionT(0);
    setViewMode(newMode);
  }

  useEffect(() => {
    if (!transition) return;
    let raf;
    function step(now) {
      const t = Math.min(1, (now - transition.startTime) / TRANSITION_MS);
      setTransitionT(t);
      if (t < 1) raf = requestAnimationFrame(step);
      else setTransition(null);
    }
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [transition]);

  const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

  const displayedView = transition
    ? (() => {
        const fromView = computeEffectiveView(transition.fromMode);
        const eased = easeInOutCubic(transitionT);
        return {
          scale: fromView.scale + (targetView.scale - fromView.scale) * eased,
          originX: fromView.originX + (targetView.originX - fromView.originX) * eased,
          originY: fromView.originY + (targetView.originY - fromView.originY) * eased,
        };
      })()
    : targetView;

  // ---------- build drawable points ----------
  const bodyStatic = ["FL", "FR", "RR", "RL"].map((k) => geom.bodyCorners[k]);
  const bodyWorld = bodyStatic.map((p) => poseTransform(p, pose));
  const bodyScreen = bodyWorld.map((p) => toScreen(displayedView, p));

  const { driveL, driveR } = geom.wheelCenters;
  const wheelDefs = [
    { key: "w1", num: 1, center: geom.wheelCenters.frontL, angle: geom.deltaF, color: COL.front },
    { key: "w2", num: 2, center: geom.wheelCenters.frontR, angle: geom.deltaF, color: COL.front },
    { key: "w3", num: 3, center: { x: driveL.x, y: driveL.y + DUAL_GAP / 2 }, angle: 0, color: COL.drive, dual: true },
    { key: "w4", num: 4, center: { x: driveL.x, y: driveL.y - DUAL_GAP / 2 }, angle: 0, color: COL.drive, dual: true },
    { key: "w5", num: 5, center: { x: driveR.x, y: driveR.y + DUAL_GAP / 2 }, angle: 0, color: COL.drive, dual: true },
    { key: "w6", num: 6, center: { x: driveR.x, y: driveR.y - DUAL_GAP / 2 }, angle: 0, color: COL.drive, dual: true },
    { key: "w7", num: 7, center: geom.wheelCenters.tagL, angle: geom.appliedDeltaT, color: COL.tag },
    { key: "w8", num: 8, center: geom.wheelCenters.tagR, angle: geom.appliedDeltaT, color: COL.tag },
  ];

  // Labels sit directly beside each wheel. The offset point is defined in the wheel's own local
  // frame (rotated by its steer angle) and then carried through the exact same animation/rotation
  // pipeline as the wheel's own corners — so it stays adjacent to the tyre whether the wheel is
  // steered or the vehicle is mid-turn, instead of drifting around it. Odd numbers sit on one side,
  // even numbers the other. Badge text itself is never rotated, so the numbers stay upright.
  const wheelScreens = wheelDefs.map((w) => {
    const staticCorners = wheelStaticCorners(w.center, w.angle);
    const worldCorners = staticCorners.map((p) => poseTransform(p, pose));
    const centerWorld = poseTransform(w.center, pose);
    const centerScreen = toScreen(displayedView, centerWorld);

    const hero = w.num === 3 || w.num === 6;
    const offsetDist = w.dual ? (hero ? 0.82 : 0.56) : 0.75;
    const sign = w.num % 2 === 1 ? 1 : -1;
    const localOffset = rotatePt({ x: 0, y: sign * offsetDist }, w.angle); // rotate with the wheel's own steer angle
    const labelStatic = { x: w.center.x + localOffset.x, y: w.center.y + localOffset.y };
    const labelWorld = poseTransform(labelStatic, pose); // then carry through vehicle pose
    const labelScreen = toScreen(displayedView, labelWorld);

    return { ...w, screen: worldCorners.map((p) => toScreen(displayedView, p)), centerScreen, labelScreen };
  });

  // ghost (locked-straight) tag wheel outline when scrub is present
  const showScrubGhost = !geom.isStraight && Math.abs(geom.scrubDeg) > 0.4;
  const ghostWheels = showScrubGhost
    ? ["tagL", "tagR"].map((key) => {
        const center = geom.wheelCenters[key];
        const staticCorners = wheelStaticCorners(center, geom.idealDeltaT);
        const worldCorners = staticCorners.map((p) => poseTransform(p, pose));
        return { key, screen: worldCorners.map((p) => toScreen(displayedView, p)) };
      })
    : [];

  const Cscreen = geom.C ? toScreen(displayedView, poseTransform(geom.C, pose)) : null;

  // circle radii in screen px
  const R_outer_px = geom.isStraight ? 0 : geom.outerRadius * displayedView.scale;
  const R_pivot_px = geom.isStraight ? 0 : Math.abs(geom.R) * displayedView.scale;
  const innerSide = geom.R > 0 ? "L" : "R";
  const R_tagInner_px = geom.isStraight ? 0 : geom.radii["tag" + innerSide] * displayedView.scale;
  const R_w3_px = geom.isStraight ? 0 : geom.radii.w3 * displayedView.scale;
  const R_w6_px = geom.isStraight ? 0 : geom.radii.w6 * displayedView.scale;
  const R_frontOuterWheel_px = geom.isStraight ? 0 : geom.frontOuterWheelRadius * displayedView.scale;
  const R_bandOuter_px = Math.max(R_w3_px, R_w6_px, R_frontOuterWheel_px);
  const R_bandInner_px = Math.min(R_w3_px, R_w6_px);
  const tailCorner = "R" + (geom.R > 0 ? "R" : "L"); // rear corner on the outside of the curve
  const R_tailSwing_px = geom.isStraight ? 0 : geom.radii[tailCorner] * displayedView.scale;

  // Straight-case (radius infinite): every swept circle degenerates into a pair of parallel lines
  // at the point's fixed lateral offset from the centreline, so the same reference features are
  // drawn as straight bands/lines instead of vanishing.
  const halfT_s = geom.Tw / 2, halfW_s = geom.Wb / 2;
  const w3Y = halfT_s + DUAL_GAP / 2;
  const w6Y = -(halfT_s + DUAL_GAP / 2);
  const frontWheelMaxY_s = halfT_s + WHEEL_HALF_W; // angle is 0 when straight, so no rotation widening
  const bandHalfY = Math.max(Math.abs(w3Y), Math.abs(w6Y), frontWheelMaxY_s);

  // grid pattern step
  const gridMeters = geom.isStraight ? geom.straightHalfExtent / 6 : Math.min(geom.outerRadius, 40) / 7;
  const niceSteps = [0.5, 1, 2, 2.5, 5, 10, 20];
  const gridStep = niceSteps.reduce((best, s) => (Math.abs(s - gridMeters) < Math.abs(best - gridMeters) ? s : best), niceSteps[0]);
  const gridPx = Math.max(gridStep * displayedView.scale, 8);

  const fmt = (v, d = 1) => (v == null ? "—" : v.toFixed(d));

  return (
    <div style={{ background: COL.bg, minHeight: "100%", width: "100%", fontFamily: "'Barlow Condensed', sans-serif", color: COL.text, paddingBottom: 24 }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@400;500;600;700&family=Space+Mono:wght@400;700&display=swap');
        input[type=range]{ -webkit-appearance:none; background:transparent; }
        input[type=range]::-webkit-slider-runnable-track{ height:3px; background:rgba(200,225,245,0.22); border-radius:2px; }
        input[type=range]::-webkit-slider-thumb{ -webkit-appearance:none; margin-top:-6px; width:15px; height:15px; border-radius:2px; background:var(--thumb,#ffb937); border:1px solid #0b1c30; }
        input[type=range]::-moz-range-track{ height:3px; background:rgba(200,225,245,0.22); border-radius:2px; }
        input[type=range]::-moz-range-thumb{ width:14px; height:14px; border-radius:2px; background:#ffb937; border:1px solid #0b1c30; }
        .btn{ font-family:'Barlow Condensed',sans-serif; text-transform:uppercase; letter-spacing:0.6px; font-size:12.5px; padding:8px 12px; border-radius:3px; border:1px solid rgba(200,225,245,0.25); background:rgba(200,225,245,0.04); color:#eaf2f8; cursor:pointer; }
        .btn:active{ transform:translateY(1px); }
        .btnOn{ background:#ffb937; color:#0b1c30; border-color:#ffb937; font-weight:600; }
      `}</style>

      {/* header */}
      <div style={{ padding: "16px 16px 10px", borderBottom: "1px solid rgba(200,225,245,0.12)" }}>
        <div style={{ fontSize: 11, letterSpacing: 1.5, color: COL.tag, textTransform: "uppercase" }}>Plan View Study · Rev A</div>
        <div style={{ fontSize: 24, fontWeight: 600, letterSpacing: 0.3 }}>3-Axle Steer / Tag Articulation</div>
        <div style={{ fontSize: 13, color: COL.textDim, marginTop: 2, lineHeight: 1.4 }}>
          Front axle steers, drive axle fixed (pivot reference), tag axle counter-steers. Default dimensions are an illustrative approximation of a ~12.8 m tag-axle bus — adjust the geometry sliders to match a real spec if you have one.
        </div>
      </div>

      {/* canvas */}
      <div style={{ padding: "12px 12px 0", overflow: "hidden" }}>
        <div style={{ position: "relative", overflow: "hidden", contain: "layout paint" }}>
        <svg
          viewBox={`0 0 ${VB} ${VB}`}
          style={{ width: "100%", height: "auto", aspectRatio: "1/1", background: COL.panelAlt, borderRadius: 4, border: "1px solid rgba(200,225,245,0.14)", overflow: "hidden" }}
        >
          <defs>
            <pattern id="grid" width={gridPx} height={gridPx} patternUnits="userSpaceOnUse">
              <path d={`M ${gridPx} 0 L 0 0 0 ${gridPx}`} fill="none" stroke={COL.grid} strokeWidth="1" />
            </pattern>
            <clipPath id="mapClip">
              <rect x="0" y="0" width={VB} height={VB} />
            </clipPath>
          </defs>
          <g clipPath="url(#mapClip)">
          <rect x="0" y="0" width={VB} height={VB} fill="url(#grid)" />

          {/* straight road centreline, when steering ≈ 0 (radius infinite) */}
          {geom.isStraight && (() => {
            const ahead = toScreen(displayedView, poseTransform({ x: 1000, y: 0 }, pose));
            const behind = toScreen(displayedView, poseTransform({ x: -1000, y: 0 }, pose));
            return (
              <line
                x1={behind.x} y1={behind.y} x2={ahead.x} y2={ahead.y}
                stroke={COL.dim} strokeWidth="1.6" strokeDasharray="10 8" opacity="0.45"
              />
            );
          })()}


          {/* off-tracking band: annulus while turning, a straight parallel strip when driving straight */}
          {showBand && (geom.isStraight ? (
            <polygon points={longBandPoints(-bandHalfY, bandHalfY, pose, displayedView)} fill="rgba(255,122,86,0.14)" />
          ) : (
            <path
              fillRule="evenodd"
              fill="rgba(255,122,86,0.14)"
              d={`M ${Cscreen.x - R_bandOuter_px} ${Cscreen.y} A ${R_bandOuter_px} ${R_bandOuter_px} 0 1 0 ${Cscreen.x + R_bandOuter_px} ${Cscreen.y} A ${R_bandOuter_px} ${R_bandOuter_px} 0 1 0 ${Cscreen.x - R_bandOuter_px} ${Cscreen.y} Z
                 M ${Cscreen.x - R_bandInner_px} ${Cscreen.y} A ${R_bandInner_px} ${R_bandInner_px} 0 1 0 ${Cscreen.x + R_bandInner_px} ${Cscreen.y} A ${R_bandInner_px} ${R_bandInner_px} 0 1 0 ${Cscreen.x - R_bandInner_px} ${Cscreen.y} Z`}
            />
          ))}

          {/* swept path circles while turning, parallel reference lines while driving straight */}
          {geom.isStraight ? (
            <>
              {(() => {
                const l = longLineScreen(halfW_s, pose, displayedView);
                return <line x1={l.p1.x} y1={l.p1.y} x2={l.p2.x} y2={l.p2.y} stroke={COL.pathOuter} strokeWidth="1" strokeDasharray="4 6" opacity="0.35" />;
              })()}
              {(() => {
                const l = longLineScreen(halfT_s, pose, displayedView);
                return <line x1={l.p1.x} y1={l.p1.y} x2={l.p2.x} y2={l.p2.y} stroke={COL.pathInner} strokeWidth="1" strokeDasharray="4 6" opacity="0.35" />;
              })()}
              {(() => {
                const l = longLineScreen(halfW_s, pose, displayedView);
                return <line x1={l.p1.x} y1={l.p1.y} x2={l.p2.x} y2={l.p2.y} stroke={COL.tailSwing} strokeWidth="1.3" strokeDasharray="3 5" opacity="0.75" />;
              })()}
              {/* wheel 3 & 6 — the important ones */}
              {(() => {
                const l = longLineScreen(w3Y, pose, displayedView);
                return (
                  <>
                    <line x1={l.p1.x} y1={l.p1.y} x2={l.p2.x} y2={l.p2.y} stroke={COL.w3} strokeWidth="5" opacity="0.18" />
                    <line x1={l.p1.x} y1={l.p1.y} x2={l.p2.x} y2={l.p2.y} stroke={COL.w3} strokeWidth="2.4" opacity="1" />
                  </>
                );
              })()}
              {(() => {
                const l = longLineScreen(w6Y, pose, displayedView);
                return (
                  <>
                    <line x1={l.p1.x} y1={l.p1.y} x2={l.p2.x} y2={l.p2.y} stroke={COL.w6} strokeWidth="5" opacity="0.18" />
                    <line x1={l.p1.x} y1={l.p1.y} x2={l.p2.x} y2={l.p2.y} stroke={COL.w6} strokeWidth="2.4" opacity="1" />
                  </>
                );
              })()}
            </>
          ) : (
            <>
              <circle cx={Cscreen.x} cy={Cscreen.y} r={R_outer_px} fill="none" stroke={COL.pathOuter} strokeWidth="1" strokeDasharray="4 6" opacity="0.35" />
              <circle cx={Cscreen.x} cy={Cscreen.y} r={R_pivot_px} fill="none" stroke={COL.dim} strokeWidth="1.6" strokeDasharray="10 8" opacity="0.45" />
              <circle cx={Cscreen.x} cy={Cscreen.y} r={R_tagInner_px} fill="none" stroke={COL.pathInner} strokeWidth="1" strokeDasharray="4 6" opacity="0.35" />
              <circle cx={Cscreen.x} cy={Cscreen.y} r={R_tailSwing_px} fill="none" stroke={COL.tailSwing} strokeWidth="1.3" strokeDasharray="3 5" opacity="0.75" />
              {/* wheel 3 & 6 — the important ones */}
              <circle cx={Cscreen.x} cy={Cscreen.y} r={geom.radii.w3 * displayedView.scale} fill="none" stroke={COL.w3} strokeWidth="5" opacity="0.18" />
              <circle cx={Cscreen.x} cy={Cscreen.y} r={geom.radii.w3 * displayedView.scale} fill="none" stroke={COL.w3} strokeWidth="2.4" opacity="1" />
              <circle cx={Cscreen.x} cy={Cscreen.y} r={geom.radii.w6 * displayedView.scale} fill="none" stroke={COL.w6} strokeWidth="5" opacity="0.18" />
              <circle cx={Cscreen.x} cy={Cscreen.y} r={geom.radii.w6 * displayedView.scale} fill="none" stroke={COL.w6} strokeWidth="2.4" opacity="1" />
              {/* center marker */}
              <line x1={Cscreen.x - 9} y1={Cscreen.y} x2={Cscreen.x + 9} y2={Cscreen.y} stroke={COL.dim} strokeWidth="1.4" />
              <line x1={Cscreen.x} y1={Cscreen.y - 9} x2={Cscreen.x} y2={Cscreen.y + 9} stroke={COL.dim} strokeWidth="1.4" />
              <circle cx={Cscreen.x} cy={Cscreen.y} r="3" fill={COL.dim} />
              <text x={Cscreen.x + 12} y={Cscreen.y - 10} fontFamily="'Space Mono',monospace" fontSize="12" fill={COL.dim}>
                C · R {fmt(Math.abs(geom.R))}m
              </text>
            </>
          )}

          {/* optional geometry construction lines */}
          {showGeom && !geom.isStraight && wheelDefs.map((w) => {
            const wc = poseTransform(w.center, pose);
            const s = toScreen(displayedView, wc);
            return <line key={"g" + w.key} x1={Cscreen.x} y1={Cscreen.y} x2={s.x} y2={s.y} stroke="rgba(200,225,245,0.18)" strokeWidth="0.8" />;
          })}

          {/* mowing-the-grass (#1/#2) and tail-swing (#7/#8) dimension lines — radial, so
              perpendicular to each wheel's own arc, from the body corner to that wheel's path */}
          {showGeom && !geom.isStraight && (() => {
            const dims = [
              { corner: geom.bodyCorners.FL, radius: geom.radii.frontL, color: COL.front, value: geom.mow1 },
              { corner: geom.bodyCorners.FR, radius: geom.radii.frontR, color: COL.front, value: geom.mow2 },
              { corner: geom.bodyCorners.RL, radius: geom.radii.tagL, color: COL.tailSwing, value: geom.tailSwing7 },
              { corner: geom.bodyCorners.RR, radius: geom.radii.tagR, color: COL.tailSwing, value: geom.tailSwing8 },
            ];
            return dims.map((d, i) => {
              const { corner, target } = radialDimWorldPoints(d.corner, d.radius, geom, pose);
              const p1 = toScreen(displayedView, corner);
              const p2 = toScreen(displayedView, target);
              return <DimLine key={"dim" + i} p1={p1} p2={p2} color={d.color} label={fmt(Math.abs(d.value), 2) + "m"} />;
            });
          })()}

          {/* vehicle body */}
          <polygon points={ptsToPath(bodyScreen)} fill={COL.outlineFill} stroke={COL.outline} strokeWidth="2.2" strokeLinejoin="round" />
          {/* front cap accent line */}
          <line x1={bodyScreen[0].x} y1={bodyScreen[0].y} x2={bodyScreen[1].x} y2={bodyScreen[1].y} stroke={COL.front} strokeWidth="3" />

          {/* scrub ghost wheels */}
          {ghostWheels.map((g) => (
            <polygon key={g.key} points={ptsToPath(g.screen)} fill="none" stroke={COL.tag} strokeOpacity="0.35" strokeDasharray="3 3" strokeWidth="1.4" />
          ))}

          {/* wheels */}
          {wheelScreens.map((w) => {
            const hero = w.num === 3 || w.num === 6;
            return (
              <polygon
                key={w.key}
                points={ptsToPath(w.screen)}
                fill={w.color}
                opacity={hero ? 1 : 0.7}
                stroke={hero ? "#eef6fb" : "#0b1c30"}
                strokeWidth={hero ? 1.8 : 1}
              />
            );
          })}

          {/* wheel number badges */}
          {wheelScreens.map((w) => {
            const hero = w.num === 3 || w.num === 6;
            return (
              <g key={w.key + "-badge"}>
                {hero && <circle cx={w.labelScreen.x} cy={w.labelScreen.y} r="15" fill="none" stroke={w.color} strokeWidth="1.4" opacity="0.55" />}
                <circle cx={w.labelScreen.x} cy={w.labelScreen.y} r={hero ? 12.5 : 10.5} fill={hero ? w.color : COL.panelAlt} stroke={w.color} strokeWidth={hero ? 2 : 1.4} />
                <text x={w.labelScreen.x} y={w.labelScreen.y + (hero ? 4.5 : 4)} textAnchor="middle" fontFamily="'Space Mono',monospace" fontSize={hero ? 13.5 : 11.5} fontWeight="700" fill={hero ? COL.panelAlt : COL.text}>
                  {w.num}
                </text>
              </g>
            );
          })}
          </g>
        </svg>
        <div style={{ position: "absolute", left: 10, top: 10, display: "flex", flexDirection: "column", gap: 4, background: "rgba(10,26,44,0.72)", borderRadius: 4, padding: "8px 10px", fontSize: 11, color: COL.textDim, textTransform: "uppercase", letterSpacing: 0.4 }}>
          <LegendDot color={COL.front} label="Front · steers (1–2)" />
          <LegendDot color={COL.drive} label="Drive · fixed, dual (3–6)" />
          <LegendDot color={COL.tag} label="Tag · counter-steers (7–8)" />
          <LegendDot color={COL.w3} label="Wheel 3 path — nearside" />
          <div style={{ fontSize: 10.5, opacity: 0.7, marginTop: 2 }}>Nearside = left (1, 3, 4, 7)</div>
        </div>
        <div style={{ position: "absolute", right: 10, top: 10, display: "flex", flexDirection: "column", gap: 4, alignItems: "flex-end", background: "rgba(10,26,44,0.72)", borderRadius: 4, padding: "8px 10px", fontSize: 11, color: COL.textDim, textTransform: "uppercase", letterSpacing: 0.4, textAlign: "right" }}>
          <LegendDot color={COL.w6} label="Wheel 6 path — offside" />
          <LegendDot color={COL.pathOuter} label="Outer swept path (ref.)" />
          <LegendDot color={COL.pathInner} label="Tag inner path (ref.)" />
          <LegendDot color={COL.tailSwing} label="Tail swing (rear outer corner)" />
          <div style={{ fontSize: 10.5, opacity: 0.7, marginTop: 2 }}>Offside = right (2, 5, 6, 8)</div>
        </div>
        <div style={{ position: "absolute", left: 10, bottom: 10, display: "flex", boxShadow: "0 2px 8px rgba(0,0,0,0.45)", borderRadius: 3, overflow: "hidden" }}>
          <button
            onClick={() => selectViewMode("bus")}
            style={{
              fontFamily: "'Barlow Condensed',sans-serif", textTransform: "uppercase", letterSpacing: 0.6, fontSize: 12.5,
              padding: "8px 12px", border: "none", cursor: "pointer",
              background: viewMode === "bus" ? COL.amber : "rgba(200,225,245,0.08)",
              color: viewMode === "bus" ? COL.bg : COL.text,
              fontWeight: viewMode === "bus" ? 600 : 400,
            }}
          >
            Bus
          </button>
          <button
            onClick={() => selectViewMode("circle")}
            style={{
              fontFamily: "'Barlow Condensed',sans-serif", textTransform: "uppercase", letterSpacing: 0.6, fontSize: 12.5,
              padding: "8px 12px", border: "none", cursor: "pointer",
              background: viewMode === "circle" ? COL.amber : "rgba(200,225,245,0.08)",
              color: viewMode === "circle" ? COL.bg : COL.text,
              fontWeight: viewMode === "circle" ? 600 : 400,
            }}
          >
            Circle
          </button>
        </div>
        <button
          className={"btn" + (animating ? " btnOn" : "")}
          onClick={() => setAnimating((v) => !v)}
          style={{ position: "absolute", right: 10, bottom: 10, boxShadow: "0 2px 8px rgba(0,0,0,0.45)" }}
        >
          {animating ? "■ Stop" : "▶ Drive the turn"}
        </button>
        </div>
      </div>

      {/* common controls: steering + throttle, always visible */}
      <div style={{ padding: "0 16px" }}>
        <SectionLabel>Steering &amp; throttle</SectionLabel>
        <SteppedSlider label="Front steer input (+ = right / offside)" unit="°" value={steerInput} steps={STEER_STEPS} onChange={setSteerInput} accent={COL.front} />
        <div style={{ fontSize: 11.5, color: COL.textDim, margin: "-6px 0 10px" }}>← / → arrow keys nudge the lock — 0.15° steps near straight-ahead (±3°), 0.5° beyond that</div>
        <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap" }}>
          {[["Full lock left", -35], ["Lane change", -8], ["Straight", 0], ["Full lock right", 35]].map(([lbl, v]) => (
            <button key={lbl} className="btn" onClick={() => setSteerInput(v)}>{lbl}</button>
          ))}
        </div>
        <Slider label="Throttle (road speed)" unit=" km/h" value={speed} min={0} max={60} step={1} onChange={setSpeed} />
      </div>

      {/* title block readouts */}
      <div style={{ padding: "0 16px" }}>
        <Collapsible title="Radius grid" open={gridOpen} onToggle={() => setGridOpen((v) => !v)}>
          <div style={{ border: "1px solid rgba(200,225,245,0.16)", borderRadius: 4, overflow: "hidden", display: "grid", gridTemplateColumns: "1fr 1fr", background: COL.panel }}>
            <ReadCell label="Wheel 3 path radius (nearside)" value={geom.isStraight ? "∞" : fmt(geom.radii.w3) + " m"} accent={COL.w3} />
            <ReadCell label="Wheel 6 path radius (offside)" value={geom.isStraight ? "∞" : fmt(geom.radii.w6) + " m"} accent={COL.w6} />
            <ReadCell label="Front steer δf" value={geom.isStraight ? "0.0° straight" : fmt(Math.abs(geom.deltaFdeg)) + "° " + (geom.deltaFdeg > 0 ? "→ nearside" : "→ offside")} accent={COL.front} />
            <ReadCell label="Tag steer (applied)" value={geom.isStraight ? "0.0°" : fmt(geom.appliedDeltaT ? toDeg(geom.appliedDeltaT) : 0) + "°"} accent={COL.tag} />
            <ReadCell label="Pivot radius (drive axle)" value={geom.isStraight ? "∞" : fmt(Math.abs(geom.R)) + " m"} />
            <ReadCell label="Turning circle ⌀" value={geom.isStraight ? "∞" : fmt(geom.turningDiameter) + " m"} />
            <ReadCell label="Drive axle swept width (3↔6)" value={geom.isStraight ? "0.0 m" : fmt(geom.offTracking) + " m"} accent={COL.pathInner} />
            <ReadCell label="Tail swing radius (rear outer)" value={geom.isStraight ? "∞" : fmt(R_tailSwing_px / displayedView.scale) + " m"} accent={COL.tailSwing} />
            <ReadCell label="Tag scrub angle" value={fmt(Math.abs(geom.scrubDeg)) + "°" + (geom.tagLocked ? " (locked)" : "")} accent={Math.abs(geom.scrubDeg) > 0.4 ? COL.tag : COL.text} />
            <ReadCell label="Mowing the grass — #1" value={geom.isStraight ? "0.0 m" : fmt(geom.mow1) + " m"} accent={COL.front} />
            <ReadCell label="Mowing the grass — #2" value={geom.isStraight ? "0.0 m" : fmt(geom.mow2) + " m"} accent={COL.front} />
            <ReadCell label="Tail swing vs #7" value={geom.isStraight ? "0.0 m" : fmt(geom.tailSwing7) + " m"} accent={COL.tailSwing} />
            <ReadCell label="Tail swing vs #8" value={geom.isStraight ? "0.0 m" : fmt(geom.tailSwing8) + " m"} accent={COL.tailSwing} />
          </div>
        </Collapsible>
      </div>

      {/* everything else: collapsible advanced settings */}
      <div style={{ padding: "16px 16px 0" }}>
        <Collapsible title="Advanced settings" open={advancedOpen} onToggle={() => setAdvancedOpen((v) => !v)}>
          <SectionLabel>Tag axle behaviour</SectionLabel>
          <Slider label="Tag axle sync ratio (1 = ideal Ackermann)" unit="×" value={tagRatio} min={0} max={1.3} step={0.05} onChange={setTagRatio} accent={COL.tag} />

          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
            <span style={{ fontSize: 12.5, color: COL.textDim, textTransform: "uppercase", letterSpacing: 0.5 }}>Speed lockout above threshold</span>
            <button className={"btn" + (lockoutOn ? " btnOn" : "")} onClick={() => setLockoutOn((v) => !v)}>{lockoutOn ? "On" : "Off"}</button>
          </div>
          {lockoutOn && <Slider label="Lockout threshold" unit=" km/h" value={lockoutSpeed} min={10} max={40} step={1} onChange={setLockoutSpeed} />}

          <SectionLabel>Vehicle geometry (m)</SectionLabel>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", columnGap: 16 }}>
            <Slider label="Front–drive wheelbase" unit="m" value={Lfd} min={4} max={8} step={0.1} onChange={setLfd} />
            <Slider label="Drive–tag wheelbase" unit="m" value={Ldt} min={1.5} max={3.5} step={0.1} onChange={setLdt} />
            <Slider label="Front overhang" unit="m" value={Fo} min={1.5} max={3.5} step={0.1} onChange={setFo} />
            <Slider label="Rear overhang" unit="m" value={Ro} min={1} max={3} step={0.1} onChange={setRo} />
            <Slider label="Body width" unit="m" value={Wb} min={2.3} max={2.6} step={0.01} onChange={setWb} />
            <Slider label="Track width" unit="m" value={Tw} min={1.8} max={2.3} step={0.01} onChange={setTw} />
          </div>
          <div style={{ fontSize: 12, color: COL.textDim, marginTop: 2, marginBottom: 14 }}>
            Overall length ≈ {(Lfd + Fo + Ldt + Ro).toFixed(1)} m
          </div>

          <SectionLabel>Display</SectionLabel>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 4 }}>
            <button className={"btn" + (showBand ? " btnOn" : "")} onClick={() => setShowBand((v) => !v)}>Off-track band</button>
            <button className={"btn" + (showGeom ? " btnOn" : "")} onClick={() => setShowGeom((v) => !v)}>Construction &amp; dim lines</button>
          </div>
        </Collapsible>
      </div>

      <div style={{ padding: "0 16px", fontSize: 11.5, color: COL.textDim, lineHeight: 1.5 }}>
        Wheels numbered 1–8: 1–2 front (nearside/offside), 3–4 drive-axle nearside pair (3 leftmost/outer, 4 inner), 5–6 drive-axle offside pair (5 inner, 6 rightmost/outer), 7–8 tag axle. Model: steady-state circular turn, no tyre slip. Tag axle angle set for zero-scrub rolling at the current ratio; when locked straight (ratio 0, or above the speed lockout), the dashed ghost outline shows the ideal angle it's deviating from — the "tag scrub angle" readout is that gap. The shaded band spans from the drive axle's inner wheel (3 or 6, whichever is tighter) out to the front axle's outer wheel (2 or 1) — the corridor the vehicle actually occupies through the turn. The outer tail-swing circle (rear corner) is shown as a plain dashed reference only.
      </div>
    </div>
  );
}

function SectionLabel({ children }) {
  return (
    <div style={{ fontSize: 12, letterSpacing: 1.2, color: COL.tag, textTransform: "uppercase", margin: "6px 0 10px", borderBottom: "1px solid rgba(200,225,245,0.14)", paddingBottom: 6 }}>
      {children}
    </div>
  );
}

function Collapsible({ title, open, onToggle, children }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <button
        onClick={onToggle}
        style={{
          display: "flex", justifyContent: "space-between", alignItems: "center", width: "100%",
          background: "transparent", border: "none", borderBottom: "1px solid rgba(200,225,245,0.14)",
          padding: "8px 0", cursor: "pointer", fontFamily: "'Barlow Condensed',sans-serif",
        }}
      >
        <span style={{ fontSize: 12, letterSpacing: 1.2, color: COL.tag, textTransform: "uppercase" }}>{title}</span>
        <span style={{ color: COL.textDim, fontFamily: "'Space Mono',monospace", fontSize: 14 }}>{open ? "▾ collapse" : "▸ expand"}</span>
      </button>
      {open && <div style={{ marginTop: 10 }}>{children}</div>}
    </div>
  );
}

function LegendDot({ color, label }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <span style={{ width: 9, height: 9, borderRadius: 2, background: color, display: "inline-block" }} />
      {label}
    </span>
  );
}
