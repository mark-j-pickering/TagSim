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

## Repo-side groundwork (done ahead of the project existing)

- `.gitignore` — the standard Unity-generated cruft (`Library/`, `Temp/`,
  `Obj/`, per-IDE `.csproj`/`.sln`, etc.). Scoped to this directory.
- `.gitattributes` — declares Git LFS tracking for common Unity binary asset
  types (textures, models, audio, fonts) ahead of any actually existing, so
  the first import doesn't need a follow-up "move this to LFS" commit.
  Requires `git lfs install` run once locally, and LFS enabled on the GitHub
  remote (on by default for github.com) — until both are in place these
  patterns are inert and files just get stored normally.

Neither of these needs anything installed to be committed as-is; LFS only
matters once actual binary assets show up.

## Setup: creating the actual project

Not done yet — this needs the Unity Hub/Editor, which only runs locally, not
from here. When ready:

1. Install Unity Hub, then an Editor version through it (LTS recommended —
   currently the pattern is "2022 LTS" / "6000 LTS" naming; pick whatever
   Hub currently lists as LTS rather than trusting a specific version number
   here, since this will drift).
2. In Hub, **New Project** → a 3D template (URP is the reasonable default;
   HDRP is overkill for this project's fidelity needs, Built-in is legacy).
   Point it at this `TagSim3D/` folder as the project location — Unity will
   create `Assets/`, `ProjectSettings/`, `Packages/`, etc. directly inside
   it, alongside the `Geometry/`, `.gitignore` etc. already here.
3. Move `Geometry/TagBusGeometry.cs` into `Assets/Scripts/Geometry/` —
   Unity only compiles scripts that live under `Assets/`, so it can't stay
   at its current path once the project exists. (This will generate a
   `TagBusGeometry.cs.meta` file alongside it — that's normal and should be
   committed; `.meta` files carry the asset GUIDs Unity uses internally and
   deleting/regenerating them breaks references, so don't hand-edit or
   remove them.)
4. Suggested top-level `Assets/` layout to start (adjust as it grows):
   `Assets/Scripts/`, `Assets/Scenes/`, `Assets/Prefabs/`, `Assets/Materials/`,
   `Assets/Models/` — matches Unity convention, nothing bespoke needed yet.
5. Commit `Assets/`, `ProjectSettings/`, and `Packages/manifest.json` — those
   define the project. Everything `.gitignore` excludes (`Library/` etc.) is
   regenerated locally by the Editor on first open and should never be
   committed.

## Pose integration is not ported (yet)

`TagBusGeometry.Compute` is a single-instant evaluation — it does not
integrate the bus's position/heading over time. In TagSimSteer that
dead-reckoning loop (Euler-integrating `pose = {x, y, theta}` each frame from
`R` and speed) lives in the React component's "Drive the turn" effect, not in
`computeGeometry` itself (see `TagSimSteer/CLAUDE.md`, "Coordinate pipeline").
Porting that loop is a reasonable next step once there's an actual per-frame
update context (a MonoBehaviour `Update`/`FixedUpdate` or equivalent) to hang
it on — deferred until then rather than guessed at now.
