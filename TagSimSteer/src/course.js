// A single-corner course (straight -> constant-radius arc -> straight) and
// the off-track check the ML env uses as its failure signal, instead of the
// component's boundary auto-steer (see the design note in simCore.js — that
// feature exists to rescue a human driver and would defeat the point of
// letting a policy learn steering from consequences).
//
// Coordinate/sign conventions match simCore.js throughout: world frame is
// plain (x,y,theta) with theta increasing CCW, and "left" is positive —
// same as the vehicle's own chassis-local y-axis and its R sign (positive R
// = left turn). The arc's turn centre is placed the same way computeGeometry
// places the vehicle's own turn centre: at local (0, signedRadius) relative
// to the pose where the arc begins.
import { poseTransform, worldEnvelopePoints, wrapAngle, toRad } from "./simCore.js";

// start: {x,y,theta} — pose where the course begins.
// entryLength/exitLength: metres of straight road before/after the corner.
// radius: corner radius, metres (magnitude).
// turnDeg: heading change through the corner, degrees (magnitude).
// direction: "left" (CCW, theta increases) or "right" (CW, theta decreases).
// laneHalfWidth: metres from centerline to each edge.
export function buildCornerCourse({
  start = { x: 0, y: 0, theta: 0 },
  entryLength = 40,
  exitLength = 40,
  radius = 25,
  turnDeg = 90,
  direction = "left",
  laneHalfWidth = 3.5,
} = {}) {
  const dir = direction === "left" ? 1 : -1;
  const signedRadius = dir * radius;
  const turnRad = toRad(Math.abs(turnDeg));

  const theta0 = start.theta;
  const entryEnd = { x: start.x + entryLength * Math.cos(theta0), y: start.y + entryLength * Math.sin(theta0) };
  const entry = { type: "straight", start: { x: start.x, y: start.y }, theta: theta0, length: entryLength };

  const center = poseTransform({ x: 0, y: signedRadius }, { x: entryEnd.x, y: entryEnd.y, theta: theta0 });
  const startAngle = Math.atan2(entryEnd.y - center.y, entryEnd.x - center.x);
  const arcLength = radius * turnRad;
  const arc = { type: "arc", center, radius, dir, startAngle, arcLength };

  const endAngle = startAngle + dir * turnRad;
  const arcEnd = { x: center.x + radius * Math.cos(endAngle), y: center.y + radius * Math.sin(endAngle) };
  const theta1 = theta0 + dir * turnRad;
  const exit = { type: "straight", start: { x: arcEnd.x, y: arcEnd.y }, theta: theta1, length: exitLength };

  const totalLength = entryLength + arcLength + exitLength;
  const endPose = { x: arcEnd.x + exitLength * Math.cos(theta1), y: arcEnd.y + exitLength * Math.sin(theta1), theta: theta1 };

  return { segments: [entry, arc, exit], totalLength, laneHalfWidth, startPose: { ...start }, endPose };
}

// Project world point P onto a straight segment: sLocal/lateral in the
// segment's own local frame (x=along, y=left, same convention as chassis-
// local elsewhere), sClamped/dist for picking the nearest segment, heading
// of the road itself at the closest point (constant along a straight).
function projectStraight(seg, P) {
  const dx = P.x - seg.start.x, dy = P.y - seg.start.y;
  const c = Math.cos(seg.theta), s = Math.sin(seg.theta);
  const sLocal = dx * c + dy * s;
  const lateral = -dx * s + dy * c;
  const sClamped = Math.min(Math.max(sLocal, 0), seg.length);
  const closest = { x: seg.start.x + sClamped * c, y: seg.start.y + sClamped * s };
  return { lateral, sClamped, dist: Math.hypot(P.x - closest.x, P.y - closest.y), heading: seg.theta };
}

function projectArc(seg, P) {
  const { center, radius, dir, startAngle, arcLength } = seg;
  const vx = P.x - center.x, vy = P.y - center.y;
  const dist = Math.hypot(vx, vy);
  const angleP = Math.atan2(vy, vx);
  // Signed progress angle in the direction of travel (positive whichever way
  // dir turns), so it's directly comparable to arcLength regardless of dir.
  const sLocal = dir * wrapAngle(angleP - startAngle) * radius;
  const lateral = dir * (radius - dist); // 0 on the centerline, negative if drifted right, positive left
  const sClamped = Math.min(Math.max(sLocal, 0), arcLength);
  const angleClamped = startAngle + dir * (sClamped / radius);
  const closest = { x: center.x + radius * Math.cos(angleClamped), y: center.y + radius * Math.sin(angleClamped) };
  // Tangent direction of travel: leads the radius vector by +90° for a CCW
  // (dir=+1) arc, trails it by 90° for CW — see courseFrameAtS for the same
  // relationship derived the other way (course-progress -> world).
  const heading = angleClamped + dir * (Math.PI / 2);
  return { lateral, sClamped, dist: Math.hypot(P.x - closest.x, P.y - closest.y), heading };
}

// Closest-segment projection of a world point onto the course: signed
// lateral offset from centerline (metres, +left), progress along the course
// (metres from the start), and the road's own heading at that point (for a
// heading-error observation). Brute-forces all 3 segments — cheap at this
// segment count, and simple to extend if the course ever grows one.
export function projectToCourse(course, P) {
  let best = null;
  let cumulative = 0;
  for (const seg of course.segments) {
    const r = seg.type === "straight" ? projectStraight(seg, P) : projectArc(seg, P);
    if (best === null || r.dist < best.dist) best = { lateral: r.lateral, s: cumulative + r.sClamped, dist: r.dist, heading: r.heading };
    cumulative += seg.type === "straight" ? seg.length : seg.arcLength;
  }
  return best;
}

// The inverse query: given progress `s` along the course (clamped to
// [0, totalLength]), return the road's own {point, heading, curvature}
// there — signed curvature is 0 on the straights and dir/radius on the arc.
// Used for a lookahead observation (see src/env.js) so a policy can see the
// corner coming rather than only reacting to lateral error once already in it.
export function courseFrameAtS(course, s) {
  let remaining = Math.max(0, Math.min(s, course.totalLength));
  const segments = course.segments;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const segLength = seg.type === "straight" ? seg.length : seg.arcLength;
    const isLast = i === segments.length - 1;
    if (remaining <= segLength || isLast) {
      const local = Math.min(remaining, segLength);
      if (seg.type === "straight") {
        const point = poseTransform({ x: local, y: 0 }, { x: seg.start.x, y: seg.start.y, theta: seg.theta });
        return { point, heading: seg.theta, curvature: 0 };
      }
      const angle = seg.startAngle + seg.dir * (local / seg.radius);
      const point = { x: seg.center.x + seg.radius * Math.cos(angle), y: seg.center.y + seg.radius * Math.sin(angle) };
      return { point, heading: angle + seg.dir * (Math.PI / 2), curvature: seg.dir / seg.radius };
    }
    remaining -= segLength;
  }
}

// True if any of the bus's body corners have crossed the lane edge — the
// episode-ending failure signal for the ML env, replacing the auto-steer
// assist. `state` is a stepSim() result (needs .pose and .geom).
export function isOffTrack(course, state) {
  const points = worldEnvelopePoints(state.pose, state.geom);
  return points.some((p) => Math.abs(projectToCourse(course, p).lateral) > course.laneHalfWidth);
}
