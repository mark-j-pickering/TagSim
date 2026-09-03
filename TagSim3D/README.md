# TagSim3D

Not a scaffolded project yet — this directory currently holds one thing: a
pure C# port of TagSimSteer's kinematic geometry engine, checked in ahead of
picking/setting up a 3D engine so it isn't blocked on that decision.

## What's here

- `Geometry/TagBusGeometry.cs` — a plain C# (no engine dependency) port of
  `computeGeometry` from `TagSimSteer/tag-steering-simulator.jsx`: given the
  bus's fixed dimensions and a steer angle/tag-ratio/lockout/speed, it
  returns wheel and body-corner positions, turn radius, off-tracking,
  mow1/mow2, tailSwing7/8, and scrub angle. No rendering, no engine types —
  see the file header for the exact conventions preserved from the JS
  source (chassis-local frame, wheel numbering, the `deltaFDeg == 0` exact
  straight-ahead rule, sign convention).

That's it — no `.csproj`, no Unity project structure (`Assets/`,
`ProjectSettings/`, etc.) yet. Unity projects are normally created via the
Unity Hub/Editor rather than by hand; once an engine choice is locked in and
a real project is created, `Geometry/TagBusGeometry.cs` drops straight into
its `Assets/Scripts/` (or equivalent) unchanged.

## Why the geometry engine and nothing else

TagSimSteer is a 2D plan-view display of this same geometry — SVG rendering,
view-mode cameras, trail ribbons, colour coding, dimension lines. None of
that carries over to a 3D (especially first-person) simulator; a 3D scene
needs its own camera/rendering/asset pipeline regardless of what gets reused
from TagSimSteer. The one piece that *is* reusable as-is is the underlying
kinematic math, which is why it's the only thing ported so far — see
`TagSimSteer/CLAUDE.md`, "Porting to 3D / C#", for the process going
forward: the JS file remains the source of truth, and any future bug fix or
tweak to the model gets flagged there so this port can pick it up.

## Pose integration is not ported (yet)

`TagBusGeometry.Compute` is a single-instant evaluation — it does not
integrate the bus's position/heading over time. In TagSimSteer that
dead-reckoning loop (Euler-integrating `pose = {x, y, theta}` each frame from
`R` and speed) lives in the React component's "Drive the turn" effect, not in
`computeGeometry` itself (see `TagSimSteer/CLAUDE.md`, "Coordinate pipeline").
Porting that loop is a reasonable next step once there's an actual per-frame
update context (a MonoBehaviour `Update`/`FixedUpdate` or equivalent) to hang
it on — deferred until then rather than guessed at now.
