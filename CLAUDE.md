# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

TagSim: steering and driving simulators for 3-axle "tag" buses (a rigid bus with
a front steer axle, a fixed drive axle, and a rear tag axle that
counter-steers), modelled loosely on Brisbane City Council's Volvo/Scania 6x2
tag-axle fleet.

The repo holds three independent sub-projects, not a shared build/workspace:

- **`TagSimSteer/`** — a working 2D plan-view (top-down) steering geometry
  simulator: a Vite + React app built around one large component
  (`tag-steering-simulator.jsx`, originally a claude.ai artifact) plus
  supporting modules in `src/` (headless physics, DXF import, wheel/pedal
  input, and a small ML training sandbox). **Read
  [TagSimSteer/CLAUDE.md](TagSimSteer/CLAUDE.md) before touching it** —
  it documents the coordinate pipeline, wheel-numbering convention, steering
  input resolution, and several deliberate design decisions (and their
  previously-tried-and-reverted alternatives) in detail.
- **`TagSim3D/`** — not a scaffolded project yet, but no longer empty: it
  holds a pure C# port of TagSimSteer's kinematic geometry engine
  (`Geometry/TagBusGeometry.cs`), extracted ahead of picking a 3D engine
  since that math is stable and has no rendering dependency. See
  [TagSim3D/README.md](TagSim3D/README.md) for what's there and why, and
  [TagSimSteer/CLAUDE.md](TagSimSteer/CLAUDE.md)'s "Porting to 3D / C#"
  section for how the two projects' geometry stays in sync.

- **`TagSimWheel/`** — C# proof of concept that drives the Moza R5's
  force-feedback motor to commanded angles via DirectInput. A
  netstandard2.0 library (`WheelController`, reusable from WinForms or
  Unity), a console test front end and a WinForms control GUI. See
  [TagSimWheel/README.md](TagSimWheel/README.md).

Each sub-project carries its own tooling; there is no root-level
package.json, build config, linter, or test suite:

- `TagSimSteer/` has its own `package.json` + `vite.config.js` (`npm run dev`
  on port 5183, `npm run train` for the ML sandbox) and is deployed to GitHub
  Pages by `.github/workflows/deploy-tagsimsteer.yml` (the one root-level
  file, triggered only by changes under `TagSimSteer/`).
- `TagSimWheel/` is a .NET solution (`TagSimWheel.slnx`).
- `TagSim3D/` has no build yet (loose `.cs` files awaiting a Unity project).

Do not add shared root-level tooling (package.json, workspaces, etc.)
speculatively — set it up when more than one sub-project actually needs it.
