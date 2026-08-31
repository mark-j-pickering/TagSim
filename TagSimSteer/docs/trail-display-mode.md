# Design note: Trail display mode

Status: v1 landed in `tag-steering-simulator.jsx` — history buffer and a
single-band ribbon (the "Trail" toggle). The forward 50m preview and the
tyre/overhang colour split described below are not implemented yet; see
"What shipped in v1" at the bottom.

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

- Should the preview (forward 50m) always render in trail mode, or only
  while actively driving? Static/parked with no trail yet, it's the only
  useful content, so probably always-on.
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
- No persistence across page reloads (matches the rest of the app today).

## What shipped in v1

- **Two bands, both "tyre corridor" style — not yet the tyre/overhang split**
  described above. Shipped: a drive-axle corridor (teal, sampled at chassis
  x = 0, reusing the existing off-tracking band's local half-width formula —
  `bandHalfWidth(Tw)`, matching the render's existing `bandHalfY`) and a
  front-axle track (amber/`COL.front`, sampled at chassis x = Lfd via
  `frontBandHalfWidth(Tw)`) — same construction, offset forward along the
  chassis so it traces where the front axle itself has been, not just the
  drive axle. The two visibly diverge once the bus turns, which is the same
  effect the "mowing the grass" readouts describe. Neither band accounts for
  the front wheel's own steer-angle widening (same accepted simplification
  as the live off-track band). Still not implemented: a third,
  differently-styled band for body-corner overhang (`mow1`/`mow2`/
  `tailSwing7`/`tailSwing8`) — the "nothing touched here, but the bus
  occupied this space" corridor described above — and a tag-axle band.
- **No forward 50m preview yet** — trail mode currently only paints the
  cured (historical) corridors. Adding the ahead-of-the-bus projection is
  the natural next increment.
- **History buffer**: `trailRef` (a `useRef` array of `{poseX, poseY, left,
  right, frontLeft, frontRight}` world-space samples), appended inside the
  existing drive-loop `requestAnimationFrame` callback via
  `maybeSampleTrail()`, gated at 0.2m spacing (`TRAIL_MIN_SPACING`). A
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
  to reach) — reviewed by code inspection only.
- **Controls**: "Trail" toggle and "Clear" button added to the existing
  bottom-centre display-toggle row (alongside Off-track/Construction/
  Dimensions); a trail legend entry appears in the top-right panel when
  trail mode is on. Trail is cleared automatically on vehicle-dimension
  changes (same trigger that already resets `pose`).
