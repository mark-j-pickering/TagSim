# Bus Steering Simulator — Project Notes

## What this is

An interactive plan-view (top-down) simulator of a 3-axle rigid bus: front axle
steers, drive axle is fixed (the pivot reference), tag axle counter-steers. It
visualises Ackermann-style steering geometry, swept turning paths, off-tracking,
tail swing, and front-overhang "mowing the grass" for a tag-axle bus — modelled
loosely on Brisbane City Council's Volvo/Scania 6x2 tag-axle fleet.

Mainly one file: `tag-steering-simulator.jsx` — a React component (default
export, no required props), originally built and iterated as a Claude.ai
artifact. It was published from claude.ai and is being transferred here for
further development in Claude Code. It also imports one asset,
`bcc-tag-bus-5054.png` (see "Running it" below) — no longer a fully
self-contained single file.

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
imports `react` (useState/useEffect/useRef/useMemo) plus one local asset,
`bcc-tag-bus-5054.png` (a reference photo of the real bus, fleet #5054, with
its confirmed axle dimensions annotated — shown in the side panel below the
steering/throttle controls) — that PNG (~900KB) must be copied alongside the
`.jsx` file for the import to resolve; it's the one thing keeping this from
being a true single-file drop-in. The Google Fonts `@import` (Barlow
Condensed, Space Mono) is inlined via a `<style>` tag inside the component.

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

## Steering input resolution and rate limiting

`STEER_STEPS` (module-level, built once) is a uniform 0.5° step from −50° to
50° (the confirmed max front steer angle for this vehicle), built via integer
arithmetic (`Math.round(i * 5) / 10`) rather than repeated float addition to
avoid drift — same lesson as the fine-resolution version that used to live
here. An earlier version used non-uniform resolution (fine near
straight-ahead, coarse toward lock) to avoid collapsing small angles to
"straight"; that's no longer needed now that `isStraight` is still
`deltaFdeg === 0` exactly and steering changes are rate-limited/ramped anyway
(see below), so a uniform step is fine everywhere.

`SteppedSlider` maps a `<input type=range>`'s integer index onto
`STEER_STEPS` via `closestSteerIndex()`; the underlying app state
(`steerInput`) always stores the real angle value, not an index.

Keyboard steering has two speeds: plain ←/→ nudge one `STEER_STEPS` entry
(0.5°) at a time; Shift+←/→ jumps by `QUARTER_TURN_STEER_DEG` (5°) instead —
approximating a quarter *physical* turn of the wheel (90° of hand rotation),
for winding on a chunk of lock quickly without reaching for the mouse. Not
the naive `90 / STEERING_WHEEL_RATIO` (=6.25°): `STEERING_WHEEL_RATIO` is
only the *average* ratio across the full sweep, but the rack is deliberately
geared slower than that near dead-centre (`steerRampRate`, further up) —
exactly where this key mostly gets used — so the average-ratio figure
overshoots a real quarter turn there. 5° is a closer approximation for that
near-centre case. It's also, deliberately, a whole degree: a fractional value
like 6.25° sits exactly halfway between two `STEER_STEPS` entries, so
`closestSteerIndex()`'s tie-break (first-found-smallest, scanning the steps
ascending) picks a *different* neighbour depending on nudge direction —
+6.25 lands on 6.0°, -6.25 lands on -6.5° — making a left nudge and a right
nudge unequal. A whole-degree value is itself an exact `STEER_STEPS`
multiple, so added to any on-grid `steerInput` it lands exactly on-grid
again with no tie to break, left and right symmetric. `End` sets
`steerInput` straight to 0 — identical to clicking the "Straight" button,
just from the keyboard.

**Sign convention**: the UI-facing `steerInput` state is *inverted* relative
to the geometry angle — `deltaFdeg = -appliedSteerInput` — so that dragging
the slider right steers the bus right, which was a deliberate late fix (the
raw geometry angle has the opposite, more "mathematical" sign convention:
positive = steer toward nearside). Don't remove this indirection.

**`steerInput` is a target, not the applied angle.** The slider, arrow keys,
and the "Full lock left/right"/"Straight" buttons all just move `steerInput`;
a separate `appliedSteerInput` (state + `appliedSteerRef` for the imperative
loop) chases it every frame, capped by `steerRampRate()`, and it's
`appliedSteerInput` that feeds `deltaFdeg`/`computeGeometry` and the
`SteeringWheel` graphic. This models the time it physically takes to wind the
steering wheel — `LOCK_TO_LOCK_SECONDS` (4s) is the minimum time a full
lock-to-lock sweep takes at max input speed, deliberately independent of
vehicle speed (turning the wheel while parked still takes time).

The rate is **progressive, not constant**: `steerRampRate(absAngleDeg)`
returns a slower deg/s near dead-centre and a faster one near full lock
(`STEER_RATE_RATIO`, currently 2×), matching how a real variable-ratio rack is
geared slower near centre for stability and quicker near lock for
manoeuvrability. `STEER_MIN_RATE`/`STEER_MAX_RATE` are solved analytically
from `LOCK_TO_LOCK_SECONDS` and `STEER_RATE_RATIO` (see the comment above
`STEER_STEPS`), not hand-tuned, so changing either constant keeps the overall
lock-to-lock time correct. The ramp loop (a `useEffect` keyed on `steerInput`,
separate from the drive/pose loop) always uses the rate at the *current*
angle, not the target — so a sweep that passes through centre visibly slows
down there, same as the real thing.

The decorative `SteeringWheel` graphic's rotation (`wheelRotationDeg()`) is
derived from the same progressive rate profile via a closed-form integral,
rather than a flat multiplier — `STEERING_WHEEL_RATIO` (14.4, ~4 turns
lock-to-lock) is kept only as the *average* ratio, used to derive the assumed
constant physical hand-turning speed. Don't reintroduce a flat
`angleDeg * STEERING_WHEEL_RATIO` transform here; it would visually disagree
with the rate limit driving the actual front wheels.

## Driving controls: throttle, brake, horn, handbrake sounds

Speed is no longer a directly-set value (there used to be a draggable "Throttle" slider and a
"Drive the turn" button that just snapped speed to a flat 12km/h). It's now simulated every frame
from held-key state, via the same imperative drive loop that already did pose integration:

- **↑ / ↓ = throttle / brake**, tracked as plain refs (`throttleHeldRef`/`brakeHeldRef`), not React
  state — they change many times a second while held and never need to cause a render themselves,
  only the derived `speed` does. Handled in the same keydown/keyup effect as the existing ←/→
  steering-nudge keys (window-level listeners, ignored while an `INPUT`/`TEXTAREA` has focus).
- **Acceleration** (`throttleAccel`) is power-limited, not constant-force: strong low-speed pull
  tapering off toward `MAX_SPEED_KMH` (90), to a confirmed 0-90km/h in exactly `ZERO_TO_MAX_SECONDS`
  (25s). `THROTTLE_ACCEL_LOW`/`HIGH` aren't hand-tuned — they're solved analytically from that
  target and a chosen low/high ratio (`THROTTLE_ACCEL_RATIO`), the same closed-form technique
  `STEER_MIN_RATE`/`STEER_MAX_RATE` use for the steering ramp (see the comment above
  `THROTTLE_ACCEL_HIGH`). Changing `MAX_SPEED_KMH`, `ZERO_TO_MAX_SECONDS`, or the ratio keeps the
  0-90 time exact — don't hand-edit the accel constants directly.
- **Braking** (`brakeDecel`) ramps up the longer it's held — gentle service braking at first,
  firming to a hard-but-controlled stop over `BRAKE_RAMP_SECONDS`, via `brakeHeldSinceRef` (a
  timestamp reset every time the key transitions from up to down, not on OS key-repeat). Models a
  driver leaning harder on the pedal the longer a stop is taking, not a permanent soft brake or an
  instant panic stop.
- **No key held = coast at constant speed.** Rolling resistance/engine braking isn't modelled —
  consistent with the rest of the sim's steady-state-only physics (see "Domain model" above).
- **Space = horn**, played on loop while held (`hornAudioRef`) and stopped on keyup. `e.preventDefault()`
  on the Space keydown is load-bearing, not just for scroll: it also suppresses the browser's
  native "Space activates the focused button" behaviour, which would otherwise double as an
  unwanted click on whichever toggle button (Bus/Circle, Off-track, Construction, etc.) last had
  focus.
- **Handbrake sound effects** are driven by an effect keyed on `atRest` (`speed === 0`), not on
  `speed` directly — that boolean only flips on an actual rest/moving transition, so the effect
  doesn't re-run on every fractional-km/h change while driving. Coming to rest arms a
  `HANDBRAKE_ENGAGE_DELAY_MS` (2s) timer; if the bus pulls away again before it fires, the timer is
  cancelled (cleanup) and no sound plays at all — the handbrake was never actually set. If it does
  fire, `handbrakeEngagedRef` flips on and the engage sound plays; pulling away after that plays
  the release sound and clears the flag.
- **A window `blur` handler releases every held key/sound state.** Alt-tabbing away mid-keypress
  never delivers a `keyup`; without this the bus could keep silently accelerating, braking, or
  honking in the background.
- **The floating "Drive the turn"/"Stop" button is a convenience wrapper around the same physics,
  not a separate speed control.** Clicking it while stopped sets `driveToTargetRef.current =
  DRIVE_THE_TURN_TARGET_KMH` (10) — the drive loop then accelerates toward that target exactly as
  if ↑ were held, clamping to it and clearing the ref once reached, rather than snapping speed
  there instantly. Braking always clears `driveToTargetRef` (braking should win over any pending
  auto-ramp). While moving, the same button becomes an instant "■ Stop" (`setSpeed(0)`, no ramp —
  a deliberate asymmetry with the throttle side, since a one-click panic stop is the point) —
  **and Stop's onClick must also clear `driveToTargetRef.current` itself**, not just call
  `setSpeed(0)`. This was a real bug: clicking Stop before a "Drive the turn" ramp had reached its
  target zeroed `speed` but left the ref pointed at 10, so the very next drive-loop frame saw the
  still-pending target and immediately re-accelerated — the bus never actually reached a stable
  rest, so the handbrake sound effects (which only fire after 2s continuously at rest, see above)
  silently never triggered when driven from the buttons rather than the keyboard.

**The drive loop now runs continuously from mount, not just while `speed > 0`.** It used to bail
out entirely when not "animating"; now it has to keep watching for a throttle press even while
sitting at rest, so it can't stop. Two consequences, both load-bearing:
- It skips the `setPose`/trail-sampling work while genuinely idle (`speed === 0` and neither pedal
  held), so an idle bus doesn't force a render on every animation frame — only the cheap
  held-key/speed check runs.
- Anything that resets `pose` from *outside* the loop (Recenter, Load, the vehicle-dimension-change
  reset effect) must also reset `poseRef.current` directly, in the same place. Previously this
  didn't matter — the loop only started once "Drive the turn" was pressed, and resynced `poseRef`
  from `pose` at that point. Now the loop is always running, so if you add another spot that resets
  `pose` and forget `poseRef`, the very next animation frame will silently overwrite the reset with
  the loop's own stale last-known pose.

**Sound files aren't part of this repo.** `SOUND_HORN`/`SOUND_HANDBRAKE_ON`/`SOUND_HANDBRAKE_RELEASE`
point at `sounds/horn.mp3`, `sounds/handbrake-on.mp3`, `sounds/handbrake-release.mp3` under
`import.meta.env.BASE_URL` — plain runtime paths (not bundled ES imports, unlike the bus
photo/steering wheel image) so a missing file just 404s instead of breaking the build;
`playSound()`/`startHorn()` swallow the resulting rejected `play()` promise. Drop real recordings
into `public/sounds/` (see the README there) using those exact names. MP3 was picked as the
suggested format for short SFX like these — small, universally supported — but any browser-playable
format works since nothing transcodes them.

**The `BASE_URL` prefix is load-bearing, not decoration — don't go back to a bare
`"/sounds/..."`.** This app is deployed to GitHub Pages under a subpath (`vite.config.js` sets
`base` to `/TagSim/` when `GITHUB_ACTIONS` is set); a leading-slash path resolves against the
*domain* root regardless of that subpath, so it 404s on the deployed site even though the exact
same code works fine in local dev (where `base` is `/`, so the two happen to coincide) — this was a
real bug caught by testing the live deployment, not just local dev. `import.meta.env.BASE_URL` is
Vite's own always-correct-for-the-current-build answer to "what's the base path," and already ends
in a trailing slash, hence no leading slash on the `"sounds/..."` half.

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
- Side panel (beside the map, its rendered height also drives the map's
  height — see "Map sizing" in the component): always-visible "Radius grid"
  readouts, then a collapsible "Driver controls" (keyboard shortcut list,
  closed by default — collapsed on load so the panel fits a laptop screen
  without scrolling, and not needed at a glance on a touchscreen), then
  always-visible "Steering & throttle" and the bus reference photo. Below
  the map+panel row: a collapsible "Advanced settings" (tag ratio, lockout,
  vehicle geometry sliders, display toggles), closed by default.
- The header + map/side-panel row is deliberately sized to fit inside a
  touchscreen laptop's *browser viewport*, not its screen resolution —
  those aren't the same thing. A 2736×1824 Surface-class panel at Windows'
  default 200% scaling only gives the browser a ~1368×912 logical viewport,
  and the tab strip/address bar/taskbar eat a further ~150-180px of that
  before any page content is visible. Budget against the post-chrome
  number, not the raw viewport height, or a "fits on screen" layout will
  still scroll in practice. (Verified: current build measures ~730px for
  header+row, leaving headroom under a ~912px logical viewport even with
  chrome subtracted.)
- The whole map wrapper has `overflow: hidden` + CSS `contain: layout paint`,
  and the SVG content is wrapped in an actual `clipPath` (not just CSS
  `overflow: hidden` on the `<svg>`) — this was needed because the
  straight-road/band lines extend ±1000m in world space and were, at some
  zoom levels, affecting the *page's* scroll bounds, not just the SVG's
  visible area. If you add more far-extending geometry, make sure it stays
  inside the `<g clipPath="url(#mapClip)">` group.

## Imported site drawings (map background)

"Import Drawing" (header toolbar, beside Save/Load) loads an SVG **or DXF**
file as a scaled background layer under the vehicle/trail, so a driver can
rehearse against a real site layout (depot lanes, a specific junction, etc.)
instead of the abstract grid. Deliberately narrow scope, arrived at after
discussion ruled out several bigger options, and extended once with real
external files (a SignMaster export, then its source DXF) that exposed real
gaps in the first pass:

`docs/example-site-plans/depot-exit.svg` is a worked example to load and
drive against — a depot driveway meeting a public road (kerbs, footpaths, a
give-way line, a labelled shed), drawn at the 1-unit-=-1mm convention below.
The sim's world origin (where the bus starts) lands at the drawing's
viewBox centre, a few metres inside the driveway from the road. Verified by
importing it and driving out through a right turn onto the road in a real
browser session — not just a scale/orientation sanity check.

- **No parameterised scenario library** (tabs for "slip lane"/"roundabout"/
  etc., each generating its own road geometry) — considered and rejected in
  favour of importing pre-drawn site plans instead of modelling road shapes
  parametrically. `src/course.js`'s single-corner course generator (used by
  the ML training pipeline, see "Porting to 3D / C#" below and
  `src/env.js`) is unrelated to this and untouched.
- **No real-world geo-referenced basemap** (map tiles, lat/lon projection) —
  the world frame stays plain metres with no geographic anchor; "real-world"
  here just means "drawn to scale," not "at a real location."
- **No click-and-measure calibration UI** — no click-two-points-and-enter-
  a-distance step, no rotation, no manual origin placement. Every import
  uses one fixed convention: **an SVG or DXF file's own coordinate units are
  always millimetres** (`SVG_MM_TO_M`) — a drawing's real-world size is read
  directly from its own numbers, no per-file input needed. (An earlier
  version offered a second mil/1000in convention too, for sign-cutting/
  vinyl/CNC software that sometimes emits coordinates in that unit — found
  via a real SignMaster export, but dropped again once it turned out not to
  be needed in practice; its `SVG_UNIT_TO_M` entry is recoverable from git
  history if that changes.)
- Both formats place their content with a plain translate + uniform scale,
  not a general affine transform — content is centred on world (0,0), and
  its own "up"/"right" render as screen up/right (same axes the grid/trail
  already use — see `toScreen`), matching how the file looks opened in any
  normal viewer, just correctly proportioned and drivable over.
- **SVG**: the file's own markup is inlined via `dangerouslySetInnerHTML`
  into a `<g>` in the map's own coordinate space (see `handleLoadMapImage`),
  not rendered as a rasterised `<image>` — keeps it crisp at any zoom level.
  Its scale is re-derived live every render from `SVG_MM_TO_M` and the
  current view, since the untouched foreign markup can't be pre-transformed.
- **DXF**: has no native web rendering to lean on the way SVG's markup does,
  so `src/dxfImport.js` parses it into plain world-space shape objects once
  at import time (unit conversion already baked into their coordinates), and
  the component renders those as ordinary `<path>`/`<circle>` elements
  through the very same `toScreen()` pipeline as every other piece of map
  geometry — not a second rendering mechanism. Supported entities: `LINE`,
  `ARC`, `CIRCLE`, `LWPOLYLINE` (straight and bulge/arc segments, open or
  closed), and `HATCH` limited to solid fill with either a single
  polyline-type boundary loop or an edge-type loop made only of line/arc
  edges (the common "fill this closed shape" case) — colour resolved from
  the entity's own true-colour (group 420) or ACI colour (group 62), falling
  back to its **layer's** true-colour or ACI colour from `TABLES`/`LAYER`
  (in that order — a layer can carry both, same as an entity can;
  `ACI_RGB_EXACT` only has exact RGB for the 9 standard low indices everyone
  actually draws with, index 10-255 gets a deterministic grey fallback
  rather than a guessed-from-memory "exact" value, since the full AutoCAD
  palette isn't safe to reproduce without risking silently-wrong colours —
  reading the layer's true-colour too, not just entity-level, matters a lot
  here: a real DXF with every `HATCH` fill `BYLAYER` and each layer's real
  colour only in group 420 rendered every region an arbitrary unrelated
  grey until this was fixed, found by comparing a real import against the
  drawing's own reference screenshot). `SPLINE` edges/entities,
  multi-loop/island `HATCH`, 3D entities, and the older `POLYLINE`/`VERTEX`
  pre-LWPOLYLINE form are skipped with a `console.warn` rather than
  mis-rendered — not a general CAD-file renderer, just enough for
  site-plan-style drawings.
  - **Colouring adjacent regions without retracing shared edges —
    polygonization**: a raw `LINE` is only an edge with no "inside," so two
    ways to get a coloured region: (1) draw it as its own closed
    `LWPOLYLINE`/`HATCH` (simplest, but means retracing any edge shared with
    a neighbour), or (2) draw the shared edge network **once** — e.g. a road
    outline plus lane dividers, each line drawn only once — and drop a
    `POINT` or `TEXT`/`MTEXT` entity inside each region, coloured however
    that region should be filled. `polygonizeFaces()` treats the LINE/ARC
    network as a planar graph and traces every enclosed loop (the same core
    technique as PostGIS's `ST_Polygonize`/Shapely's `polygonize`: at each
    vertex, always continue along whichever edge is immediately clockwise
    from the direction just arrived from), keeping only loops with positive
    signed area (the bounded interior faces; the one unbounded "outer" face
    per connected network comes out negative) that have a marker inside
    them — an unmarked face contributes nothing, since its edges already
    render individually as plain line/arc shapes, so files with no markers
    pay no cost here. **Requires real shared vertices at junctions** — e.g.
    a lane divider's endpoint must land exactly on a vertex of the boundary
    it meets (split the boundary there, using your CAD tool's endpoint
    snap), not partway along an unsplit line (a "T" against an edge's
    interior isn't detected; this deliberately doesn't do general
    segment-intersection splitting, only vertex-snapped adjacency,
    `SNAP_TOL_M` = 1mm). `POINT`/`TEXT`/`MTEXT` are never drawn as their own
    visible shape — they're markers only.
  - **A `TEXT`/`MTEXT` marker's own text, if it looks like a colour (a hex
    code, or a plain word passed straight through as a CSS colour keyword —
    `colorFromLabelText`), overrides its resolved DXF colour.** Exists
    because whether a CAD tool makes assigning an arbitrary colour to one
    entity easy varies a lot — Onshape's own DXF layers, in testing, looked
    like its fixed internal categories (sketch geometry, dimension lines,
    etc.), not anything hand-picked — but typing a label always works,
    everywhere. A label that doesn't look like a colour (e.g. "LANE3") just
    falls back to the entity's/layer's own resolved colour as normal, so
    plain documentation labels are harmless.
  - **Starting the bus somewhere specific**: a `LINE` on a layer named
    `BUS_START` (case-insensitive; first one found wins if there are
    several) sets the vehicle's starting pose instead of being drawn — its
    first point is the position, its direction (first point -> second
    point) is the heading. `handleLoadMapImage` applies it the same way
    `applySaveData` applies a Load: reset `pose`/`poseRef`, stop (`speed`
    0), and clear the trail — a new starting context, not just a background
    swap.
  - Arc/bulge sweep and large-arc-flag (for rendering) are derived from 3
    already-known points on the arc (start/mid/end — sampled once in
    DXF-space at parse time, carried through the DXF→world transform as
    plain points, not re-derived as an angle in some other frame) rather
    than hand-tracking signs through the DXF→world→screen transform chain —
    see `toWorld`'s and `arcFlags`'s own comments for why that's the robust
    way to do it. `polygonizeFaces`' own angle math (departure/arrival
    tangents at a vertex, for choosing the next edge around a face) is a
    separate, independent piece of code from `arcFlags`/`dxfShapePathD` even
    though the underlying sweep-normalisation trick is the same idea —
    kept apart deliberately so changes to one can't risk regressing the
    other's already browser-verified behaviour.
  - **Line weight and line type** (DXF groups `370`/`6`) are read and
    rendered, not just colour — same BYLAYER-fallback shape as colour
    (`resolveLineweight`/`resolveLinetypeDashes`: entity's own value > its
    layer's (`TABLES`/`LAYER` groups `370`/`6`) > a default). Line type uses
    the drawing's own real dash pattern from `TABLES`/`LTYPE` (group `49`'s
    segment lengths), not a guessed generic dashed look. **Line weight is
    deliberately not a literal real-world-mm-to-px conversion** — this
    app's usual zoom (a site plan spanning tens-to-hundreds of metres) makes
    even a "heavy" 2mm DXF lineweight sub-pixel (≈0.04px at a typical view
    scale), so a literal conversion would render every weight identically
    at 0px and the whole feature would be invisible in normal use. Instead
    `dxfShapeStrokeWidth` takes the larger of (a) a minimum on-screen width
    by weight *category* (`LINEWEIGHT_BASELINE_PX` — thin/normal/heavy stay
    visually distinct at the zoom this app is actually used at) and (b) the
    true real-world-scaled width — a floor, not a fixed value, so a heavy
    line still gets genuinely thicker than a thin one once zoomed in close
    enough for the real size to exceed that floor (inspecting a kerb line
    from a few metres away), while thin lines never vanish and heavy ones
    aren't fake-thick at normal zoom.
  - Verified against a real DXF (an Onshape export whose SVG conversion via
    SignMaster was the original scale-mismatch bug report), a synthetic
    rectangle split into two closed, differently-coloured `LWPOLYLINE`s, a
    4-lane shared-edge-network + `POINT`/`TEXT` markers + `BUS_START` file
    (`docs/example-site-plans/multi-lane-shared.dxf`,
    `multi-lane-textcolor.dxf`), and a `LAYER`+`LTYPE` file exercising
    BYLAYER inheritance, explicit per-entity overrides, a real dash-dot
    pattern, and a visibly-heavier line side by side
    (`docs/example-site-plans/lineweight-linetype.dxf`), in a real browser
    session each time, not just unit tests.
- The grid pattern hides while a drawing is loaded (`!mapImage` gate on the
  grid `<rect>`) — the two visually fight otherwise.
- Not persisted through Save/Load — re-imported from its own file each
  session, same reasoning as the bus reference photo not being embedded in
  the save JSON.
- **A geo-referenced aerial-photo layer is explicitly future work**, not
  built now. It would reuse this same placement mechanism, as a raster
  `<image>` instead of inlined/parsed vector content.

## Porting to 3D / C#

`computeGeometry` (and its small helper functions — `wheelStaticCorners`,
`wheelLocalPts`, `rotatePt`, the `WHEEL_HALF_LEN`/`WHEEL_HALF_W`/`DUAL_GAP`
constants) has been ported to plain C# at
`TagSim3D/Geometry/TagBusGeometry.cs`. Rationale: this simulator was
originally built to visually confirm the steering geometry calculations, and
that job was done long ago — the geometry model itself has been stable for a
long time, while almost everything else in this file (view modes, trail
rendering, colour coding, dimension lines) is 2D-plan-view display sugar with
no 3D equivalent. So the geometry engine is the one thing worth extracting
now, ahead of any 3D engine decision, rather than waiting for a full 3D
project to exist first.

**This JS file stays the source of truth for the kinematic model.** If a bug
or a tweak to the geometry math turns up here (in `computeGeometry` or its
helpers) — record it in this section, even briefly, so it's a page any future
TagSim3D work reads before touching `TagBusGeometry.cs`. Don't assume the C#
port silently stays in sync; nothing currently automates that.

- *(none logged yet)*

The dead-reckoning pose-integration loop (lives in the "Drive the turn"
effect, not in `computeGeometry` itself — see "Coordinate pipeline" above)
has also been ported, to `TagSim3D/Geometry/PoseIntegrator.cs`
(`Pose`/`PoseIntegrator.Step`, plus `Pose.Transform` for `poseTransform`).
Same rule applies: this JS effect stays the source of truth for the
integration math.

Not ported: `innerDriveRadius` (already dead/unused here — see "Known rough
edges" below).

**Explicitly not intended for porting: `src/course.js`, `src/env.js`,
`src/train.js`, `src/policy.js`** (the corridor/course model, RL
observation/reward layer, and CEM training loop built on top of the geometry
engine above). These stay scoped to this sub-project as a self-contained 2D
training sandbox. TagSim3D's road/corridor geometry (centerline, width,
curbs, no-mow zones) will be authored freehand in the Unity editor (Splines/
ProBuilder/Path Creator), not generated from or synced with this JS course
model — so unlike `computeGeometry`/`PoseIntegrator`, there is no port to
keep in sync here, and no expectation that a future ML addon for TagSim3D
reuses this course/env/training code directly. If TagSim3D eventually gets
an ML addon, it will most likely be built against the Unity scene itself
(e.g. via Unity ML-Agents) rather than by porting this pipeline.

## Known rough edges / things not yet done

- `DUAL_HALF_LEN`/`DUAL_HALF_W` are now dead code (see wheel numbering
  section above).
- The `innerDriveRadius` local variable in `computeGeometry` is computed but
  unused (leftover from an earlier version of the off-tracking calc).
- No *automatic* persistence — refreshing the page still resets everything to
  defaults. There's now an explicit Save/Load pair (header toolbar, top
  right) that round-trips vehicle geometry, steering/tag/lockout/display
  settings, live pose, and the trail buffer through a downloaded JSON file —
  see `buildSaveData`/`applySaveData`/`handleSave`/`handleLoadFile`. Chosen
  over localStorage (which would auto-restore silently on refresh) so a save
  is an explicit, shareable/backup-able file instead of invisible browser
  state — localStorage remains a reasonable follow-up for "remember my last
  session" if that's ever wanted alongside this.
- Vehicle geometry defaults (`Lfd=7.0, Ldt=1.4, Fo=2.75, Ro=3.35, Wb=2.48,
  Tw=2.1`) reflect the confirmed dimensions of the person's actual BCC
  Volvo/Scania 6x2 tag-axle bus: overall length 14.5m (2.75 + 7.0 + 1.4 +
  3.35), body width 2.48m excluding mirrors. `Tw` (axle track width) still
  has no compliance-plate figure and remains an adjustable estimate — don't
  present it as authoritative like the others.
