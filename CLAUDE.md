# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

TagSim: steering and driving simulators for 3-axle "tag" buses (a rigid bus with
a front steer axle, a fixed drive axle, and a rear tag axle that
counter-steers), modelled loosely on Brisbane City Council's Volvo/Scania 6x2
tag-axle fleet.

The repo holds two independent sub-projects, not a shared build/workspace:

- **`TagSimSteer/`** — a working 2D plan-view (top-down) steering geometry
  simulator. Single self-contained React component
  (`tag-steering-simulator.jsx`), originally built as a claude.ai artifact and
  moved here for further development. **Read
  [TagSimSteer/CLAUDE.md](TagSimSteer/CLAUDE.md) before touching this file** —
  it documents the coordinate pipeline, wheel-numbering convention, steering
  input resolution, and several deliberate design decisions (and their
  previously-tried-and-reverted alternatives) in detail.
- **`TagSim3D/`** — currently an empty placeholder directory (no files yet,
  not tracked by git). Presumably a future 3D counterpart to the steering
  simulator; there is nothing to read here until work starts.

There is no root-level package.json, build config, linter, or test suite —
neither sub-project is a scaffolded app. `TagSimSteer/tag-steering-simulator.jsx`
is meant to be dropped into a host React app (Vite/CRA/Next) rather than run
standalone; see that sub-project's CLAUDE.md for exact instructions and
constraints. Do not add root-level tooling (package.json, CI, etc.) speculatively
— set it up when a sub-project actually needs it.
