import React, { useState, useEffect, useRef, useMemo } from "react";
import busDimensionsPhoto from "./bcc-tag-bus-5054.png";

// ---------- constants ----------
// VB is the height of the SVG's abstract coordinate space, always 1000 units — it's the reference
// every tuned scale constant below (VB/3, VB/2-MARGIN) was chosen against. The width side of that
// space (vb.w below) is not fixed: it's recomputed every render from the map wrapper's actual pixel
// aspect ratio, so the viewBox always matches the wrapper's on-screen rectangle exactly and the
// square content never letterboxes or stretches — see `vbSize` in the component body.
const VB = 1000;
const MARGIN = 60;
const MIN_ZOOM = 0.4;
const MAX_ZOOM = 6;

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

function computeView(geom, pose, viewMode, vb) {
  if (viewMode === "bus") {
    // Fixed scale: the vehicle's own length occupies a bit over half the map's shorter side,
    // regardless of steering — camera just follows the bus.
    const vehicleLength = geom.Lfd + geom.Fo + geom.Ldt + geom.Ro;
    const scale = ((vb.min / 3) / vehicleLength) * 1.7;
    return { scale, originX: vb.w / 2 + pose.y * scale, originY: vb.h / 2 + pose.x * scale };
  }
  let center, fitExtent;
  if (geom.isStraight) {
    center = { x: pose.x, y: pose.y };
    fitExtent = geom.straightHalfExtent;
  } else {
    center = poseTransform(geom.C, pose); // turn centre stays centred, in current world position
    fitExtent = geom.outerRadius * 1.05; // fit the whole swept circle, no clipping
  }
  const scale = (vb.min / 2 - MARGIN) / fitExtent;
  return { scale, originX: vb.w / 2 + center.y * scale, originY: vb.h / 2 + center.x * scale };
}

function toScreen(view, p) {
  return { x: view.originX - p.y * view.scale, y: view.originY - p.x * view.scale };
}

function longLineScreen(yOffset, pose, view) {
  const p1 = toScreen(view, poseTransform({ x: 1000, y: yOffset }, pose));
  const p2 = toScreen(view, poseTransform({ x: -1000, y: yOffset }, pose));
  return { p1, p2 };
}

// An SVG arc path for a circle of radius r about (cx, cy), starting at world-frame angle a0 and
// sweeping by worldDelta radians (i.e. ending at world angle a0 + worldDelta). toScreen's world→
// screen map is linear and orientation-reversing (a reflection, not a pure rotation — see
// `toScreen`), which flips the sign of any angular delta but preserves its magnitude exactly, so
// the screen-space sweep is simply -worldDelta with no wrap-around ambiguity to resolve. Used to
// draw the swept-path reference circles as a "next 50m" arc instead of a full circle in trail mode
// (see TRAIL_PREVIEW_LENGTH) — capped just under a full turn since a single SVG arc command can't
// represent more than that (relevant at very tight lock, where 50m of travel can exceed 360°).
function arcPathFromWorldSweep(cx, cy, r, a0, worldDelta) {
  const MAX_SWEEP = 2 * Math.PI * 0.999;
  const screenDelta = Math.max(-MAX_SWEEP, Math.min(MAX_SWEEP, -worldDelta));
  const a1 = a0 + screenDelta;
  const x0 = cx + r * Math.cos(a0), y0 = cy + r * Math.sin(a0);
  const x1 = cx + r * Math.cos(a1), y1 = cy + r * Math.sin(a1);
  const largeArc = Math.abs(screenDelta) > Math.PI ? 1 : 0;
  const sweep = screenDelta > 0 ? 1 : 0;
  return `M ${x0} ${y0} A ${r} ${r} 0 ${largeArc} ${sweep} ${x1} ${y1}`;
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

// ---------- trail display mode ----------
// Local (chassis-frame) half-width of the swept corridor, same simplification the existing
// straight-case off-tracking band already uses (see `bandHalfY` in the render body): the wider of
// the hero-wheel offset and the front wheel's own footprint, applied symmetrically on both sides
// regardless of which side actually reaches it. Depends only on track width, not steering angle,
// so unlike the live turning-case band it doesn't widen further on tight lock — an accepted
// simplification for a first pass (see docs/trail-display-mode.md).
function bandHalfWidth(Tw) {
  const halfT = Tw / 2;
  return Math.max(halfT + DUAL_GAP / 2, halfT + WHEEL_HALF_W);
}
// Front/tag axle local half-width — same `halfT + WHEEL_HALF_W` term as above, without the dual
// term since neither the front nor the tag axle is a dual pair. Sampled at that axle's own
// along-chassis offset (x = Lfd or x = -Ldt), not x = 0, so each band traces where that axle
// itself has actually been — distinct from the drive-axle band above, which is why they diverge
// once the bus turns (the front axle cuts the corner ahead of where the drive axle tracks, the tag
// axle tracks inboard of it — the same effect as the "mowing the grass" / tail-swing readouts).
function singleAxleBandHalfWidth(Tw) {
  return Tw / 2 + WHEEL_HALF_W;
}
const TRAIL_MIN_SPACING = 0.2; // metres between recorded trail samples
const TRAIL_MIN_SPACING_SQ = TRAIL_MIN_SPACING * TRAIL_MIN_SPACING;
const TRAIL_RENDER_EVERY = 5; // force a re-render every N recorded samples, not every one
const TRAIL_BOUND_HALF = 500; // metres — recording area capped to a 1000x1000m (1km²) square centred on the origin
const TRAIL_PREVIEW_LENGTH = 50; // metres ahead of the bus the dashed centreline preview projects
const TRAIL_PREVIEW_STEPS = 40; // segments across that length — plenty smooth even at full-lock radii
const TRAIL_PREVIEW_FRONT_LENGTH = 25; // metres ahead the (shorter, dotted) front wheel track preview projects
const TRAIL_PREVIEW_FRONT_STEPS = 20;

// Closed-form projection of pose forward by arc length `s`, holding the current curvature (or
// straight heading) constant — derived by solving the same unicycle model the drive loop
// integrates each frame (theta' = v/R, x' = v cos(theta), y' = v sin(theta)) in closed form for
// constant R instead of stepping it. Used only for the forward trail *preview*, recomputed fresh
// every render from the live pose/geom — never for the driven pose itself. Re-deriving the actual
// driven position this way (rotation about the turn centre) was tried and reverted (see main
// CLAUDE.md): the turn centre moves with every steering input, which broke continuity. That
// problem doesn't apply here since the preview is a disposable, from-scratch projection of "if you
// held this" rather than a persisted position.
function projectPosesForward(pose, geom, arcLength, steps) {
  const poses = [];
  for (let i = 0; i <= steps; i++) {
    const s = (arcLength * i) / steps;
    if (geom.isStraight) {
      poses.push({ x: pose.x + s * Math.cos(pose.theta), y: pose.y + s * Math.sin(pose.theta), theta: pose.theta });
    } else {
      const theta = pose.theta + s / geom.R;
      poses.push({
        x: pose.x + geom.R * (Math.sin(theta) - Math.sin(pose.theta)),
        y: pose.y - geom.R * (Math.cos(theta) - Math.cos(pose.theta)),
        theta,
      });
    }
  }
  return poses;
}

// ---------- driver marker icon (supplied artwork: "bcc bus driver head.svg") ----------
const DRIVER_ICON_VB_W = 1087, DRIVER_ICON_VB_H = 1039;
const DRIVER_ICON_HEAD_D = "M0 0 C1.19592366 -0.00429709 2.39184733 -0.00859419 3.6240111 -0.0130215 C4.97087592 -0.01276704 6.31774072 -0.01241991 7.6646055 -0.01199049 C9.08598057 -0.01515359 10.50735472 -0.01875211 11.92872769 -0.02274993 C15.87061305 -0.03253162 19.81248337 -0.03599055 23.75437918 -0.03847325 C28.02929697 -0.04222771 32.30420271 -0.05167409 36.57911277 -0.06037748 C45.0741247 -0.07672482 53.56913577 -0.08754194 62.0641582 -0.09665609 C69.12946996 -0.10439081 76.1947752 -0.11446119 83.26008165 -0.12605089 C84.27778045 -0.12771897 85.29547925 -0.12938704 86.34401741 -0.13110567 C88.41938924 -0.13451442 90.49476106 -0.13792595 92.57013288 -0.14134019 C120.65517192 -0.18706193 148.74022482 -0.21749533 176.82528627 -0.24550241 C178.54945381 -0.2472349 178.54945381 -0.2472349 180.30845302 -0.24900238 C225.78445815 -0.29468779 271.26046895 -0.33434188 316.73648943 -0.36102732 C328.00778772 -0.3676512 339.27908585 -0.37452457 350.55038393 -0.38148874 C351.79588453 -0.38225193 353.04138514 -0.38301511 354.32462819 -0.38380143 C394.71957788 -0.40875256 435.1144247 -0.46224141 475.50932087 -0.531507 C517.01215139 -0.60254311 558.51492656 -0.6476777 600.01781857 -0.65900809 C605.87562177 -0.66061309 611.73342484 -0.66250069 617.59122789 -0.66455263 C619.32062145 -0.66514195 619.32062145 -0.66514195 621.08495225 -0.66574319 C639.66629646 -0.67281093 658.24749646 -0.70705655 676.82878538 -0.75121364 C695.49483841 -0.79495287 714.16073365 -0.80951793 732.8268332 -0.79412038 C743.92561683 -0.78584185 755.02385123 -0.79997972 766.122546 -0.84583971 C773.52955959 -0.8742572 780.93620262 -0.87380891 788.34323028 -0.84957484 C792.5683351 -0.83658384 796.79239259 -0.83642471 801.01739629 -0.8713404 C804.85964748 -0.90284428 808.70001842 -0.89766908 812.54222601 -0.8629573 C814.57848419 -0.85409551 816.61479679 -0.88460004 818.65082294 -0.91659108 C827.3144964 -0.7861323 827.3144964 -0.7861323 830.84407942 1.87041713 C832.61588076 3.87497416 834.07450014 5.89747768 835.53622377 8.13340384 C836.4620062 9.19479083 837.40898668 10.23820801 838.37997377 11.25840384 C842.87235249 16.12074316 847.32533513 21.0054554 851.66122377 26.00840384 C854.08172452 28.75163802 856.55823019 31.44224952 859.03622377 34.13340384 C862.63635133 38.04321979 866.18039982 41.99206852 869.66122377 46.00840384 C872.08172452 48.75163802 874.55823019 51.44224952 877.03622377 54.13340384 C880.63635133 58.04321979 884.18039982 61.99206852 887.66122377 66.00840384 C890.08172452 68.75163802 892.55823019 71.44224952 895.03622377 74.13340384 C898.63635133 78.04321979 902.18039982 81.99206852 905.66122377 86.00840384 C908.08172452 88.75163802 910.55823019 91.44224952 913.03622377 94.13340384 C916.63635133 98.04321979 920.18039982 101.99206852 923.66122377 106.00840384 C926.08172452 108.75163802 928.55823019 111.44224952 931.03622377 114.13340384 C934.63635133 118.04321979 938.18039982 121.99206852 941.66122377 126.00840384 C944.08172452 128.75163802 946.55823019 131.44224952 949.03622377 134.13340384 C952.07510395 137.43369306 955.09778422 140.74289667 958.03622377 144.13340384 C961.39945015 148.01157397 964.86958048 151.78868195 968.34432924 155.56650931 C972.77846005 160.38925275 977.16140617 165.25681504 981.53622377 170.13340384 C983.03593505 171.80033031 984.53593698 173.46699533 986.03622377 175.13340384 C986.76712221 175.9493804 987.49802064 176.76535696 988.25106752 177.60606009 C989.85300792 179.37777879 991.47172518 181.13440458 993.10263002 182.87949759 C993.92634096 183.76766165 994.75005189 184.65582571 995.59872377 185.57090384 C996.72987611 186.77553274 996.72987611 186.77553274 997.88388002 188.00449759 C999.53622377 190.13340384 999.53622377 190.13340384 999.53622377 193.13340384 C949.04622377 193.13340384 898.55622377 193.13340384 846.53622377 193.13340384 C845.21622377 199.40340384 843.89622377 205.67340384 842.53622377 212.13340384 C841.64479082 216.24366914 840.74929953 220.35206035 839.83700502 224.45762259 C839.60087495 225.52058554 839.36474489 226.58354849 839.12145936 227.67872244 C829.36444525 271.44412012 818.04420807 314.16183316 799.53622377 355.13340384 C799.09310853 356.11599173 798.6499933 357.09857962 798.19345033 358.1109429 C780.9217158 396.04820056 758.24239463 431.1821585 731.53622377 463.13340384 C731.10648256 463.64951224 730.67674135 464.16562063 730.23397768 464.69736868 C717.32812445 480.15024764 703.55057981 494.71320478 688.53622377 508.13340384 C687.96194643 508.64709524 687.38766908 509.16078665 686.79598939 509.69004446 C666.99745626 527.27619875 645.35544135 542.73172358 622.53622377 556.13340384 C621.88895326 556.51561087 621.24168275 556.8978179 620.57479799 557.29160696 C584.1318041 578.68759716 544.77788202 593.97608338 503.53622377 603.13340384 C502.54042299 603.35480032 501.54462221 603.57619681 500.51864564 603.80430228 C487.09168996 606.72190177 473.60970393 608.77121069 459.97372377 610.38340384 C459.27700563 610.46648794 458.58028749 610.54957205 457.86245668 610.63517386 C440.84677056 612.63728567 423.91398663 613.34437037 406.78622377 613.32090384 C405.44545778 613.31949896 405.44545778 613.31949896 404.07760561 613.3180657 C355.61534724 613.20886801 307.5393415 606.67714521 261.53622377 591.13340384 C260.59665834 590.81790579 259.65709291 590.50240774 258.6890558 590.17734915 C216.56925512 575.86803471 177.71003065 554.29599822 143.10018861 526.39316946 C141.63263592 525.21106333 140.15696615 524.03905443 138.68075502 522.86777884 C131.89226808 517.42131601 125.52177019 511.59511473 119.17245424 505.65195853 C117.55826118 504.15385634 115.9281468 502.67570116 114.29013002 501.20371634 C109.26560018 496.68179461 104.45469919 492.14083235 100.10263002 486.94981009 C98.53680461 485.13407738 96.88720257 483.4839768 95.16122377 481.82090384 C91.42849842 478.14637243 88.1823545 474.13854376 84.90341127 470.05918509 C82.59724981 467.20883041 80.22828281 464.4225591 77.84872377 461.63340384 C60.67350029 441.0072081 45.96729134 418.33208634 32.53622377 395.13340384 C32.10889955 394.39589895 31.68157533 393.65839407 31.24130189 392.89854056 C-0.95871908 336.95037619 -21.25365146 275.25369209 -28.46377623 211.13340384 C-28.63949156 209.65299612 -28.63949156 209.65299612 -28.8187567 208.14268118 C-36.63051565 139.85653272 -27.52777785 66.41924585 -6.46377623 1.13340384 C-4.72738871 -0.60298368 -2.36442651 0.00371838 0 0 Z";
const DRIVER_ICON_CAP_D = "M0 0 C318.45 0 636.9 0 965 0 C963.8750129 10.12488389 963.8750129 10.12488389 963.18344116 13.52584839 C963.02708159 14.30473262 962.87072203 15.08361685 962.70962429 15.88610363 C962.45576505 17.11979923 962.45576505 17.11979923 962.19677734 18.37841797 C962.01558633 19.27518659 961.83439531 20.1719552 961.64771366 21.09589863 C961.04746875 24.06208783 960.44167968 27.02711648 959.8359375 29.9921875 C959.40718536 32.10615123 958.97881365 34.22019214 958.55079651 36.33430481 C957.40169398 42.00549356 956.24797962 47.67573462 955.09330368 53.34579086 C953.162447 62.83258207 951.2395419 72.3209912 949.31545067 81.80915642 C948.83068951 84.19924285 948.34575557 86.58929424 947.86065102 88.97931099 C944.76839719 104.21489658 941.70344641 119.45538322 938.69140625 134.70703125 C929.52621397 181.08933298 919.86326389 227.2903774 907.86328125 273.0390625 C907.68785797 273.70807587 907.51243469 274.37708923 907.33169556 275.06637573 C906.62358314 277.7422452 905.87567811 280.37296567 905 283 C624.5 283 344 283 55 283 C53.53652273 278.60956818 52.43889291 274.67333919 51.55187988 270.177948 C51.41996618 269.51504511 51.28805248 268.85214222 51.15214139 268.16915137 C50.71294093 265.95707356 50.27932809 263.74393867 49.84570312 261.53076172 C49.52981131 259.93364008 49.21357725 258.33658611 48.89702892 256.73959446 C48.03484836 252.38466367 47.17754516 248.02878522 46.32108474 243.67272639 C45.41021603 239.04436867 44.49484643 234.4169011 43.58003235 229.7893219 C41.8208418 220.88656843 40.06586697 211.98298931 38.31263107 203.07906145 C36.90686828 195.93994166 35.49984676 188.80107114 34.09188843 181.66238403 C33.89324261 180.65518049 33.69459679 179.64797695 33.4899314 178.61025208 C33.08892854 176.57703972 32.68792369 174.54382776 32.28691685 172.51061618 C29.70766717 159.43254969 27.12957551 146.35425582 24.55461121 133.27534485 C24.36253006 132.29972861 24.17044891 131.32411237 23.97254711 130.318932 C23.78200046 129.35110808 23.59145381 128.38328416 23.39513302 127.38613224 C19.96589989 109.96851388 16.52916438 92.5524299 13.07730103 75.13928223 C11.55161789 67.44257703 10.03080408 59.74491444 8.51250648 52.04674911 C7.57702422 47.3044332 6.63921208 42.56260883 5.6953125 37.82196045 C4.84362035 33.54388471 3.99878401 29.26451834 3.15981102 24.98393059 C2.8652937 23.48764237 2.56824975 21.99184851 2.26827431 20.49664497 C1.87082513 18.51404614 1.48359925 16.52940596 1.09692383 14.54467773 C0.88272293 13.46194077 0.66852203 12.3792038 0.4478302 11.26365662 C0 8 0 8 0 0 Z";

// ---------- steering wheel icon (supplied artwork: "steering wheel-2.svg") ----------
// The source file was an unoptimized per-pixel raster trace (7000+ tiny <path> elements,
// 1MB+) rather than real vector art, so it's rasterized once to a PNG data URI here instead
// of inlined as SVG markup -- same visual result, without bloating this file with pixel paths.
const STEERING_WHEEL_VB_W = 454, STEERING_WHEEL_VB_H = 470;
const STEERING_WHEEL_IMG = "data:image/png;base64,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UvPNYhTmmbiGA4YDvhy47LLLarfssqW97ba9RNOmzUSDBg2FEL7RfQOCZBpy9WefQzhkCDi6Tar4aa0RcyrppfwTM2fOFJ999pn49NNPSVoRVLLA+LFkMpu7gBYqez65HRV0GzRoIDhavd9++wq5H2BMqPnsHJO34UAVcuCGG25INmzYUJpUG4vVq3+MxQHkGvLTLzHA5hfm5+/UGnUctMYvvvhCYOHTfuXu1ivFBowfPz5V06yZBSCyMuHwTb7qycAJWlm5y6U+NTUtxOLFi8XChQttOYCNCdXNJPNuOGA4kDUH9tlnL3vnnXdWp1SRgV6glKmQINkWRmt05+/UGrU5Fa2xRYsWYq+99rLuuOOOijiEk29gdPM11PuHH34o+ESD01WsekIlihkpav716tUXPXv2FIceepjYYostjbYYk+8mmeGA4UAwB6666qrarbbayt5+++0Fv9bjNm0Gp14XinxDjq572/hvkNYICHqVqQG6Xr16gvR80/jNN98ItEbuUd24lPLzKUlg/OqrrzjQknduRtUWGRBbbrml+jxDrpLs664zn2fkvZNMAYYDVcyBG2+8MdmkSRP14T8gBxhFZQfpgsAxKD/A0R2On95rJIz8saCx1wjhV+5UcsA4+o7Rqbbt2lo/YldPCLUiKQUmMxA226wxh20kaC+1b755RPUduCmFjjB1MByoMg707t3b7t69e6zr4jSrAC8UAf2u3TDm1ExaI3mtWLFCYE7dc889K+ImnJIDxg+nfii++WaOWLVypfj5p5/ged6IwRI2c1ZJmDSOP/540a/frsaEGpZxJp7hgOFAVhz405/+VNuqVStbkrr9q379+rHy89tvBNQwifpliuxzh+HHGRDS4pL3vHnzlDkVk6o7frm9lxwwYkb98YfV6l7Un39ekzd+snqiM8MUUK9efbHVVt3U7ffLl6+w//znG8yBmzCMM3FKmQOmbmXEgV//+tf2HnvsIZo1a6bAkW2dqNVHEUDueaX7OeKnG+TB4RtciMNB3333ndIa99tvP2vChAllfQinpIBR2tNTHTt2tOT+nex874tu6YRcEIMkTD50fosWNepHOletWmmPHj3KmFDDMM7EMRwwHMgZB0466aTa9u3b2z169BB8UM8dzXEy91MGVq1aFbhthYboLq9hw4bqvAUuYRzC4dAkGmO5H8IpKWDkNCrf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";
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
  for (let i = -100; i <= -7; i++) vals.push(i * 0.5); // -50.0 to -3.5, 0.5° steps
  for (let i = -20; i <= 20; i++) vals.push(Math.round(i * 15) / 100); // -3.0 to 3.0, 0.15° steps
  for (let i = 7; i <= 100; i++) vals.push(i * 0.5); // 3.5 to 50.0, 0.5° steps
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
  trail: "#4fd1c5",
  text: "#eaf2f8", textDim: "#7d99b0", amber: "#ffb937",
};

function Slider({ label, unit, value, min, max, step, onChange, accent = COL.amber }) {
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}>
        <span style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 15, letterSpacing: 0.5, color: COL.textDim, textTransform: "uppercase" }}>{label}</span>
        <span style={{ fontFamily: "'Space Mono', monospace", fontSize: 15, color: COL.text }}>{value.toFixed(step < 1 ? 2 : 0)}{unit}</span>
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
    <div style={{ marginBottom: 8 }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}>
        <span style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 15, letterSpacing: 0.5, color: COL.textDim, textTransform: "uppercase" }}>{label}</span>
        <span style={{ fontFamily: "'Space Mono', monospace", fontSize: 15, color: COL.text }}>{value % 1 === 0 ? value.toFixed(0) : value.toFixed(2)}{unit}</span>
      </div>
      <input
        type="range" min={0} max={steps.length - 1} step={1} value={index}
        onChange={(e) => onChange(steps[parseInt(e.target.value, 10)])}
        style={{ width: "100%", accentColor: accent, height: 4 }}
      />
    </div>
  );
}

// Rotates to visualise the steering slider's angle. Ratio reflects the real steering
// box: ~4 turns lock-to-lock over the ±50° front steer range, i.e. 1440° of wheel
// rotation across 100° of road-wheel angle = 14.4:1.
const STEERING_WHEEL_RATIO = 14.4;
function SteeringWheel({ angleDeg, size = 216 }) {
  return (
    <div style={{ display: "flex", justifyContent: "center", marginBottom: 8 }}>
      <img
        src={STEERING_WHEEL_IMG} alt=""
        width={size} height={size * (STEERING_WHEEL_VB_H / STEERING_WHEEL_VB_W)}
        style={{ display: "block", transform: `rotate(${angleDeg * STEERING_WHEEL_RATIO}deg)`, transition: "transform 0.06s linear" }}
      />
    </div>
  );
}

function VerticalSlider({ label, unit, value, min, max, step, onChange, accent = COL.amber, trackLength = 168 }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", width: 76 }}>
      <span style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 15, letterSpacing: 0.5, color: COL.textDim, textTransform: "uppercase", textAlign: "center" }}>{label}</span>
      <div style={{ position: "relative", width: 40, height: trackLength, margin: "6px 0" }}>
        <input
          type="range" min={min} max={max} step={step} value={value}
          onChange={(e) => onChange(parseFloat(e.target.value))}
          style={{ position: "absolute", top: "50%", left: "50%", width: trackLength, height: 4, transform: "translate(-50%, -50%) rotate(-90deg)", accentColor: accent }}
        />
      </div>
      <span style={{ fontFamily: "'Space Mono', monospace", fontSize: 15, color: COL.text }}>{value.toFixed(step < 1 ? 2 : 0)}{unit}</span>
    </div>
  );
}

function ReadCell({ label, value, accent }) {
  return (
    <div style={{ padding: "6px 10px", borderRight: `1px solid rgba(200,225,245,0.10)`, borderBottom: `1px solid rgba(200,225,245,0.10)` }}>
      <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 14, letterSpacing: 0.6, color: COL.textDim, textTransform: "uppercase" }}>{label}</div>
      <div style={{ fontFamily: "'Space Mono', monospace", fontSize: 18, color: accent || COL.text, marginTop: 2 }}>{value}</div>
    </div>
  );
}

// ---------- main component ----------
export default function BusSteeringSimulator() {
  const [Lfd, setLfd] = useState(7.0);
  const [Ldt, setLdt] = useState(1.4);
  const [Fo, setFo] = useState(2.75);
  const [Ro, setRo] = useState(3.35);
  const [Wb, setWb] = useState(2.48);
  const [Tw, setTw] = useState(2.1);
  // steerInput: positive = steer right (offside), negative = steer left (nearside) — reversed vs. the raw geometry angle
  const [steerInput, setSteerInput] = useState(0);
  const deltaFdeg = -steerInput;
  const [tagRatio, setTagRatio] = useState(1.0);
  const [lockoutOn, setLockoutOn] = useState(true);
  const [lockoutSpeed, setLockoutSpeed] = useState(25);
  const [speed, setSpeed] = useState(0);
  const [showBand, setShowBand] = useState(false);
  // "Driving" is just speed > 0 — not independent state — so dragging the throttle slider
  // itself starts/stops the animation and keeps the Drive/Stop button in sync, not only the button.
  const animating = speed > 0;
  const [showGeom, setShowGeom] = useState(false);
  const [showDims, setShowDims] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [viewMode, setViewMode] = useState("bus");

  // Map sizing: the map wrapper's height is pinned to the side panel's own rendered height (so the
  // two columns line up exactly), and its width just follows normal flex layout (100% of whatever
  // space is left beside the side panel). Both are measured via ResizeObserver rather than computed
  // from window size directly, since the side panel's height depends on its own content (the bus
  // photo's aspect ratio, wrapped text, etc.), not just viewport size.
  const sidePanelRef = useRef(null);
  const mapWrapperRef = useRef(null);
  const [sidePanelHeight, setSidePanelHeight] = useState(0);
  const [mapWrapperWidth, setMapWrapperWidth] = useState(0);
  useEffect(() => {
    const sideEl = sidePanelRef.current, mapEl = mapWrapperRef.current;
    if (!sideEl || !mapEl) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        // offsetHeight/offsetWidth (border-box) rather than entry.contentRect (content-box) — the
        // side panel has its own padding+border, and we want the map wrapper's *outer* box to line
        // up with the side panel's *outer* box, not its inner content area.
        if (entry.target === sideEl) setSidePanelHeight(sideEl.offsetHeight);
        else if (entry.target === mapEl) setMapWrapperWidth(mapEl.offsetWidth);
      }
    });
    ro.observe(sideEl);
    ro.observe(mapEl);
    return () => ro.disconnect();
  }, []);
  // Abstract viewBox size: height fixed at VB (every tuned scale constant assumes it), width scaled
  // to match the wrapper's actual on-screen aspect ratio so the square coordinate space always fills
  // its rectangle exactly, however wide or narrow that rectangle ends up being.
  const vbSize = useMemo(() => {
    const w = sidePanelHeight > 0 && mapWrapperWidth > 0 ? Math.round((VB * mapWrapperWidth) / sidePanelHeight) : VB;
    return { w, h: VB, min: Math.min(w, VB) };
  }, [sidePanelHeight, mapWrapperWidth]);

  // Mouse-wheel zoom on the map. Registered as a native listener (not React's onWheel) because
  // React attaches wheel handlers passively — calling preventDefault() from a JSX onWheel prop is a
  // no-op (and logs a warning) in modern React, and without it the page itself scrolls while the
  // user is trying to zoom the map.
  const [zoom, setZoom] = useState(1);
  useEffect(() => {
    const el = mapWrapperRef.current;
    if (!el) return;
    function onWheel(e) {
      e.preventDefault();
      const factor = Math.exp(-e.deltaY * 0.0015);
      setZoom((z) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z * factor)));
    }
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // Trail display mode: paints the corridor the vehicle has actually driven, rather than just the
  // instantaneous turning circle. See docs/trail-display-mode.md for the design.
  const [trailMode, setTrailMode] = useState(true);
  const [trailVersion, setTrailVersion] = useState(0); // bumped to force a re-render as samples accumulate
  const [trailPaused, setTrailPaused] = useState(false); // mirrors trailPausedRef, only for display
  const trailRef = useRef([]); // [{ poseX, poseY, left:{x,y}, right:{x,y} }, ...] in world space
  const trailModeRef = useRef(trailMode);
  const trailPausedRef = useRef(false);
  const poseRef = useRef({ x: 0, y: 0, theta: 0 }); // live pose during the drive loop, source of truth for trail sampling

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
  trailModeRef.current = trailMode;

  function clearTrail() {
    trailRef.current = [];
    trailPausedRef.current = false;
    setTrailPaused(false);
    setTrailVersion((v) => v + 1);
  }

  // Appends a trail sample for `nextPose` if trail mode is on, the bus has moved far enough since
  // the last sample, and we're still within the capped 1km² recording area. Called from the drive
  // loop below with a plain value (never from inside a setState updater — this repo runs under
  // StrictMode, which double-invokes updater functions to catch impure ones, and this mutates a ref).
  function maybeSampleTrail(nextPose, g) {
    if (!trailModeRef.current) return;
    const outOfBounds = Math.abs(nextPose.x) > TRAIL_BOUND_HALF || Math.abs(nextPose.y) > TRAIL_BOUND_HALF;
    if (outOfBounds !== trailPausedRef.current) {
      trailPausedRef.current = outOfBounds;
      setTrailPaused(outOfBounds);
    }
    if (outOfBounds) return;
    const samples = trailRef.current;
    const last = samples[samples.length - 1];
    if (last) {
      const dx = nextPose.x - last.poseX, dy = nextPose.y - last.poseY;
      if (dx * dx + dy * dy < TRAIL_MIN_SPACING_SQ) return;
    }
    const halfW = bandHalfWidth(g.Tw);
    const axleHalfW = singleAxleBandHalfWidth(g.Tw); // same formula for front and tag — neither is a dual pair
    samples.push({
      poseX: nextPose.x, poseY: nextPose.y,
      left: poseTransform({ x: 0, y: halfW }, nextPose),
      right: poseTransform({ x: 0, y: -halfW }, nextPose),
      frontLeft: poseTransform({ x: g.Lfd, y: axleHalfW }, nextPose),
      frontRight: poseTransform({ x: g.Lfd, y: -axleHalfW }, nextPose),
      tagLeft: poseTransform({ x: -g.Ldt, y: axleHalfW }, nextPose),
      tagRight: poseTransform({ x: -g.Ldt, y: -axleHalfW }, nextPose),
    });
    if (samples.length % TRAIL_RENDER_EVERY === 0) setTrailVersion((v) => v + 1);
  }

  // Only reset the vehicle's position when the physical dimensions change (a different-size bus
  // means the old pose isn't meaningful). Steering, tag ratio and lockout changes leave the bus
  // exactly where it is — only the swept-path circles update to match the new radius. A dimension
  // change invalidates any existing trail the same way — it was painted by a different-size bus.
  useEffect(() => { setPose({ x: 0, y: 0, theta: 0 }); clearTrail(); }, [Lfd, Ldt, Fo, Ro, Wb, Tw]);

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
  // rather than restarting the loop or resetting position. `poseRef` is seeded from the latest
  // `pose` state whenever a drive starts, then driven forward imperatively each tick — trail
  // sampling needs the freshly-integrated value synchronously, which a functional setPose update
  // can't give us without pushing the sampling side effect into the updater itself (unsafe under
  // StrictMode's double-invocation of updater functions).
  useEffect(() => {
    if (!animating) { lastTRef.current = null; return; }
    poseRef.current = pose;
    function step(t) {
      if (lastTRef.current == null) lastTRef.current = t;
      const dt = Math.min((t - lastTRef.current) / 1000, 0.05);
      lastTRef.current = t;
      const g = geomRef.current;
      const v = (speedRef.current * 1000) / 3600;
      const omega = g.isStraight ? 0 : v / g.R;
      const prev = poseRef.current;
      const next = {
        x: prev.x + v * dt * Math.cos(prev.theta),
        y: prev.y + v * dt * Math.sin(prev.theta),
        theta: prev.theta + omega * dt,
      };
      poseRef.current = next;
      setPose(next);
      maybeSampleTrail(next, g);
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
    const busView = computeView(geom, pose, "bus", vbSize);
    if (mode === "bus") return busView;
    const circleView = computeView(geom, pose, "circle", vbSize);
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

  const autoView = transition
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

  // Mouse-wheel zoom: a plain multiplier on top of the auto-computed view, applied about the
  // viewBox centre (not the cursor) — the camera is already tracking the point that matters (bus
  // position or turn centre) dead-centre every frame, so zooming around that same centre keeps it
  // there rather than fighting the auto-framing. Persists independently of steering/pose/mode.
  const displayedView = {
    scale: autoView.scale * zoom,
    originX: vbSize.w / 2 + (autoView.originX - vbSize.w / 2) * zoom,
    originY: vbSize.h / 2 + (autoView.originY - vbSize.h / 2) * zoom,
  };

  // ---------- build drawable points ----------
  const bodyStatic = ["FL", "FR", "RR", "RL"].map((k) => geom.bodyCorners[k]);
  const bodyWorld = bodyStatic.map((p) => poseTransform(p, pose));
  const bodyScreen = bodyWorld.map((p) => toScreen(displayedView, p));

  // Head/tail lights and driver marker — fixed body detail, chassis-local, no steer angle of
  // their own (angle 0 in wheelStaticCorners), just carried through the vehicle's pose like the
  // body corners above.
  const halfWbody = geom.Wb / 2;
  const HEADLIGHT_INBOARD_OFFSET = 0.4; // metres, inner pair relative to outer pair
  const lightCenters = {
    headL: { x: geom.Lfd + geom.Fo - 0.12, y: halfWbody - 0.22 },
    headR: { x: geom.Lfd + geom.Fo - 0.12, y: -(halfWbody - 0.22) },
    headL2: { x: geom.Lfd + geom.Fo - 0.12, y: halfWbody - 0.22 - HEADLIGHT_INBOARD_OFFSET },
    headR2: { x: geom.Lfd + geom.Fo - 0.12, y: -(halfWbody - 0.22 - HEADLIGHT_INBOARD_OFFSET) },
    tailL: { x: -(geom.Ldt + geom.Ro) + 0.12, y: halfWbody - 0.22 },
    tailR: { x: -(geom.Ldt + geom.Ro) + 0.12, y: -(halfWbody - 0.22) },
  };
  const lightScreens = Object.fromEntries(
    Object.entries(lightCenters).map(([key, center]) => [
      key,
      wheelStaticCorners(center, 0, 0.1, 0.16).map((p) => toScreen(displayedView, poseTransform(p, pose))),
    ])
  );
  // Driver sits at the front-offside corner, ahead of the front axle — this fleet is
  // right-hand-drive (Australian), and the driver's position is forward of the front wheels.
  // Icon is the supplied artwork (DRIVER_ICON_VIEWBOX/PATHS below), embedded as a nested SVG sized
  // from a fixed real-world width so it scales with the vehicle and view zoom like the mirror/lights,
  // rather than staying a fixed screen size.
  const driverLocal = { x: geom.Lfd + geom.Fo - 0.80, y: -(halfWbody - 0.4) };
  const driverScreen = toScreen(displayedView, poseTransform(driverLocal, pose));
  const DRIVER_ICON_WORLD_W = 0.55; // metres
  const driverIconScreenW = DRIVER_ICON_WORLD_W * displayedView.scale;
  const driverIconScreenH = driverIconScreenW * (DRIVER_ICON_VB_H / DRIVER_ICON_VB_W);

  // Nearside mirror — mounted at the front-nearside body corner, angled backward and outward
  // along the nearside edge. The centre is only pushed out 70% of the half-length (rather than a
  // full half-length), so ~15% of the arm sits back over the corner instead of starting flush at it.
  const mirrorAngle = toRad(125);
  const mirrorHalfLen = 0.3, mirrorHalfW = 0.06;
  const mirrorMount = { x: geom.Lfd + geom.Fo, y: halfWbody };
  const mirrorCenter = {
    x: mirrorMount.x + Math.cos(mirrorAngle) * mirrorHalfLen * 0.7,
    y: mirrorMount.y + Math.sin(mirrorAngle) * mirrorHalfLen * 0.7,
  };
  const mirrorScreen = wheelStaticCorners(mirrorCenter, mirrorAngle, mirrorHalfLen, mirrorHalfW).map((p) =>
    toScreen(displayedView, poseTransform(p, pose))
  );

  // Offside mirror — short, mounted at the body edge a short distance ahead of the driver, angled
  // almost straight out (near-perpendicular to the body) rather than swept back like the nearside one.
  const mirrorOAngle = toRad(-95);
  const mirrorOHalfLen = 0.16, mirrorOHalfW = 0.05;
  const mirrorOMount = { x: driverLocal.x + 0.40, y: -halfWbody };
  const mirrorOCenter = {
    x: mirrorOMount.x + Math.cos(mirrorOAngle) * mirrorOHalfLen * 0.7,
    y: mirrorOMount.y + Math.sin(mirrorOAngle) * mirrorOHalfLen * 0.7,
  };
  const mirrorOScreen = wheelStaticCorners(mirrorOCenter, mirrorOAngle, mirrorOHalfLen, mirrorOHalfW).map((p) =>
    toScreen(displayedView, poseTransform(p, pose))
  );

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

  // Trail: the ribbon of everywhere the swept corridor has actually been, built from accumulated
  // world-space samples rather than derived from the current instantaneous circle. trailRef is a
  // plain ref (mutated per-frame in the drive loop, see maybeSampleTrail) so it doesn't itself
  // trigger a render — trailVersion state is bumped periodically instead, purely to force this
  // component to re-run and pick up the latest trailRef.current.
  const trailSamples = trailRef.current;
  const trailPolygonPoints = trailMode && trailSamples.length >= 2
    ? ptsToPath([
        ...trailSamples.map((s) => toScreen(displayedView, s.left)),
        ...trailSamples.map((s) => toScreen(displayedView, s.right)).reverse(),
      ])
    : null;
  // Second and third bands: the front and tag axles' own tracks, each sampled at that axle's own
  // along-chassis offset (see singleAxleBandHalfWidth) — separate ribbons since they follow
  // different curves than the drive-axle band above once the bus is turning.
  const frontTrailPolygonPoints = trailMode && trailSamples.length >= 2
    ? ptsToPath([
        ...trailSamples.map((s) => toScreen(displayedView, s.frontLeft)),
        ...trailSamples.map((s) => toScreen(displayedView, s.frontRight)).reverse(),
      ])
    : null;
  const tagTrailPolygonPoints = trailMode && trailSamples.length >= 2
    ? ptsToPath([
        ...trailSamples.map((s) => toScreen(displayedView, s.tagLeft)),
        ...trailSamples.map((s) => toScreen(displayedView, s.tagRight)).reverse(),
      ])
    : null;

  // Preview: unfilled lines only, no shaded corridor — a dashed centreline (the drive axle's own
  // path, 50m ahead) plus dotted front wheel tracks (25m ahead, shorter and more transparent since
  // they're the finer-grained detail). Recomputed fresh each render from live pose/geom rather than
  // accumulated like the cured trail below — always shown in trail mode (not gated on actively
  // driving), since it's the only useful trail content before any history exists (see
  // docs/trail-display-mode.md open questions).
  const previewPoses = trailMode ? projectPosesForward(pose, geom, TRAIL_PREVIEW_LENGTH, TRAIL_PREVIEW_STEPS) : null;
  const previewPosesFront = trailMode ? projectPosesForward(pose, geom, TRAIL_PREVIEW_FRONT_LENGTH, TRAIL_PREVIEW_FRONT_STEPS) : null;
  const previewAxleHalfW = singleAxleBandHalfWidth(geom.Tw);
  function previewLinePoints(poses, offsetX, offsetY) {
    return poses.map((p) => toScreen(displayedView, poseTransform({ x: offsetX, y: offsetY }, p))).map((s) => `${s.x},${s.y}`).join(" ");
  }
  const previewCentrelinePoints = previewPoses ? previewLinePoints(previewPoses, 0, 0) : null;
  const previewFrontLeftPoints = previewPosesFront ? previewLinePoints(previewPosesFront, geom.Lfd, previewAxleHalfW) : null;
  const previewFrontRightPoints = previewPosesFront ? previewLinePoints(previewPosesFront, geom.Lfd, -previewAxleHalfW) : null;

  // Below, in trail mode the swept-path reference circles (outer envelope, pivot, tag-inner,
  // tail-swing, w3/w6) are drawn as "next 50m" arcs instead of full circles — same forward window
  // as the preview bands above, computed from the same previewPoses so the two always agree.
  const previewArcStart = previewPoses && !geom.isStraight
    ? (() => {
        const p0 = toScreen(displayedView, { x: previewPoses[0].x, y: previewPoses[0].y });
        return Math.atan2(p0.y - Cscreen.y, p0.x - Cscreen.x);
      })()
    : null;
  const previewArcSweep = previewPoses ? previewPoses[previewPoses.length - 1].theta - previewPoses[0].theta : null;
  function sweptRing(r, props) {
    return trailMode && previewArcStart != null
      ? <path d={arcPathFromWorldSweep(Cscreen.x, Cscreen.y, r, previewArcStart, previewArcSweep)} fill="none" {...props} />
      : <circle cx={Cscreen.x} cy={Cscreen.y} r={r} fill="none" {...props} />;
  }

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
        .btn{ font-family:'Barlow Condensed',sans-serif; text-transform:uppercase; letter-spacing:0.6px; font-size:15px; padding:8px 12px; border-radius:3px; border:1px solid rgba(200,225,245,0.25); background:rgba(200,225,245,0.04); color:#eaf2f8; cursor:pointer; }
        .btn:active{ transform:translateY(1px); }
        .btnOn{ background:#ffb937; color:#0b1c30; border-color:#ffb937; font-weight:600; }
      `}</style>

      {/* header */}
      <div style={{ padding: "10px 12px 8px", borderBottom: "1px solid rgba(200,225,245,0.12)" }}>
        <div style={{ fontSize: 14, letterSpacing: 1.5, color: COL.tag, textTransform: "uppercase" }}>Plan View Study · Rev A</div>
        <div style={{ fontSize: 29, fontWeight: 600, letterSpacing: 0.3 }}>3-Axle Steer / Tag Articulation</div>
        <div style={{ fontSize: 16, color: COL.textDim, marginTop: 2, lineHeight: 1.4 }}>
          Front axle steers, drive axle fixed (pivot reference), tag axle counter-steers. Default dimensions match a 14.5 m tag-axle bus (2.48 m wide, excl. mirrors) — adjust the geometry sliders for a different spec.
        </div>
      </div>

      {/* main layout: map + side panel — wraps to a stacked layout if the host container is narrow */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 10, padding: "8px 10px 0", alignItems: "flex-start" }}>
        {/* map column */}
        <div style={{ flex: "3 1 420px", minWidth: 640, maxWidth: "100%", overflow: "hidden" }}>
        <div
          ref={mapWrapperRef}
          style={{
            position: "relative", overflow: "hidden", contain: "layout paint",
            width: "100%", height: sidePanelHeight > 0 ? sidePanelHeight : undefined, aspectRatio: sidePanelHeight > 0 ? undefined : "1/1",
          }}
        >
        <svg
          viewBox={`0 0 ${vbSize.w} ${vbSize.h}`}
          style={{ width: "100%", height: "100%", background: COL.panelAlt, borderRadius: 4, border: "1px solid rgba(200,225,245,0.14)", overflow: "hidden" }}
        >
          <defs>
            <pattern id="grid" width={gridPx} height={gridPx} patternUnits="userSpaceOnUse">
              <path d={`M ${gridPx} 0 L 0 0 0 ${gridPx}`} fill="none" stroke={COL.grid} strokeWidth="1" />
            </pattern>
            <clipPath id="mapClip">
              <rect x="0" y="0" width={vbSize.w} height={vbSize.h} />
            </clipPath>
          </defs>
          <g clipPath="url(#mapClip)">
          <rect x="0" y="0" width={vbSize.w} height={vbSize.h} fill="url(#grid)" />

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

          {/* preview: unfilled lines only, if the current steering angle is held — a 50m dashed
              centreline (drive axle's own path) plus 25m dotted front wheel tracks, fainter still
              since they're the finer-grained detail (see docs/trail-display-mode.md) */}
          {previewCentrelinePoints && (
            <polyline points={previewCentrelinePoints} fill="none" stroke={COL.trail} strokeOpacity="0.55" strokeWidth="1" strokeDasharray="5 5" />
          )}
          {previewFrontLeftPoints && (
            <polyline points={previewFrontLeftPoints} fill="none" stroke={COL.front} strokeOpacity="0.3" strokeWidth="1" strokeDasharray="1 4" />
          )}
          {previewFrontRightPoints && (
            <polyline points={previewFrontRightPoints} fill="none" stroke={COL.front} strokeOpacity="0.3" strokeWidth="1" strokeDasharray="1 4" />
          )}

          {/* trail: painted record of the corridor actually driven so far (see docs/trail-display-mode.md).
              Fill only, no stroke — an outline on a band built from left-then-right-reversed edge
              points draws a straight closing edge across the front and back of the band on every
              polygon, which reads as a spurious solid line cutting across the axles. */}
          {trailPolygonPoints && (
            <polygon points={trailPolygonPoints} fill={COL.trail} fillOpacity="0.16" />
          )}
          {/* second band: the front axle's own track, drawn in the same colour used for the front
              axle everywhere else in this view (wheels 1–2, mowing-the-grass lines) */}
          {frontTrailPolygonPoints && (
            <polygon points={frontTrailPolygonPoints} fill={COL.front} fillOpacity="0.16" />
          )}
          {/* third band: the tag axle's own track, drawn in the same colour used for the tag axle
              everywhere else in this view (wheels 7–8, tail-swing lines) */}
          {tagTrailPolygonPoints && (
            <polygon points={tagTrailPolygonPoints} fill={COL.tag} fillOpacity="0.16" />
          )}

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
              {sweptRing(R_outer_px, { stroke: COL.pathOuter, strokeWidth: "1", strokeDasharray: "4 6", opacity: "0.35" })}
              {sweptRing(R_pivot_px, { stroke: COL.dim, strokeWidth: "1.6", strokeDasharray: "10 8", opacity: "0.45" })}
              {sweptRing(R_tagInner_px, { stroke: COL.pathInner, strokeWidth: "1", strokeDasharray: "4 6", opacity: "0.35" })}
              {sweptRing(R_tailSwing_px, { stroke: COL.tailSwing, strokeWidth: "1.3", strokeDasharray: "3 5", opacity: "0.75" })}
              {/* wheel 3 & 6 — the important ones */}
              {sweptRing(geom.radii.w3 * displayedView.scale, { stroke: COL.w3, strokeWidth: "5", opacity: "0.18" })}
              {sweptRing(geom.radii.w3 * displayedView.scale, { stroke: COL.w3, strokeWidth: "2.4", opacity: "1" })}
              {sweptRing(geom.radii.w6 * displayedView.scale, { stroke: COL.w6, strokeWidth: "5", opacity: "0.18" })}
              {sweptRing(geom.radii.w6 * displayedView.scale, { stroke: COL.w6, strokeWidth: "2.4", opacity: "1" })}
              {/* center marker */}
              <line x1={Cscreen.x - 9} y1={Cscreen.y} x2={Cscreen.x + 9} y2={Cscreen.y} stroke={COL.dim} strokeWidth="1.4" />
              <line x1={Cscreen.x} y1={Cscreen.y - 9} x2={Cscreen.x} y2={Cscreen.y + 9} stroke={COL.dim} strokeWidth="1.4" />
              <circle cx={Cscreen.x} cy={Cscreen.y} r="3" fill={COL.dim} />
              <text x={Cscreen.x + 12} y={Cscreen.y - 10} fontFamily="'Space Mono',monospace" fontSize="12" fill={geom.radii.w3 <= geom.radii.w6 ? COL.w3 : COL.w6}>
                C · R {fmt(Math.min(geom.radii.w3, geom.radii.w6))}m
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
          {showDims && !geom.isStraight && (() => {
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

          {/* headlights (front) and tail lights (rear) */}
          <polygon points={ptsToPath(lightScreens.headL)} fill="#f5f8fb" stroke="#0b1c30" strokeWidth="0.8" />
          <polygon points={ptsToPath(lightScreens.headR)} fill="#f5f8fb" stroke="#0b1c30" strokeWidth="0.8" />
          <polygon points={ptsToPath(lightScreens.headL2)} fill="#f5f8fb" stroke="#0b1c30" strokeWidth="0.8" />
          <polygon points={ptsToPath(lightScreens.headR2)} fill="#f5f8fb" stroke="#0b1c30" strokeWidth="0.8" />
          <polygon points={ptsToPath(lightScreens.tailL)} fill="#e5384d" stroke="#0b1c30" strokeWidth="0.8" />
          <polygon points={ptsToPath(lightScreens.tailR)} fill="#e5384d" stroke="#0b1c30" strokeWidth="0.8" />

          {/* driver marker — offside/front, right-hand-drive. Supplied artwork, embedded as a
              nested SVG sized from a fixed real-world width so it scales with the vehicle and
              view zoom like the mirror/lights, rather than staying a fixed screen size. Not
              rotated with vehicle heading — a stylised location marker, not a facing indicator. */}
          <svg
            x={driverScreen.x - driverIconScreenW / 2} y={driverScreen.y - driverIconScreenH / 2}
            width={driverIconScreenW} height={driverIconScreenH}
            viewBox={`0 0 ${DRIVER_ICON_VB_W} ${DRIVER_ICON_VB_H}`}
          >
            <path d={DRIVER_ICON_HEAD_D} fill="#FED700" transform="translate(77.46377623081207,423.8665961623192)" />
            <path d={DRIVER_ICON_CAP_D} fill="#0025FE" transform="translate(2,65)" />
          </svg>

          {/* nearside mirror */}
          <polygon points={ptsToPath(mirrorScreen)} fill="#9aa5b1" stroke="#0b1c30" strokeWidth="0.8" />

          {/* offside mirror */}
          <polygon points={ptsToPath(mirrorOScreen)} fill="#9aa5b1" stroke="#0b1c30" strokeWidth="0.8" />

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
        <div style={{ position: "absolute", left: 10, top: 10, display: "flex", flexDirection: "column", gap: 4, background: "rgba(10,26,44,0.72)", borderRadius: 4, padding: "6px 8px", fontSize: 14, color: COL.textDim, textTransform: "uppercase", letterSpacing: 0.4 }}>
          <LegendDot color={COL.front} label="Front · steers (1–2)" />
          <LegendDot color={COL.drive} label="Drive · fixed, dual (3–6)" />
          <LegendDot color={COL.tag} label="Tag · counter-steers (7–8)" />
          <LegendDot color={COL.w3} label="Wheel 3 path — nearside" />
          <div style={{ fontSize: 14, opacity: 0.7, marginTop: 2 }}>Nearside = left (1, 3, 4, 7)</div>
        </div>
        <div style={{ position: "absolute", right: 10, top: 10, display: "flex", flexDirection: "column", gap: 4, alignItems: "flex-end", background: "rgba(10,26,44,0.72)", borderRadius: 4, padding: "6px 8px", fontSize: 14, color: COL.textDim, textTransform: "uppercase", letterSpacing: 0.4, textAlign: "right" }}>
          <LegendDot color={COL.w6} label="Wheel 6 path — offside" />
          <LegendDot color={COL.pathOuter} label="Outer swept path (ref.)" />
          <LegendDot color={COL.pathInner} label="Tag inner path (ref.)" />
          <LegendDot color={COL.tailSwing} label="Tail swing (rear outer corner)" />
          {trailMode && <LegendDot color={COL.trail} label="Trail — drive axle corridor" />}
          {trailMode && <LegendDot color={COL.front} label="Trail — front axle track" />}
          {trailMode && <LegendDot color={COL.tag} label="Trail — tag axle track" />}
          <div style={{ fontSize: 14, opacity: 0.7, marginTop: 2 }}>Offside = right (2, 5, 6, 8)</div>
        </div>
        <div style={{ position: "absolute", left: 10, bottom: 10, display: "flex", boxShadow: "0 2px 8px rgba(0,0,0,0.45)", borderRadius: 3, overflow: "hidden" }}>
          <button
            onClick={() => selectViewMode("bus")}
            style={{
              fontFamily: "'Barlow Condensed',sans-serif", textTransform: "uppercase", letterSpacing: 0.6, fontSize: 15,
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
              fontFamily: "'Barlow Condensed',sans-serif", textTransform: "uppercase", letterSpacing: 0.6, fontSize: 15,
              padding: "8px 12px", border: "none", cursor: "pointer",
              background: viewMode === "circle" ? COL.amber : "rgba(200,225,245,0.08)",
              color: viewMode === "circle" ? COL.bg : COL.text,
              fontWeight: viewMode === "circle" ? 600 : 400,
            }}
          >
            Circle
          </button>
          {viewMode === "bus" && (
            <button
              onClick={() => setPose({ x: 0, y: 0, theta: 0 })}
              title="Reset the vehicle back to the centre, facing straight ahead"
              style={{
                fontFamily: "'Barlow Condensed',sans-serif", textTransform: "uppercase", letterSpacing: 0.6, fontSize: 15,
                padding: "8px 12px", border: "none", cursor: "pointer",
                background: "rgba(200,225,245,0.08)", color: COL.text, fontWeight: 400,
              }}
            >
              Recenter
            </button>
          )}
        </div>
        {zoom !== 1 && (
          <button
            onClick={() => setZoom(1)}
            title="Scroll-wheel zoom — click to reset to 100%"
            style={{
              position: "absolute", left: 10, bottom: 48,
              fontFamily: "'Space Mono',monospace", fontSize: 12,
              padding: "4px 8px", border: "none", borderRadius: 3, cursor: "pointer",
              background: "rgba(10,26,44,0.72)", color: COL.textDim,
              boxShadow: "0 2px 8px rgba(0,0,0,0.45)",
            }}
          >
            {Math.round(zoom * 100)}% zoom ×
          </button>
        )}
        <div style={{ position: "absolute", left: "50%", bottom: 10, transform: "translateX(-50%)", display: "flex", gap: 4, whiteSpace: "nowrap" }}>
          <button className={"btn" + (showBand ? " btnOn" : "")} onClick={() => setShowBand((v) => !v)} style={{ fontSize: 12, padding: "5px 7px", boxShadow: "0 2px 8px rgba(0,0,0,0.45)" }}>Off-track</button>
          <button className={"btn" + (showGeom ? " btnOn" : "")} onClick={() => setShowGeom((v) => !v)} style={{ fontSize: 12, padding: "5px 7px", boxShadow: "0 2px 8px rgba(0,0,0,0.45)" }}>Construction</button>
          <button className={"btn" + (showDims ? " btnOn" : "")} onClick={() => setShowDims((v) => !v)} style={{ fontSize: 12, padding: "5px 7px", boxShadow: "0 2px 8px rgba(0,0,0,0.45)" }}>Dimensions</button>
          <button className={"btn" + (trailMode ? " btnOn" : "")} onClick={() => setTrailMode((v) => !v)} style={{ fontSize: 12, padding: "5px 7px", boxShadow: "0 2px 8px rgba(0,0,0,0.45)" }}>Trail</button>
          {trailMode && (
            <button onClick={clearTrail} className="btn" title="Clear the recorded trail" style={{ fontSize: 12, padding: "5px 7px", boxShadow: "0 2px 8px rgba(0,0,0,0.45)" }}>Clear</button>
          )}
        </div>
        {trailMode && trailPaused && (
          <div style={{ position: "absolute", left: "50%", bottom: 40, transform: "translateX(-50%)", fontSize: 11, color: COL.tag, background: "rgba(10,26,44,0.85)", padding: "3px 8px", borderRadius: 3, whiteSpace: "nowrap" }}>
            Trail paused — outside 1km² mapped area
          </div>
        )}
        <button
          className={"btn" + (animating ? " btnOn" : "")}
          onClick={() => setSpeed(animating ? 0 : 12)}
          style={{ position: "absolute", right: 10, bottom: 10, boxShadow: "0 2px 8px rgba(0,0,0,0.45)" }}
        >
          {animating ? "■ Stop" : "▶ Drive the turn"}
        </button>
        </div>
        </div>

        {/* side panel: grid readouts on top, primary controls below — no collapse here, always visible */}
        <div ref={sidePanelRef} style={{ flex: "1 1 340px", minWidth: 290, maxWidth: 415, background: COL.panel, border: "1px solid rgba(200,225,245,0.16)", borderRadius: 4, padding: 12 }}>
          <SectionLabel>Radius grid</SectionLabel>
          <div style={{ border: "1px solid rgba(200,225,245,0.16)", borderRadius: 4, overflow: "hidden", display: "grid", gridTemplateColumns: "1fr 1fr", background: COL.panelAlt, marginBottom: 10 }}>
            <ReadCell label="Wheel 3 path radius (nearside)" value={geom.isStraight ? "∞" : fmt(geom.radii.w3) + " m"} accent={COL.w3} />
            <ReadCell label="Wheel 6 path radius (offside)" value={geom.isStraight ? "∞" : fmt(geom.radii.w6) + " m"} accent={COL.w6} />
            <ReadCell label="Front steer δf" value={geom.isStraight ? "0.0° straight" : fmt(Math.abs(geom.deltaFdeg)) + "° " + (geom.deltaFdeg > 0 ? "→ nearside" : "→ offside")} accent={COL.front} />
            <ReadCell label="Tag steer (applied)" value={geom.isStraight ? "0.0°" : fmt(geom.appliedDeltaT ? toDeg(geom.appliedDeltaT) : 0) + "°"} accent={COL.tag} />
            <ReadCell label="Pivot radius (drive axle)" value={geom.isStraight ? "∞" : fmt(Math.abs(geom.R)) + " m"} />
            <ReadCell label="Turning circle ⌀" value={geom.isStraight ? "∞" : fmt(geom.turningDiameter) + " m"} />
            <ReadCell label="Drive axle swept width (3↔6)" value={geom.isStraight ? "0.0 m" : fmt(geom.offTracking) + " m"} accent={COL.pathInner} />
            <ReadCell label="Tail swing radius (rear outer)" value={geom.isStraight ? "∞" : fmt(R_tailSwing_px / displayedView.scale) + " m"} accent={COL.tailSwing} />
            <ReadCell label="Mowing the grass — #1" value={geom.isStraight ? "0.0 m" : fmt(geom.mow1) + " m"} accent={COL.front} />
            <ReadCell label="Mowing the grass — #2" value={geom.isStraight ? "0.0 m" : fmt(geom.mow2) + " m"} accent={COL.front} />
            <ReadCell label="Tail swing vs #7" value={geom.isStraight ? "0.0 m" : fmt(geom.tailSwing7) + " m"} accent={COL.tailSwing} />
            <ReadCell label="Tail swing vs #8" value={geom.isStraight ? "0.0 m" : fmt(geom.tailSwing8) + " m"} accent={COL.tailSwing} />
          </div>

          <SectionLabel>Steering &amp; throttle</SectionLabel>
          <div style={{ display: "flex", gap: 14, alignItems: "flex-start" }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <SteeringWheel angleDeg={steerInput} />
              <SteppedSlider label="Front steer input (+ = right / offside)" unit="°" value={steerInput} steps={STEER_STEPS} onChange={setSteerInput} accent={COL.front} />
              <div style={{ fontSize: 15, color: COL.textDim, margin: "-4px 0 8px" }}>← / → arrow keys nudge the lock — 0.15° steps near straight-ahead (±3°), 0.5° beyond that</div>
              <div style={{ display: "flex", gap: 8, justifyContent: "center" }}>
                {[["Full lock left", -50], ["Straight", 0], ["Full lock right", 50]].map(([lbl, v]) => (
                  <button key={lbl} className="btn" style={{ flex: "1 1 0" }} onClick={() => setSteerInput(v)}>{lbl}</button>
                ))}
              </div>
            </div>
            <VerticalSlider label="Throttle" unit=" km/h" value={speed} min={0} max={60} step={1} onChange={setSpeed} accent={COL.amber} />
          </div>

          {/* reference photo: confirmed dimensions of the actual BCC Volvo/Scania tag-axle bus
              (fleet #5054) the geometry defaults above are modelled on. */}
          <div style={{ marginTop: 10, border: "1px solid rgba(200,225,245,0.16)", borderRadius: 4, background: "#fff", overflow: "hidden" }}>
            <img src={busDimensionsPhoto} alt="BCC Volvo/Scania tag-axle bus (fleet 5054) with confirmed axle dimensions" style={{ display: "block", width: "100%", height: "auto" }} />
          </div>
        </div>
      </div>

      {/* advanced settings: full window width, below both the map and side panel, collapsed by default */}
      <div style={{ padding: "10px 10px 0" }}>
        <Collapsible title="Advanced settings" open={advancedOpen} onToggle={() => setAdvancedOpen((v) => !v)}>
          <SectionLabel>Tag axle behaviour</SectionLabel>
          <Slider label="Tag axle sync ratio (1 = ideal Ackermann)" unit="×" value={tagRatio} min={0} max={1.3} step={0.05} onChange={setTagRatio} accent={COL.tag} />

          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
            <span style={{ fontSize: 15, color: COL.textDim, textTransform: "uppercase", letterSpacing: 0.5 }}>Speed lockout above threshold</span>
            <button className={"btn" + (lockoutOn ? " btnOn" : "")} onClick={() => setLockoutOn((v) => !v)}>{lockoutOn ? "On" : "Off"}</button>
          </div>
          {lockoutOn && <Slider label="Lockout threshold" unit=" km/h" value={lockoutSpeed} min={10} max={40} step={1} onChange={setLockoutSpeed} />}

          <SectionLabel>Vehicle geometry (m)</SectionLabel>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", columnGap: 20, rowGap: 4 }}>
            <Slider label="Front–drive wheelbase" unit="m" value={Lfd} min={4} max={8} step={0.1} onChange={setLfd} />
            <Slider label="Drive–tag wheelbase" unit="m" value={Ldt} min={1} max={3.5} step={0.1} onChange={setLdt} />
            <Slider label="Front overhang" unit="m" value={Fo} min={1.5} max={3.5} step={0.1} onChange={setFo} />
            <Slider label="Rear overhang" unit="m" value={Ro} min={1} max={4} step={0.1} onChange={setRo} />
            <Slider label="Body width" unit="m" value={Wb} min={2.3} max={2.6} step={0.01} onChange={setWb} />
            <Slider label="Track width" unit="m" value={Tw} min={1.8} max={2.3} step={0.01} onChange={setTw} />
          </div>
          <div style={{ fontSize: 15, color: COL.textDim, marginTop: 2, marginBottom: 4 }}>
            Overall length ≈ {(Lfd + Fo + Ldt + Ro).toFixed(1)} m
          </div>
        </Collapsible>
      </div>

      <div style={{ padding: "10px 12px 0", fontSize: 15, color: COL.textDim, lineHeight: 1.5 }}>
        Wheels numbered 1–8: 1–2 front (nearside/offside), 3–4 drive-axle nearside pair (3 leftmost/outer, 4 inner), 5–6 drive-axle offside pair (5 inner, 6 rightmost/outer), 7–8 tag axle. Model: steady-state circular turn, no tyre slip. Tag axle angle set for zero-scrub rolling at the current ratio; when locked straight (ratio 0, or above the speed lockout), the dashed ghost outline shows the ideal angle it's deviating from — the "tag scrub angle" readout is that gap. The shaded band spans from the drive axle's inner wheel (3 or 6, whichever is tighter) out to the front axle's outer wheel (2 or 1) — the corridor the vehicle actually occupies through the turn. The outer tail-swing circle (rear corner) is shown as a plain dashed reference only.
      </div>
    </div>
  );
}

function SectionLabel({ children }) {
  return (
    <div style={{ fontSize: 15, letterSpacing: 1.2, color: COL.tag, textTransform: "uppercase", margin: "4px 0 8px", borderBottom: "1px solid rgba(200,225,245,0.14)", paddingBottom: 4 }}>
      {children}
    </div>
  );
}

function Collapsible({ title, open, onToggle, children }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <button
        onClick={onToggle}
        style={{
          display: "flex", justifyContent: "space-between", alignItems: "center", width: "100%",
          background: "transparent", border: "none", borderBottom: "1px solid rgba(200,225,245,0.14)",
          padding: "8px 0", cursor: "pointer", fontFamily: "'Barlow Condensed',sans-serif",
        }}
      >
        <span style={{ fontSize: 15, letterSpacing: 1.2, color: COL.tag, textTransform: "uppercase" }}>{title}</span>
        <span style={{ color: COL.textDim, fontFamily: "'Space Mono',monospace", fontSize: 17 }}>{open ? "▾ collapse" : "▸ expand"}</span>
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
