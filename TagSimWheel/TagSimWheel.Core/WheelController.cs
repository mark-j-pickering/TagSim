using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;
using SharpDX;
using SharpDX.DirectInput;

namespace TagSimWheel
{
    /// <summary>
    /// Turns a DirectInput force-feedback wheel (e.g. a Moza R5 base) to commanded angles.
    ///
    /// How: one infinite ConstantForce effect whose magnitude is rewritten every tick by a software
    /// PD position controller (force = Kp*error - Kd*speed), plus a hardware Damper effect that the
    /// base runs internally for stability. A Spring effect with a moving centre offset was the
    /// obvious alternative, but DirectInput caps a spring's coefficient so it only reaches full force
    /// at a full half-range of error (450 deg on a 900 deg wheel) - far too soft to position with.
    ///
    /// Threading: every DirectInput call happens on one private control thread, so the public
    /// methods are safe to call from any thread (console, WinForms UI thread, a timer...). Events
    /// are raised on the control thread: a WinForms handler must marshal with Control.BeginInvoke,
    /// or the UI can simply poll <see cref="Status"/> from a Timer instead.
    /// </summary>
    public sealed class WheelController : IDisposable
    {
        const int DiMax = 10000;           // DirectInput's full-scale for magnitudes/coefficients/axis range
        const int Infinite = -1;           // INFINITE (0xFFFFFFFF) as DirectInput's signed duration
        const int NoTrigger = -1;          // DIEB_NOTRIGGER
        const double DetectForce = 0.08;   // nudge used by direction detection
        const double DetectMoveDeg = 10;
        const double DetectTimeoutSec = 0.4;
        const double StatusEventHz = 30;

        readonly object _gate = new object();
        Thread _thread;
        volatile bool _stopRequested;

        // Commands, written by callers under _gate and read by the loop once per tick.
        WheelMode _requestedMode = WheelMode.Released;
        double _targetDeg;
        bool _holdHereRequested;
        bool _clearFaultRequested;
        string _faultRequested;
        TaskCompletionSource<int> _detectRequest;

        WheelStatus _status;

        public WheelController(WheelOptions options = null)
        {
            Options = options ?? new WheelOptions();
        }

        public WheelOptions Options { get; }

        public bool IsOpen => _thread != null;

        /// <summary>Latest loop snapshot. Cheap; fine to poll from a UI timer.</summary>
        public WheelStatus Status { get { lock (_gate) return _status; } }

        /// <summary>Raised ~30 times a second on the control thread.</summary>
        public event EventHandler<WheelStatus> StatusUpdated;

        /// <summary>Raised once on the control thread when the controller drops force due to a fault.</summary>
        public event EventHandler<string> Faulted;

        /// <summary>Attached game controllers that report force-feedback support.</summary>
        public static IReadOnlyList<WheelDeviceInfo> ListDevices()
        {
            using (var di = new DirectInput())
            {
                return di.GetDevices(DeviceClass.GameControl,
                                     DeviceEnumerationFlags.AttachedOnly | DeviceEnumerationFlags.ForceFeedback)
                         .Select(d => new WheelDeviceInfo(d.InstanceGuid, d.InstanceName, d.ProductName))
                         .ToList();
            }
        }

        /// <summary>
        /// Diagnostic text: every object (axis/button) the device exposes with its type flags, and its
        /// supported effects. Doesn't acquire the device, so it never moves the motor.
        /// </summary>
        public static string DescribeDevice(Guid deviceGuid)
        {
            var sb = new System.Text.StringBuilder();
            using (var di = new DirectInput())
            using (var joy = new Joystick(di, deviceGuid))
            {
                sb.AppendLine($"Capabilities: {joy.Capabilities.Flags}  axes={joy.Capabilities.AxeCount}");
                foreach (var o in joy.GetObjects())
                    sb.AppendLine($"  object '{o.Name}'  type={ObjectTypeName(o.ObjectType)}  id=0x{(int)o.ObjectId:X8}  flags={o.ObjectId.Flags}  ffMaxForce={o.MaximumForceFeedback}");
                foreach (var e in joy.GetEffects())
                    sb.AppendLine($"  effect {e.Name}  ({e.Type})");
            }
            return sb.ToString();
        }

        static string ObjectTypeName(Guid g) =>
            g == ObjectGuid.XAxis ? "XAxis" : g == ObjectGuid.YAxis ? "YAxis" : g == ObjectGuid.ZAxis ? "ZAxis" :
            g == ObjectGuid.RxAxis ? "RxAxis" : g == ObjectGuid.RyAxis ? "RyAxis" : g == ObjectGuid.RzAxis ? "RzAxis" :
            g == ObjectGuid.Slider ? "Slider" : g == ObjectGuid.Button ? "Button" : g == ObjectGuid.PovController ? "POV" : g.ToString();

        /// <summary>
        /// Acquires the device exclusively and starts the control loop, force released.
        /// <paramref name="windowHandle"/> must be a top-level window of this process (a WinForms Form's
        /// Handle; a console app can use a hidden Form). Force feedback requires exclusive access,
        /// which DirectInput ties to a window. Background mode is used, so the wheel keeps working when
        /// that window isn't focused.
        /// </summary>
        public void Open(Guid deviceGuid, IntPtr windowHandle)
        {
            if (_thread != null) throw new InvalidOperationException("Already open.");

            var ready = new ManualResetEventSlim();
            Exception startError = null;
            _stopRequested = false;
            _thread = new Thread(() => Run(deviceGuid, windowHandle, ready, e => startError = e))
            {
                IsBackground = true,
                Name = "WheelController",
                Priority = ThreadPriority.AboveNormal,
            };
            _thread.Start();
            ready.Wait();
            if (startError != null)
            {
                _thread.Join();
                _thread = null;
                throw startError;
            }
        }

        /// <summary>Drive the wheel to <paramref name="angleDeg"/> (clamped inside the end stops), rate-limited.</summary>
        public void MoveTo(double angleDeg)
        {
            lock (_gate)
            {
                if (_requestedMode == WheelMode.Faulted) return;
                _targetDeg = angleDeg;
                _requestedMode = WheelMode.Positioning;
            }
        }

        /// <summary>Hold the wheel at wherever it is right now.</summary>
        public void HoldHere()
        {
            lock (_gate)
            {
                if (_requestedMode == WheelMode.Faulted) return;
                _holdHereRequested = true;
                _requestedMode = WheelMode.Positioning;
            }
        }

        /// <summary>Stop positioning; the wheel goes free (zero force).</summary>
        public void Release()
        {
            lock (_gate)
            {
                if (_requestedMode != WheelMode.Faulted) _requestedMode = WheelMode.Released;
            }
        }

        /// <summary>Drop all force immediately and latch until <see cref="ClearFault"/>.</summary>
        public void EmergencyStop() => RequestFault("Emergency stop");

        /// <summary>Re-arm after a fault/emergency stop. The wheel comes back released.</summary>
        public void ClearFault()
        {
            lock (_gate) _clearFaultRequested = true;
        }

        /// <summary>
        /// Applies a brief small force and watches which way the wheel moves, then sets
        /// <see cref="WheelOptions.ForceSign"/> accordingly and returns it. The wheel must be free to
        /// turn (hands off). Leaves the wheel released.
        /// </summary>
        public Task<int> DetectForceDirectionAsync()
        {
            var tcs = new TaskCompletionSource<int>(TaskCreationOptions.RunContinuationsAsynchronously);
            lock (_gate)
            {
                if (_thread == null) throw new InvalidOperationException("Not open.");
                if (_requestedMode == WheelMode.Faulted) throw new InvalidOperationException("Controller is faulted.");
                _detectRequest?.TrySetCanceled();
                _detectRequest = tcs;
                _requestedMode = WheelMode.Released;
            }
            return tcs.Task;
        }

        /// <summary>Stops all force, releases the device and ends the control thread.</summary>
        public void Close()
        {
            var t = _thread;
            if (t == null) return;
            _stopRequested = true;
            t.Join();
            _thread = null;
        }

        public void Dispose() => Close();

        void RequestFault(string reason)
        {
            lock (_gate)
            {
                _faultRequested = reason;
                _requestedMode = WheelMode.Faulted;
            }
        }

        // ---------------------------------------------------------------- control thread

        void Run(Guid deviceGuid, IntPtr hwnd, ManualResetEventSlim ready, Action<Exception> reportStartError)
        {
            DirectInput di = null;
            Joystick joy = null;
            Effect force = null, damper = null;
            timeBeginPeriod(1);   // Thread.Sleep(1) granularity ~1ms instead of ~15.6ms
            try
            {
                try
                {
                    di = new DirectInput();
                    joy = new Joystick(di, deviceGuid);
                    joy.SetCooperativeLevel(hwnd, CooperativeLevel.Background | CooperativeLevel.Exclusive);

                    // Normalise every axis to -10000..10000 so X reads directly as a fraction of half-range.
                    foreach (var o in joy.GetObjects(DeviceObjectTypeFlags.Axis))
                        joy.GetObjectPropertiesById(o.ObjectId).Range = new InputRange(-DiMax, DiMax);
                    joy.Properties.AutoCenter = false;   // the base's own centring spring would fight us
                    joy.Acquire();

                    // Filter by flag ourselves: GetObjects(ForceFeedbackActuator) returns nothing on a Moza R5
                    // even though its X axis carries that flag. Prefer X, the steering axis we read.
                    var actuators = joy.GetObjects()
                                       .Where(o => (o.ObjectId.Flags & DeviceObjectTypeFlags.ForceFeedbackActuator) != 0)
                                       .ToList();
                    var actuator = actuators.FirstOrDefault(o => o.ObjectType == ObjectGuid.XAxis) ?? actuators.FirstOrDefault();
                    if (actuator == null) throw new InvalidOperationException("Device has no force-feedback actuator axis.");
                    var axes = new[] { (int)actuator.ObjectId };

                    var supported = joy.GetEffects().Select(e => e.Guid).ToList();
                    if (!supported.Contains(EffectGuid.ConstantForce))
                        throw new InvalidOperationException("Device does not support the ConstantForce effect.");

                    joy.SendForceFeedbackCommand(ForceFeedbackCommand.Reset);
                    joy.SendForceFeedbackCommand(ForceFeedbackCommand.SetActuatorsOn);

                    force = new Effect(joy, EffectGuid.ConstantForce, MakeParams(axes, new ConstantForce { Magnitude = 0 }));
                    force.Start(1);
                    if (supported.Contains(EffectGuid.Damper))
                    {
                        damper = new Effect(joy, EffectGuid.Damper, MakeParams(axes, DamperCondition(Options.HardwareDamping)));
                        damper.Start(1);
                    }
                }
                catch (Exception e)
                {
                    reportStartError(e);
                    return;
                }
                finally
                {
                    ready.Set();
                }

                Loop(joy, force, damper);
            }
            finally
            {
                // Always leave the wheel limp, whatever happened.
                try { force?.Stop(); } catch { }
                try { damper?.Stop(); } catch { }
                try { joy?.SendForceFeedbackCommand(ForceFeedbackCommand.Reset); } catch { }
                force?.Dispose();
                damper?.Dispose();
                try { joy?.Unacquire(); } catch { }
                joy?.Dispose();
                di?.Dispose();
                timeEndPeriod(1);
            }
        }

        void Loop(Joystick joy, Effect forceEffect, Effect damperEffect)
        {
            var opt = Options;
            var clock = Stopwatch.StartNew();
            double prevT = 0, nextTick = 0, nextStatusEvent = 0;
            double angle = ReadAngle(joy), prevAngle = angle, vel = 0;
            double setpoint = angle, target = angle;
            double engagedAt = 0;
            double lastDamping = opt.HardwareDamping;
            int lastRaw = 0;
            var mode = WheelMode.Released;
            string fault = null;

            // Direction-detection state (runs instead of the PD law while active).
            TaskCompletionSource<int> detect = null;
            double detectStartAngle = 0, detectStartT = 0;

            var constantForce = new ConstantForce();
            var forceParams = MakeParams(null, constantForce);

            while (!_stopRequested)
            {
                // Pace the loop.
                double period = 1.0 / Math.Max(50, opt.UpdateHz);
                nextTick += period;
                while (clock.Elapsed.TotalSeconds < nextTick) Thread.Sleep(1);
                double t = clock.Elapsed.TotalSeconds;
                if (t - nextTick > 0.1) nextTick = t;   // fell far behind (debugger etc.) - don't burst
                double dt = Math.Max(1e-4, t - prevT);
                prevT = t;

                // ---- read
                try
                {
                    angle = ReadAngle(joy);
                }
                catch (SharpDXException)
                {
                    // Lost acquisition (device unplugged, another exclusive owner). Try to recover next tick.
                    try { joy.Acquire(); } catch { }
                    continue;
                }
                double rawVel = (angle - prevAngle) / dt;
                prevAngle = angle;
                vel += (rawVel - vel) * (1 - Math.Exp(-dt / 0.01));   // ~10ms low-pass

                // ---- take commands
                bool holdHere, clearFault;
                string newFault;
                lock (_gate)
                {
                    holdHere = _holdHereRequested; _holdHereRequested = false;
                    clearFault = _clearFaultRequested; _clearFaultRequested = false;
                    newFault = _faultRequested; _faultRequested = null;
                    if (_detectRequest != null) { detect = _detectRequest; _detectRequest = null; detectStartAngle = angle; detectStartT = t; }
                    if (clearFault && _requestedMode == WheelMode.Faulted) _requestedMode = WheelMode.Released;
                    if (holdHere) _targetDeg = angle;
                    target = _targetDeg;

                    var requested = _requestedMode;
                    if (requested == WheelMode.Positioning && mode != WheelMode.Positioning)
                    {
                        setpoint = angle;   // start from where the wheel is - never jump
                        engagedAt = t;
                    }
                    mode = requested;
                }
                if (clearFault) fault = null;
                if (newFault != null) fault = newFault;

                // ---- safety
                if (mode != WheelMode.Faulted && Math.Abs(vel) > opt.FaultSpeedDegPerSec)
                {
                    string reason = $"Wheel speed {Math.Abs(vel):F0} deg/s exceeded {opt.FaultSpeedDegPerSec:F0} deg/s";
                    RequestFault(reason);
                    mode = WheelMode.Faulted;
                    fault = reason;
                    newFault = reason;
                }
                if (mode == WheelMode.Faulted && detect != null)
                {
                    detect.TrySetException(new InvalidOperationException("Faulted during direction detection: " + fault));
                    detect = null;
                }

                // ---- control law
                double half = opt.RotationRangeDeg / 2;
                double limit = Math.Max(0, half - opt.EndStopMarginDeg);
                double cmdForce = 0;       // -1..1, in "increase the angle" terms
                int raw;
                if (detect != null)
                {
                    double moved = angle - detectStartAngle;
                    if (Math.Abs(moved) >= DetectMoveDeg || t - detectStartT >= DetectTimeoutSec)
                    {
                        if (Math.Abs(moved) < 1)
                            detect.TrySetException(new InvalidOperationException(
                                "The wheel didn't move. Check it's free to turn and that Pit House FFB strength isn't zero."));
                        else
                        {
                            opt.ForceSign = Math.Sign(moved);
                            detect.TrySetResult(opt.ForceSign);
                        }
                        detect = null;
                        raw = 0;
                    }
                    else raw = (int)(DetectForce * DiMax);   // raw +ve force; ForceSign deliberately not applied
                }
                else
                {
                    if (mode == WheelMode.Positioning)
                    {
                        double clampedTarget = Clamp(target, -limit, limit);
                        double maxStep = opt.MaxSlewDegPerSec * dt;
                        setpoint += Clamp(clampedTarget - setpoint, -maxStep, maxStep);

                        double ramp = opt.SoftStartSeconds > 0 ? Clamp((t - engagedAt) / opt.SoftStartSeconds, 0, 1) : 1;
                        double cap = Clamp(opt.MaxStrength, 0, 1) * ramp;
                        cmdForce = Clamp(opt.Kp * (setpoint - angle) - opt.Kd * vel, -cap, cap);
                    }
                    else
                    {
                        setpoint = angle;
                    }
                    raw = (int)Math.Round(cmdForce * opt.ForceSign * DiMax);
                }

                // ---- write (only when changed - each write is a USB transfer)
                try
                {
                    if (raw != lastRaw)
                    {
                        constantForce.Magnitude = raw;
                        forceEffect.SetParameters(forceParams, EffectParameterFlags.TypeSpecificParameters);
                        lastRaw = raw;
                    }
                    if (damperEffect != null && opt.HardwareDamping != lastDamping)
                    {
                        var p = MakeParams(null, DamperCondition(opt.HardwareDamping));
                        damperEffect.SetParameters(p, EffectParameterFlags.TypeSpecificParameters);
                        lastDamping = opt.HardwareDamping;
                    }
                }
                catch (SharpDXException)
                {
                    lastRaw = int.MinValue;   // force a rewrite once the device is back
                    try { joy.Acquire(); } catch { }
                }

                // ---- publish
                var status = new WheelStatus(mode, angle, vel, setpoint, Clamp(target, -limit, limit), cmdForce, fault);
                lock (_gate) _status = status;
                if (newFault != null) Faulted?.Invoke(this, newFault);
                if (t >= nextStatusEvent)
                {
                    nextStatusEvent = t + 1 / StatusEventHz;
                    StatusUpdated?.Invoke(this, status);
                }
            }

            detect?.TrySetCanceled();
        }

        double ReadAngle(Joystick joy)
        {
            joy.Poll();
            var s = joy.GetCurrentState();
            return s.X / (double)DiMax * (Options.RotationRangeDeg / 2);
        }

        static EffectParameters MakeParams(int[] axes, TypeSpecificParameters specific)
        {
            var p = new EffectParameters
            {
                Flags = EffectFlags.Cartesian | EffectFlags.ObjectIds,
                Duration = Infinite,
                SamplePeriod = 0,
                Gain = DiMax,
                TriggerButton = NoTrigger,
                TriggerRepeatInterval = 0,
                StartDelay = 0,
                Parameters = specific,
            };
            // Single-axis effect: direction comes from the sign of the magnitude, not the direction vector.
            if (axes != null) p.SetAxes(axes, new int[axes.Length]);
            return p;
        }

        static ConditionSet DamperCondition(double coefficient)
        {
            int c = (int)(Clamp(coefficient, 0, 1) * DiMax);
            return new ConditionSet
            {
                Conditions = new[]
                {
                    new Condition
                    {
                        Offset = 0,
                        DeadBand = 0,
                        PositiveCoefficient = c,
                        NegativeCoefficient = c,
                        PositiveSaturation = DiMax,
                        NegativeSaturation = DiMax,
                    },
                },
            };
        }

        static double Clamp(double v, double lo, double hi) => v < lo ? lo : v > hi ? hi : v;

        [DllImport("winmm.dll")] static extern uint timeBeginPeriod(uint ms);
        [DllImport("winmm.dll")] static extern uint timeEndPeriod(uint ms);
    }
}
