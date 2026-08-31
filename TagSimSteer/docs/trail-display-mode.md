# Design note: Trail display mode

Status: proposed, not implemented. No code yet — this is scoping for a future
change to `tag-steering-simulator.jsx`.

## Summary

A new display mode that paints a persistent record of where the bus has
actually driven, rather than (or alongside) the existing single-instant
turning-circle overlay. Two zones, split at the bus's current position:

- **Cured trail** (behind/at the bus): the real swept corridor, built from
  accumulated pose history as the user drives.
- **Preview** (ahead of the bus): a ~50m projection of the swept corridor if
  the current steering angle is held, so the driver has a guide for what's
  coming.

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

## Non-goals for v1

- No compression/simplification of old trail geometry (e.g. Douglas-Peucker)
  — 1km² at ~0.2m sampling is a bounded, small point count; not worth the
  complexity yet.
- No persistence across page reloads (matches the rest of the app today).
