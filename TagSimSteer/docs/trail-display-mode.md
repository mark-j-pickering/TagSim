# Design note: Trail display mode

Status: v1 landed in `tag-steering-simulator.jsx` — history buffer, three
axle-track ribbons, and the forward 50m preview (the "Trail" toggle). The
tyre/overhang colour split described below is not implemented yet; see "What
shipped" at the bottom.

## Summary

A new display mode that paints a persistent record of where the bus has
actually driven, rather than (or alongside) the existing single-instant
turning-circle overlay. Two zones, split at the bus's current position:

- **Cured trail** (behind/at the bus): the real swept corridor, built from
  accumulated pose history as the user drives.
- **Preview** (ahead of the bus): a ~50m projection of the swept corridor if
  the current steering angle is held, so the driver has a guide for what's
  coming.

## Scope: stays in TagSimSteer, not TagSim3D

Considered building this as the seed of `TagSim3D` instead. Decided against
it: the feature as scoped is still a top-down, world-x/y thing — painted
bands on a plan-view ground plane — and reuses the existing chassis→world→
screen pipeline and `computeGeometry` wholesale. It has no rendering need
that 2D lacks. Standing up `TagSim3D` now would mean a whole new toolchain
(the two sub-projects are deliberately independent, no shared build — see
root CLAUDE.md) and porting or forking the kinematic model before the trail
feature itself exists anywhere, which is a much bigger lift than adding a
buffer and some polygons to the existing file.

If/when `TagSim3D` becomes a real 3D scene, ground-painted trails are a
natural feature to reproduce there too (the "ghost trail on the track
surface" pattern) — at that point this implementation is the reference to
port from, and extracting `computeGeometry` into something shareable
becomes worth deciding. Not before.

## Relationship to the existing off-tracking band

The current `showBand` overlay already draws a swept corridor — but it's
derived fresh each render from the *instantaneous* turn circle (or straight
line), with no memory of how the bus got there. This mode generalises that
same idea from "one steady-state circle" to "the path actually taken",
which is only meaningful because pose is already continuously dead-reckoned
(see main CLAUDE.md, "position is never reset when you change steering").

The preview zone reuses the existing circle/straight-line sweep math
directly — it's the current band logic, arc-length-clipped to ~50m instead
of drawn full-circle/full-line, and rendered visually distinct (lower
opacity, dashed edge, maybe a subtle pulse) so it reads as "if you hold this"
rather than a record of fact. This part is close to free.

The cured trail is the new piece: it needs an actual history buffer, since
today nothing in the component persists state across frames beyond `pose`
itself.

## What gets painted

Two bands per side, kept visually distinct since they mean different things:

- **Tyre corridor** — the strip actually swept by wheels. Bounded by the
  hero wheels (3 nearside / 6 offside) and whichever axle is more inboard on
  that side at each sample. Rendered in the existing hero colours
  (`COL.w3` lime / `COL.w6` violet).
- **Overhang corridor** — the strip swept by the body but no wheel, using
  the existing `mow1`/`mow2` (front corners) and `tailSwing7`/`tailSwing8`
  (rear corners) offsets. Rendered in the existing front/tag colours
  (amber/coral), at lower fill opacity or as a hatch, so it's legibly
  "nothing touched here, but the bus occupied this space."

Both are built as ribbon polygons: outer-edge history points forward,
paired inner-edge history points back, same construction as the current
annulus but from sampled path history instead of two circle radii.

## History buffer

- **Sampled by distance, not time or frame** — e.g. every ~0.15–0.3m of
  travel — so slow manoeuvring doesn't produce a denser mesh than highway
  speed, and long idle periods add nothing.
- Each sample stores enough to reconstruct both corridors at that instant:
  world-space positions for wheels 3/6 (or their inboard-axle counterpart)
  and the front/rear body corners — i.e. derived from `pose` +
  `computeGeometry` at sample time, not stored as raw pose alone, since the
  corridor shape depends on the geometry at each moment (mid-turn steering
  changes must show up as a corridor that widens/narrows, not a fixed-width
  ribbon dragged along a centreline).
- Persists across steering/tag-ratio/lockout changes, consistent with the
  existing pose-continuity philosophy. Reset only on vehicle-geometry
  changes (same trigger that already resets `pose`) or an explicit "clear
  trail" action.

## Implementation approach (state, not just render)

The existing pattern is: live state (`pose`, sliders) → `useMemo`-derived
render data, recomputed fresh each render. That pattern still fits
everything about this feature except the trail buffer itself, which has to
persist and accumulate across frames — the one thing nothing in the
component does today.

- Hold the trail as a `useRef` array (alongside `rafRef`/`lastTRef`/
  `geomRef`), appended to inside the existing RAF `step()` function in the
  "drive the turn" effect, right next to `setPose` — not `useState`, since a
  `setState` on every RAF tick for a growing array would re-render (and
  re-diff a growing SVG) far more than needed.
- Force a render periodically (e.g. a small `trailVersion` counter bumped
  every N appended samples) rather than on every sample. At ~0.2m sampling
  within the 1km² cap the point count stays small enough that this should be
  enough; a dedicated non-React-diffed SVG/canvas layer is the fallback if
  it isn't.

## Bounding the surface to 1km²

Proposal: cap the trail to a fixed **1000m × 1000m axis-aligned square in
world space, anchored at the origin** (`pose = {0,0,0}`, the same point the
bus already starts at / resets to). This is a recording-area limit, not a
viewport — the camera still frames the bus normally; this only bounds how
much trail geometry is kept and drawn.

Rationale:
- Bounds memory/render cost for arbitrarily long "drive the turn" sessions
  (e.g. looping in a circle for an hour) without needing a rolling/moving
  window, which would fight the "cured record" framing by erasing history
  behind the bus as it moves.
- 1km² is generous relative to this vehicle — a full-lock turning circle is
  tens of metres across — so under any realistic use it won't be felt; it's
  a backstop, not a practical constraint.
- There's a loose precedent already: the straight-line reference features
  (`longLineScreen`/`longBandPoints`) already extend to ±1000m, so a
  1000m-scale world extent isn't a new idea in this codebase, just applied
  to a bounded area instead of unbounded lines.

Edge behaviour: once a sample would fall outside the square, stop
appending new trail geometry (don't wrap, don't clip mid-polygon) and show
a small non-blocking indicator ("trail recording paused — outside mapped
area") near the existing legend panels. Driving back inside the square
resumes recording. This avoids silently truncating or corrupting the
ribbon polygons at the boundary.

## Controls

- A toggle for the mode itself, orthogonal to the existing Bus/Circle
  camera toggle (trail mode should work under either framing) — most
  naturally alongside `showBand` in "Advanced settings" as a mode swap
  rather than a new independent checkbox, since showing both the
  instantaneous band and a full trail at once is visually redundant.
- "Clear trail" action, near the existing "Drive the turn"/Stop control.

## Open questions

- ~~Should the preview (forward 50m) always render in trail mode, or only
  while actively driving?~~ Resolved: always-on whenever trail mode is on,
  parked or driving.
- Exact sample spacing and buffer cap are tuning, not architecture — pick
  defaults during implementation and adjust by eye.
- ~~The existing "Recenter" button teleports `pose` back to `{0,0,0}`...~~
  Resolved for v1: decoupled. Recenter doesn't touch the trail — it stays
  painted at its real-world position while the bus jumps back to origin.
  Revisit if that reads as confusing in practice.

## Non-goals for v1

- No compression/simplification of old trail geometry (e.g. Douglas-Peucker)
  — 1km² at ~0.2m sampling is a bounded, small point count; not worth the
  complexity yet.
- No *automatic* persistence across page reloads (matches the rest of the
  app today). The trail buffer is included in the explicit Save/Load file
  feature (see main CLAUDE.md, "Known rough edges") — `trailRef.current` is
  serialised verbatim into the save file and restored into the ref on load,
  bumping `trailVersion` to force a repaint.

## What shipped

- **Three bands, all "tyre corridor" style — not yet the tyre/overhang
  split** described above. Shipped: a drive-axle corridor (teal, sampled at
  chassis x = 0, reusing the existing off-tracking band's local half-width
  formula — `bandHalfWidth(Tw)`, matching the render's existing
  `bandHalfY`), a front-axle track (amber/`COL.front`, sampled at chassis
  x = Lfd), and a tag-axle track (coral/`COL.tag`, sampled at chassis
  x = -Ldt) — front and tag both via `singleAxleBandHalfWidth(Tw)`, same
  formula, neither axle being a dual pair. Same ribbon construction for all
  three, each offset along the chassis to its own axle so it traces where
  that axle itself has been, not just the drive axle. Front and drive
  visibly diverge once the bus turns (the "mowing the grass" effect); tag
  and drive stay close together for this vehicle's proportions (`Ldt` =
  1.4m is small relative to `Lfd` = 7m) — correct, not a rendering bug,
  verified by checking the underlying polygon point counts match across all
  three bands even where the tag band is visually subtle. None of the three
  account for that axle's own steer-angle widening (same accepted
  simplification as the live off-track band). Still not implemented: a
  differently-styled band for body-corner overhang (`mow1`/`mow2`/
  `tailSwing7`/`tailSwing8`) — the "nothing touched here, but the bus
  occupied this space" corridor described above.
- **Forward 50m preview**: implemented as a closed-form projection
  (`projectPosesForward`), not an iterative step loop — it solves the same
  unicycle model the drive loop integrates (`theta' = v/R`, `x' = v
  cos(theta)`, `y' = v sin(theta)`) directly for arc length `s`, giving an
  exact point on the current circle (or straight line) at any distance ahead
  without accumulating float error over many small steps. Recomputed fresh
  every render from live `pose`/`geom` — not stored in `trailRef` and not
  gated on `animating`, so it's visible whether parked or driving, per the
  "should probably be always-on" open question above. Same three axle bands
  as the cured trail (drive/front/tag), same edge-offset formulas
  (`bandHalfWidth`/`singleAxleBandHalfWidth`), just built from 41 projected
  points spanning `TRAIL_PREVIEW_LENGTH` (50m) instead of sampled history —
  rendered dashed and at half the cured trail's fill/stroke opacity so it
  reads as "if you hold this" rather than a record. Verified by hand at
  straight-ahead, mid-turn, and full lock (R≈5.9m at this vehicle's 50°
  max) — at full lock the 50m preview laps the turning circle more than
  once and renders as an overlapping spiral, which is correct (the
  projection doesn't stop at one revolution), not a bug. This is
  deliberately *not* the "rotation about the turn centre" pattern that's
  off-limits for the driven pose (see main CLAUDE.md) — that restriction is
  about not re-deriving the persisted position, which would break
  continuity every time the turn centre moves; this projection is disposable
  and recomputed from scratch each render, so it has nothing to stay
  continuous with.
- **History buffer**: `trailRef` (a `useRef` array of `{poseX, poseY, left,
  right, frontLeft, frontRight, tagLeft, tagRight}` world-space samples),
  appended inside the existing drive-loop `requestAnimationFrame` callback
  via `maybeSampleTrail()`, gated at 0.2m spacing (`TRAIL_MIN_SPACING`). A
  `trailVersion` counter is bumped every 5 samples to force a periodic
  re-render, since the ref itself doesn't trigger one — matches the
  "Implementation approach" section above. Getting a synchronous
  just-integrated pose into that sampler required replacing the drive
  loop's `setPose(prev => ...)` functional update with an explicit
  `poseRef` driven forward each tick and passed to `setPose` as a plain
  value — the functional-update form couldn't safely support a
  side-effecting sampler call (StrictMode double-invokes updater functions).
- **1km² bound**: implemented as `TRAIL_BOUND_HALF = 500`, i.e. `|pose.x| >
  500 || |pose.y| > 500` pauses recording (no wrap, no truncation) with a
  small "Trail paused — outside 1km² mapped area" indicator. Not yet
  exercised by hand at the boundary (would take a very long real-time drive
  to reach) — reviewed by code inspection only. The bound is now also drawn
  on the map itself: `mapBoundaryPoints()` renders the 1000×1000m square as
  a dashed outline (in trail mode only), world-anchored rather than
  chassis-relative like the other long-line reference geometry, since the
  bound doesn't move with the bus. A matching legend entry ("Mapped area
  boundary") appears alongside the other trail legend rows.
- **Boundary speed governor**: driving can no longer cross `TRAIL_BOUND_HALF`
  in trail mode — `boundaryPathDistance()`/`boundaryGovernorCapKmh()` cap the
  drive loop's `nextSpeed` to `sqrt(2·BRAKE_DECEL_INITIAL·d)` each frame,
  where `d` is the remaining path-distance to the boundary along the bus's
  current heading (not just axis-aligned distance). Deliberately a speed
  *ceiling*, not a forced-brake mode that seizes control: this sim has no
  reverse gear, so a hard stop that also blocked the throttle would strand
  the driver at the wall. A ceiling that's purely a function of live
  position/heading has nothing to release explicitly — steering away from
  the boundary relaxes it immediately. Uses the gentle end of the brake
  ramp (`BRAKE_DECEL_INITIAL`, not `BRAKE_DECEL_MAX`) so the assumed
  stopping distance is conservative, plus a small `BOUNDARY_GOVERNOR_MARGIN`
  buffer. A "Approaching mapped area limit — slowing" indicator (same style
  as the "Trail paused" one) shows whenever the clamp actually reduces speed
  that frame (not merely whenever the heading is generally aimed at a wall,
  which would also light up for a bus simply parked facing the boundary).
  Uses the same `pose.x/y` reference point as the recording-pause check
  above, not the full body footprint.
- **Controls**: "Trail" toggle and "Clear" button added to the existing
  bottom-centre display-toggle row (alongside Off-track/Construction/
  Dimensions); a trail legend entry appears in the top-right panel when
  trail mode is on. Trail is cleared automatically on vehicle-dimension
  changes (same trigger that already resets `pose`).
- **Per-frame render cost**: the three axle-track ribbons and the body hull
  path were originally rebuilt straight from `trailSamples` in the render
  body. Since `pose` (and the view that tracks it) updates every RAF tick
  while driving, not just when a new sample lands, this meant redoing an
  O(n) pass — for the body hull, an O(n) convex-hull recompute with a fresh
  path string — on every frame, with cost scaling with trail length (the
  reported slowdown on long trails). Fixed by memoizing the *world-space*
  vertex/hull data on `trailVersion` (only changes every
  `TRAIL_RENDER_EVERY` samples): the ribbons cache the raw world points,
  the body band caches actual hull results. Per frame, only a cheap
  `toScreen` projection of that cached data re-runs, since the camera
  itself can still move every frame. This relies on convex hull commuting
  with any invertible affine map — `hull(toScreen(pts))` and
  `toScreen(hull(pts))` trace the same polygon — so caching hulls in world
  space and re-projecting them is equivalent to the original screen-space
  computation, just far cheaper. The live "cap" hull (last sample → current
  pose) is still computed fresh every frame (cheap, O(1)) but now also in
  world space first, so its winding direction matches the cached hulls
  exactly.
