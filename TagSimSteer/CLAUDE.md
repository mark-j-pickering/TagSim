# Bus Steering Simulator — Project Notes

## What this is

An interactive plan-view (top-down) simulator of a 3-axle rigid bus: front axle
steers, drive axle is fixed (the pivot reference), tag axle counter-steers. It
visualises Ackermann-style steering geometry, swept turning paths, off-tracking,
tail swing, and front-overhang "mowing the grass" for a tag-axle bus — modelled
loosely on Brisbane City Council's Volvo/Scania 6x2 tag-axle fleet.

Single file: `tag-steering-simulator.jsx` — a self-contained React component
(default export, no required props), originally built and iterated as a
Claude.ai artifact. It was published from claude.ai and is being transferred
here for further development in Claude Code.

**Read the whole file before making changes.** It's ~830 lines but it's one
component with a handful of module-level helper functions — there's no other
project structure to discover.

## Running it

This was built under claude.ai's artifact constraints (no React Router, no
external npm installs beyond a fixed allowlist, Tailwind core utilities only,
no `localStorage`/`sessionStorage`). None of those constraints apply here —
feel free to relax them (e.g. move inline styles to a proper Tailwind/CSS
setup, add localStorage persistence for the geometry sliders) if that's useful,
but be aware the current code deliberately avoids all of the above, so don't
assume it needs to stay that way.

To run standalone: drop the component into any Vite/CRA/Next React app,
`import BusSteeringSimulator from './tag-steering-simulator'`, render it. It
imports only `react` (useState/useEffect/useRef/useMemo). The Google Fonts
`@import` (Barlow Condensed, Space Mono) is inlined via a `<style>` tag inside
the component.

## Domain model — the physics

Standard 3-axle steady-state cornering kinematics (bicycle-model extended to a
third axle), **not** a dynamic/slip model — no tyre forces, no inertia, no
speed-dependent understeer. This is deliberate; the project is about geometry
and swept paths, not vehicle dynamics.

- **Chassis-local coordinate frame**: `x` = forward, `y` = left (nearside
  positive, offside negative). This convention is used *everywhere* — every
  geometry function takes/returns points in this frame unless explicitly
  transformed to world or screen space.
- **Drive axle is the pivot**: it's the only axle guaranteed not to steer, so
  the instantaneous turn centre `C` always lies on the line through it,
  perpendicular to the chassis centreline: `C = (0, R)` in chassis-local
  coordinates, where `R = Lfd / tan(deltaF)` (`Lfd` = front-to-drive
  wheelbase, `deltaF` = front steer angle in radians).
- **Tag axle steering**: computed from the same turn centre —
  `idealDeltaT = -atan(Ldt / R)`. A `tagRatio` slider scales this from ideal
  (1.0) down toward locked-straight (0), and a speed-based lockout forces it
  to 0 above a threshold speed (real tag axles lock out at speed for
  stability). The gap between ideal and applied angle is exposed as
  `scrubDeg` — how much the tyre would have to scrub sideways if not
  perfectly steered.
- **`isStraight` is `deltaFdeg === 0` exactly.** This was a real bug fixed
  during development — an earlier version treated anything under ~3° as
  "straight" and lost all curvature calculation for small angles. Don't
  reintroduce a tolerance here; the fine-grained steering slider (see below)
  exists specifically so users can dial in very small, very-large-radius
  turns without the model silently rounding them to infinite radius.
- **Straight-line equivalents**: every circular reference feature (swept
  paths, the off-tracking band, tail-swing line) degenerates into a straight
  line/band at `deltaFdeg === 0`, since a circle around a point at infinity
  *is* a straight line. This is handled as an explicit parallel code path in
  the render (see "straight-case" comments), not a special-cased absence of
  those features.

## Wheel numbering convention (load-bearing — don't renumber)

```
1, 2   = front axle (nearside, offside) — steer
3, 4   = drive axle nearside dual pair — 3 is leftmost/outermost, 4 is inboard
5, 6   = drive axle offside dual pair  — 5 is inboard, 6 is rightmost/outermost
7, 8   = tag axle (nearside, offside) — counter-steer
```

**Odd = nearside = left. Even = offside = right.** This holds everywhere:
label placement, colour coding, dimension-line references. Wheels 3 and 6 are
treated as "hero" wheels throughout (bolder path circles, bigger badges) —
they're the outermost points of the drive axle and the ones most relevant to
off-tracking.

All 8 wheels render at the same physical size now (`WHEEL_HALF_LEN`/
`WHEEL_HALF_W`) — there was an earlier version with narrower dual-specific
tyre dimensions (`DUAL_HALF_LEN`/`DUAL_HALF_W`), which is now dead code left
in place (harmless, just unused). Feel free to remove it.

## Coordinate pipeline (chassis → world → screen)

1. **Chassis-local** (`{x, y}`): fixed geometry relative to the vehicle body,
   e.g. `geom.bodyCorners.FL`, `geom.wheelCenters.frontL`.
2. **World** via `poseTransform(point, pose)`: `pose = {x, y, theta}` is the
   vehicle's live position/heading, integrated continuously (dead-reckoning,
   Euler integration each animation frame — see the "Drive the turn" effect).
   This is the load-bearing design decision that makes steering changes feel
   continuous: **position is never reset when you change steering, tag ratio,
   or lockout** — only when the physical vehicle dimensions change (a
   different-size bus invalidates the old pose). Re-deriving position from
   "rotation about the current turn centre" was tried and abandoned — it broke
   continuity every time the turn centre moved (i.e. every steering input).
3. **Screen** via `toScreen(view, worldPoint)`, where `view = {scale,
   originX, originY}` is produced by `computeView()` / `computeEffectiveView()`.

## Two view modes + auto-blend + transition animation

- **Circle-centric**: auto-fits the whole swept circle, camera locked exactly
  on the turn centre every frame (no smoothing/lag — this was explicitly
  requested after an earlier version added continuous exponential smoothing
  that caused visible drift while turning).
- **Bus-centric**: fixed scale (vehicle length ≈ ⅓ × 1.2 of the map height),
  camera follows the vehicle position.
- **Auto-blend near straight-ahead**: below ±3° steering, the camera
  continuously blends toward bus-centric (a circle-centric view of a near-
  infinite radius isn't useful). This is a pure function of steering angle,
  not a time-based animation — see `computeEffectiveView()`.
- **Manual mode switch (the Bus/Circle toggle, bottom-left of the map)** is
  the *only* thing that gets an explicit animated pan: a 450ms eased
  (ease-in-out-cubic) blend between the old and new framing, recomputed live
  each frame from current pose/geom so it stays correct mid-turn or
  mid-animation. See `transition`/`transitionT` state and `TRANSITION_MS`.
  **Do not** reintroduce continuous per-frame smoothing for the steady state
  — that was tried and explicitly reverted because it breaks "circle centre
  stays exactly centred."

## Steering input resolution (non-uniform, deliberately)

`STEER_STEPS` (module-level, built once) is **not** a uniform step — it's
0.15° resolution from −3° to 3°, then 0.5° steps out to full lock (±38°).
This went through several iterations (0.25° → 0.1° → skip-first-two-steps →
0.2° → 0.15°) chasing a "something going on" floating-point complaint; the
current implementation builds fine values via integer arithmetic
(`Math.round(i * 15) / 100`) rather than repeated float division specifically
to avoid drift. If you touch this, keep values exact/clean and verify with a
quick Node script (ascending, no duplicates, clean `toFixed(2)` output) before
shipping — this bit us twice during development.

`SteppedSlider` maps a `<input type=range>`'s integer index onto
`STEER_STEPS` via `closestSteerIndex()`; the underlying app state
(`steerInput`) always stores the real angle value, not an index.

**Sign convention**: the UI-facing `steerInput` state is *inverted* relative
to the geometry angle — `deltaFdeg = -steerInput` — so that dragging the
slider right steers the bus right, which was a deliberate late fix (the raw
geometry angle has the opposite, more "mathematical" sign convention: positive
= steer toward nearside). Don't remove this indirection.

## Key metrics reported (all in `computeGeometry`'s return value)

- `R`, `turningDiameter`, `outerRadius` — basic turning-circle numbers.
- `offTracking` — the drive axle's own swept width, `|radii.w3 - radii.w6|`.
- `mow1` / `mow2` — **"mowing the grass"**: how far each front body corner
  (FL/FR) swings past its *own* wheel's path (wheel 1 or 2 respectively).
  Positive means the nose cuts in beyond where that wheel tracks. This is
  local terminology from the person driving these buses for real — keep the
  label as-is.
- `tailSwing7` / `tailSwing8` — how far each rear body corner (RL/RR) sits
  from its *own same-side* tag wheel's path (7 = nearside, 8 = offside).
  Whichever side is currently on the outside of the curve reads as the
  meaningful "swing" figure; the other reads the inside corner's tuck-in.
  This was iterated a few times (first against wheels 3/4, then corrected to
  7/8) — 7/8 (tag axle) is the current, intentional choice.
- `scrubDeg` — tag axle scrub angle when ratio < 1 or speed-locked.

Dimension lines for `mow1/mow2/tailSwing7/tailSwing8` are drawn radially
(perpendicular to each wheel's arc, since a circle's radius is perpendicular
to its tangent) via `radialDimWorldPoints()` + `<DimLine>`, gated behind the
"Construction & dim lines" toggle (`showGeom` state).

## Visual language / colour coding

`COL` (module-level) is the single source of truth for the blueprint-style
dark theme. Notable mappings:
- `COL.front` (amber) = front axle / wheels 1,2 / mowing-the-grass lines
- `COL.drive` (grey) = drive axle 3–6 (fixed, non-steering)
- `COL.tag` (coral) = tag axle 7,8
- `COL.w3` (lime) / `COL.w6` (violet) = the two "hero" drive-axle wheel path
  circles
- `COL.tailSwing` (amber/gold, `#ffd166`) = tail-swing reference line +
  tailSwing7/8 dimension lines
- `COL.pathOuter` (cyan) / `COL.pathInner` (coral, reused from `COL.tag`) =
  faint general reference rings (overall envelope, tag-inner path)

The shaded "pavement" band (off-tracking corridor) spans from the drive
axle's tighter wheel (3 or 6, whichever) out to the front axle's outer wheel
(1 or 2) — see the `showBand` toggle and the annulus/`longBandPoints` render
branches (circular vs straight-line versions).

## Layout structure

- Legend split into two overlay panels, top-left (nearside-associated) and
  top-right (offside-associated), directly on the map canvas.
- Floating "Drive the turn" / Stop button, bottom-right of the map.
- Bus/Circle toggle, bottom-left of the map.
- Below the map: always-visible "Steering & throttle" section, then a
  collapsible "Radius grid" (readouts), then a collapsible "Advanced
  settings" (tag ratio, lockout, vehicle geometry sliders, display toggles).
- The whole map wrapper has `overflow: hidden` + CSS `contain: layout paint`,
  and the SVG content is wrapped in an actual `clipPath` (not just CSS
  `overflow: hidden` on the `<svg>`) — this was needed because the
  straight-road/band lines extend ±1000m in world space and were, at some
  zoom levels, affecting the *page's* scroll bounds, not just the SVG's
  visible area. If you add more far-extending geometry, make sure it stays
  inside the `<g clipPath="url(#mapClip)">` group.

## Known rough edges / things not yet done

- `DUAL_HALF_LEN`/`DUAL_HALF_W` are now dead code (see wheel numbering
  section above).
- The `innerDriveRadius` local variable in `computeGeometry` is computed but
  unused (leftover from an earlier version of the off-tracking calc).
- No persistence — refreshing the page resets everything to defaults. Would
  be a reasonable thing to add now that we're off the artifact platform
  (localStorage was off-limits there).
- Vehicle geometry defaults (`Lfd=6.0, Ldt=2.3, Fo=2.6, Ro=1.9, Wb=2.55,
  Tw=2.1`) are an illustrative approximation of a ~12.8m tag-axle bus, not
  a confirmed spec for any specific real vehicle — the person using this
  drives BCC Volvo/Scania 6x2 tag-axle buses but we never got exact
  compliance-plate figures, so these are adjustable estimates, clearly
  labelled as such in the UI copy. Don't present them as authoritative.
