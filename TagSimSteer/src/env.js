// A minimal single-corner RL environment on top of simCore.js (physics) and
// course.js (the road + off-track check). This is the observation/reward/
// episode layer neither of those modules has — still no training algorithm,
// just the env a training loop (or a human-written controller, for
// comparison) drives.
//
// Phase 1 scope, matching the original "just steer through one corner"
// brief: speed is held fixed (coasting — see stepSim's throttle=false/
// brake=false path) and the only action is a steering target. Throttle/
// brake control is a natural follow-up, not built here.
import { createInitialState, stepSim, clampSteerDeg, wrapAngle, DEFAULT_VEHICLE, MAX_LOCK_DEG } from "./simCore.js";
import { buildCornerCourse, projectToCourse, courseFrameAtS, isOffTrack } from "./course.js";

export const DEFAULT_COURSE_OPTIONS = {
  start: { x: 0, y: 0, theta: 0 },
  entryLength: 25, exitLength: 45, radius: 25, turnDeg: 90, direction: "left", laneHalfWidth: 5,
};
export const CRUISE_SPEED_KMH = 15; // fixed speed for the steering-only task
const LOOKAHEAD_M = 10; // how far ahead the curvature observation looks
const CURVATURE_SCALE = 10; // rough scale so curvature (~0.02-0.1 for sane corners) lands near O(1), not derived
const MAX_EPISODE_SECONDS = 30;

// Reward shaping — a first pass, not tuned: reward forward progress, penalize
// lateral/heading error every step, and settle the episode with a large
// terminal bonus/penalty. All in the same units projectToCourse already
// returns (metres, radians), so retuning is just changing these weights.
const PROGRESS_WEIGHT = 1; // per metre of progress along the course
const LATERAL_WEIGHT = 0.5; // per metre of |lateral error|
const HEADING_WEIGHT = 0.2; // per radian of |heading error|
const OFFTRACK_PENALTY = -50;
const FINISH_BONUS = 50;

export const OBS_SIZE = 4;

export function createEnv(courseOptions = DEFAULT_COURSE_OPTIONS, vehicle = DEFAULT_VEHICLE) {
  return { course: buildCornerCourse(courseOptions), vehicle };
}

export function reset(env) {
  const state = { ...createInitialState(env.course.startPose), speedKmh: CRUISE_SPEED_KMH };
  return { state, t: 0, obs: observe(env, state) };
}

// [0] lateral offset / laneHalfWidth      (0 = centered, ±1 = at the lane edge)
// [1] heading error / (pi/2), wrapped     (0 = aligned with the road)
// [2] current applied steer angle / MAX_LOCK_DEG
// [3] road curvature LOOKAHEAD_M ahead, scaled — signed, 0 on a straight
export function observe(env, state) {
  const { course } = env;
  const proj = projectToCourse(course, state.pose);
  const headingError = wrapAngle(state.pose.theta - proj.heading);
  const ahead = courseFrameAtS(course, proj.s + LOOKAHEAD_M);
  return [
    proj.lateral / course.laneHalfWidth,
    headingError / (Math.PI / 2),
    state.appliedSteerDeg / MAX_LOCK_DEG,
    ahead.curvature * CURVATURE_SCALE,
  ];
}

// action: { steerTargetDeg }. Returns { state, t, obs, reward, done, info }.
export function step(env, envState, action, dt) {
  const { course, vehicle } = env;
  const prevProj = projectToCourse(course, envState.state.pose);

  const state = stepSim(envState.state, vehicle, { steerTargetDeg: clampSteerDeg(action.steerTargetDeg ?? 0), throttle: false, brake: false }, dt);
  const t = envState.t + dt;

  const proj = projectToCourse(course, state.pose);
  const headingError = wrapAngle(state.pose.theta - proj.heading);
  const offTrack = isOffTrack(course, state);
  const finished = proj.s >= course.totalLength - 0.5;
  const timedOut = t >= MAX_EPISODE_SECONDS;
  const done = offTrack || finished || timedOut;

  // Progress is already a distance (metres covered this step), so it doesn't need a dt factor —
  // but the lateral/heading penalties are instantaneous error magnitudes, and without scaling them
  // by dt they'd accumulate at whatever rate the caller happens to step at (60/s vs 30/s would score
  // the same trajectory completely differently). Scaling everything to "per simulated second" keeps
  // the reward's meaning independent of step rate.
  let reward = PROGRESS_WEIGHT * (proj.s - prevProj.s) - (LATERAL_WEIGHT * Math.abs(proj.lateral) + HEADING_WEIGHT * Math.abs(headingError)) * dt;
  if (offTrack) reward += OFFTRACK_PENALTY;
  if (finished) reward += FINISH_BONUS;

  return { state, t, obs: observe(env, state), reward, done, info: { offTrack, finished, timedOut, lateral: proj.lateral, s: proj.s } };
}
