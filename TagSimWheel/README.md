# TagSimWheel

Proof of concept: turning a force-feedback wheel base (Moza R5) to commanded
angles from C#, through DirectInput.

- `TagSimWheel.Core/` is a **netstandard2.0** class library. It holds all the
  logic in `WheelController`, has no UI dependency, and can be referenced from a
  WinForms app or dropped into Unity (TagSim3D) later.
- `TagSimWheel.Console/` is a thin .NET 8 keyboard front end for testing.
- `TagSimWheel.WinForms/` is a .NET 8 GUI (`TagSimWheelGui.exe`), described below.

## GUI

```bash
dotnet run --project TagSimWheel.WinForms
```

1. Pick the device, set the Pit House rotation, and press **Connect**. Nothing
   moves until you command it.
2. Press **Detect direction…** once per device. The result is saved, so you
   don't repeat this next time.
3. To move the wheel, use the Position buttons or a typed target, or
   click/drag on the range bar under the wheel. The orange marker is the
   target and the blue one is the live angle.
4. **Sine sweep** moves the wheel back and forth continuously. **Tuning**
   changes the gains and limits live.

**Esc or Space** triggers the emergency stop from anywhere in the window. After
a stop, **Clear fault** re-arms it with the wheel released.

The form is built in code (no designer files). It polls
`WheelController.Status` from a 30 Hz WinForms Timer rather than handling the
controller's events, so there is no cross-thread marshalling. Settings
(device, rotation, tuning, sweep, and the detected direction per device) are
saved to `%AppData%\TagSimWheel\settings.json`.

## Console

```bash
dotnet run --project TagSimWheel.Console
```

`--list` only enumerates force-feedback devices and never touches the motor.

The console asks for the device and the wheel rotation set in Pit House (these
**must match**, or angles are scaled wrongly). It then nudges the wheel once to
work out which force sign turns it which way, so keep your hands off for that step.

Keys: ←/→ move the target ±10° (Shift: ±90°), `0` centre, `G` go to an angle,
`H` hold where it is, `S` sine sweep ±90°, `R` release, `+`/`-` strength cap,
**Space/Esc emergency stop**, `F` clear fault, `Q` quit.

## How it works

DirectInput requires exclusive access for force feedback, and exclusive access
is tied to a window. The library therefore takes a window handle: a WinForms
app passes its Form's `Handle`, and the console app uses a hidden Form. It uses
Background mode, so the window doesn't need focus.

A private control thread (250 Hz) reads the wheel angle and rewrites the
magnitude of one infinite **ConstantForce** effect from a PD law:
`force = Kp·error − Kd·speed`. The base's own **Damper** effect stays on for
stability. The alternative, a Spring effect with a moving centre offset, was
rejected: DirectInput caps a spring's coefficient, so it reaches full force only
at a half-range of error (450° on a 900° wheel). That is far too soft to position
the wheel accurately.

## Safety built in

These limits come from `WheelOptions`, and every one can be changed while the
loop is running:

- Force capped at `MaxStrength`, 25% by default.
- Soft-start ramp whenever force engages.
- The commanded position is rate-limited (`MaxSlewDegPerSec`) and starts from
  where the wheel is, so it never jumps.
- Targets are clamped inside the end stops.
- The loop faults and drops all force above `FaultSpeedDegPerSec`.
- Force is always reset on close, on Ctrl+C and on process exit.

The torque limits in Pit House still apply on top of all of this.

## Using it from WinForms

```csharp
var wheel = new WheelController(new WheelOptions { RotationRangeDeg = 900 });
wheel.Open(WheelController.ListDevices()[0].InstanceGuid, this.Handle);
await wheel.DetectForceDirectionAsync();   // or restore a saved Options.ForceSign
wheel.MoveTo(-45);                         // any thread
// Poll wheel.Status from a WinForms Timer, or handle StatusUpdated with BeginInvoke
// (it is raised on the control thread).
wheel.Dispose();                           // in FormClosing
```

SharpDX (`SharpDX.DirectInput` 4.2.0) is no longer maintained, but it is stable
and was chosen because it works on both .NET 8 and Unity's Mono.
