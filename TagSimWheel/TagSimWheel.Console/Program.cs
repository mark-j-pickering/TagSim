using System;
using System.Globalization;
using System.Threading;
using System.Windows.Forms;
using TagSimWheel;

namespace TagSimWheel.ConsoleApp
{
    /// <summary>
    /// Proof of concept: drive a force-feedback wheel to commanded angles from the keyboard.
    /// All the real work is in TagSimWheel.Core's WheelController; this is a thin front end that a
    /// WinForms GUI would replace.
    /// </summary>
    static class Program
    {
        static WheelController _wheel;

        [STAThread]
        static int Main(string[] args)
        {
            Console.OutputEncoding = System.Text.Encoding.UTF8;
            Console.WriteLine("TagSimWheel force-feedback proof of concept");
            Console.WriteLine();

            var devices = WheelController.ListDevices();
            if (devices.Count == 0)
            {
                Console.WriteLine("No force-feedback game controllers found. Is the wheel base on and Pit House running?");
                return 1;
            }
            for (int i = 0; i < devices.Count; i++)
                Console.WriteLine($"  [{i}] {devices[i].Name}  ({devices[i].ProductName})");
            if (Array.IndexOf(args, "--list") >= 0) return 0;   // enumerate only - never touches the motor
            if (Array.IndexOf(args, "--describe") >= 0)          // objects + effects, also never touches the motor
            {
                foreach (var d in devices) Console.WriteLine(d.Name + "\n" + WheelController.DescribeDevice(d.InstanceGuid));
                return 0;
            }
            int index = AskInt("Device", 0, 0, devices.Count - 1);
            var options = new WheelOptions
            {
                RotationRangeDeg = AskInt("Wheel rotation set in Pit House, degrees", 900, 90, 2700),
            };

            // DirectInput only grants exclusive (force-feedback) access against a window. A WinForms app
            // passes its main Form's Handle; here an invisible one does the job.
            using var hiddenWindow = new Form { ShowInTaskbar = false };
            _wheel = new WheelController(options);
            try
            {
                _wheel.Open(devices[index].InstanceGuid, hiddenWindow.Handle);
            }
            catch (Exception e)
            {
                Console.WriteLine("Could not open the device: " + e.Message);
                return 1;
            }

            // Make sure the motor is released however the process ends.
            Console.CancelKeyPress += (_, e) => { e.Cancel = true; _wheel.EmergencyStop(); _quit = true; };
            AppDomain.CurrentDomain.ProcessExit += (_, __) => _wheel.Dispose();
            _wheel.Faulted += (_, reason) => _lastMessage = "FAULT: " + reason + "  (F to clear)";

            try
            {
                Console.WriteLine();
                Console.WriteLine("Hands OFF the wheel and make sure it can turn freely.");
                Console.Write("Press Enter to nudge it and detect the motor direction...");
                Console.ReadLine();
                try
                {
                    int sign = _wheel.DetectForceDirectionAsync().GetAwaiter().GetResult();
                    Console.WriteLine($"Force direction: {(sign > 0 ? "+1" : "-1")}");
                }
                catch (Exception e)
                {
                    Console.WriteLine("Direction detection failed: " + e.Message);
                    return 1;
                }

                RunInteractive();
                return 0;
            }
            finally
            {
                _wheel.Dispose();
                Console.WriteLine();
                Console.WriteLine("Force released, device closed.");
            }
        }

        static volatile bool _quit;
        static volatile string _lastMessage = "";

        static void RunInteractive()
        {
            Console.WriteLine();
            Console.WriteLine("Keys:  Left/Right  target -/+ 10 deg   (Shift: 90 deg)");
            Console.WriteLine("       0  centre        G  go to angle...      H  hold where it is now");
            Console.WriteLine("       S  sweep on/off  R  release (no force)  +/-  strength cap");
            Console.WriteLine("       Space or Esc  EMERGENCY STOP          F  clear fault     Q  quit");
            Console.WriteLine();

            bool sweeping = false;
            double sweepStart = 0, sweepAmplitude = 90, sweepPeriod = 6;
            double target = 0;
            var clock = System.Diagnostics.Stopwatch.StartNew();

            while (!_quit)
            {
                while (Console.KeyAvailable)
                {
                    var k = Console.ReadKey(intercept: true);
                    bool shift = (k.Modifiers & ConsoleModifiers.Shift) != 0;
                    double step = shift ? 90 : 10;
                    switch (k.Key)
                    {
                        case ConsoleKey.Spacebar:
                        case ConsoleKey.Escape:
                            sweeping = false;
                            _wheel.EmergencyStop();
                            break;
                        case ConsoleKey.Q:
                            _quit = true;
                            break;
                        case ConsoleKey.F:
                            _wheel.ClearFault();
                            _lastMessage = "Fault cleared - wheel released";
                            break;
                        case ConsoleKey.LeftArrow:
                            sweeping = false;
                            target = CurrentTargetOrAngle() - step;
                            _wheel.MoveTo(target);
                            break;
                        case ConsoleKey.RightArrow:
                            sweeping = false;
                            target = CurrentTargetOrAngle() + step;
                            _wheel.MoveTo(target);
                            break;
                        case ConsoleKey.D0:
                        case ConsoleKey.NumPad0:
                            sweeping = false;
                            _wheel.MoveTo(target = 0);
                            break;
                        case ConsoleKey.H:
                            sweeping = false;
                            _wheel.HoldHere();
                            break;
                        case ConsoleKey.R:
                            sweeping = false;
                            _wheel.Release();
                            break;
                        case ConsoleKey.S:
                            sweeping = !sweeping;
                            sweepStart = clock.Elapsed.TotalSeconds;
                            if (!sweeping) _wheel.HoldHere();
                            break;
                        case ConsoleKey.G:
                            sweeping = false;
                            Console.WriteLine();
                            Console.Write("Go to angle (deg, negative = left): ");
                            if (double.TryParse(Console.ReadLine(), NumberStyles.Float, CultureInfo.InvariantCulture, out var a))
                                _wheel.MoveTo(target = a);
                            break;
                        case ConsoleKey.OemPlus:
                        case ConsoleKey.Add:
                            _wheel.Options.MaxStrength = Math.Min(1.0, _wheel.Options.MaxStrength + 0.05);
                            break;
                        case ConsoleKey.OemMinus:
                        case ConsoleKey.Subtract:
                            _wheel.Options.MaxStrength = Math.Max(0.0, _wheel.Options.MaxStrength - 0.05);
                            break;
                    }
                }

                if (sweeping)
                {
                    double t = clock.Elapsed.TotalSeconds - sweepStart;
                    _wheel.MoveTo(sweepAmplitude * Math.Sin(2 * Math.PI * t / sweepPeriod));
                }

                var s = _wheel.Status;
                string line = $"\r{s.Mode,-11} angle {s.AngleDeg,7:F1}  target {s.TargetDeg,7:F1}  " +
                              $"speed {s.VelocityDegPerSec,7:F0} deg/s  force {s.Force * 100,5:F0}%  " +
                              $"cap {_wheel.Options.MaxStrength * 100:F0}%  {(sweeping ? "SWEEP " : "")}{_lastMessage}";
                int width = Math.Max(20, Console.WindowWidth - 1);
                Console.Write(line.Length > width ? line.Substring(0, width) : line.PadRight(width));
                Thread.Sleep(50);
            }
        }

        // Arrow keys step from the current target while positioning, otherwise from where the wheel is.
        static double CurrentTargetOrAngle()
        {
            var s = _wheel.Status;
            return s.Mode == WheelMode.Positioning ? s.TargetDeg : s.AngleDeg;
        }

        static int AskInt(string prompt, int dflt, int min, int max)
        {
            while (true)
            {
                Console.Write($"{prompt} [{dflt}]: ");
                string text = Console.ReadLine()?.Trim();
                if (string.IsNullOrEmpty(text)) return dflt;
                if (int.TryParse(text, out int v) && v >= min && v <= max) return v;
                Console.WriteLine($"  Enter a whole number from {min} to {max}.");
            }
        }
    }
}
