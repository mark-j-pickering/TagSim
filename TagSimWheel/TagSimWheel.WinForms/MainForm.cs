using System;
using System.Diagnostics;
using System.Drawing;
using System.Linq;
using System.Windows.Forms;

namespace TagSimWheel.Gui
{
    /// <summary>
    /// Front end for <see cref="WheelController"/>. Built in code (no designer file). The UI never
    /// handles the controller's events: a 30 Hz Timer polls <see cref="WheelController.Status"/> on
    /// the UI thread, which avoids cross-thread marshalling entirely.
    /// </summary>
    sealed class MainForm : Form
    {
        readonly AppSettings _settings = AppSettings.Load();
        readonly WheelOptions _options;
        readonly Timer _uiTimer = new Timer { Interval = 33 };
        readonly Stopwatch _clock = Stopwatch.StartNew();

        WheelController _wheel;
        WheelDeviceInfo _device;
        bool _directionKnown, _detecting, _sweeping;
        double _sweepStart;
        bool _syncingTuning;

        // Connection
        ComboBox cboDevice;
        Button btnRefresh, btnConnect, btnDetect;
        NumericUpDown nudRange;
        Label lblDirection;
        // Display
        WheelGauge gauge;
        Label lblMode, lblAngle, lblTarget, lblSpeed, lblForce;
        // Control
        Button btnEStop, btnClearFault;
        GroupBox grpPosition, grpSweep;
        NumericUpDown nudTarget, nudSweepAmp, nudSweepPeriod;
        Button btnSweep;
        // Tuning
        NumericUpDown nudStrength, nudKp, nudKd, nudDamping, nudSlew;

        public MainForm()
        {
            _options = _settings.ToOptions();

            SuspendLayout();
            AutoScaleDimensions = new SizeF(96F, 96F);
            AutoScaleMode = AutoScaleMode.Dpi;
            Text = "TagSim Wheel Control";
            Font = new Font("Segoe UI", 9F);
            ClientSize = new Size(1100, 720);
            MinimumSize = new Size(960, 680);
            StartPosition = FormStartPosition.CenterScreen;
            BuildUi();
            ResumeLayout(false);
            PerformLayout();

            _uiTimer.Tick += (_, __) => OnUiTick();
            _uiTimer.Start();
            RefreshDevices();
            UpdateEnabledState(null);
        }

        // ------------------------------------------------------------------ layout

        void BuildUi()
        {
            var root = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 2, RowCount = 1, Padding = new Padding(8) };
            root.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
            root.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 420));
            Controls.Add(root);

            // Left column: connection, gauge, readouts.
            var left = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 3 };
            left.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            left.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
            left.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            root.Controls.Add(left, 0, 0);

            cboDevice = new ComboBox { DropDownStyle = ComboBoxStyle.DropDownList, Width = 260 };
            btnRefresh = MakeButton("Refresh", (_, __) => RefreshDevices());
            nudRange = MakeNumber(90, 2700, 0, 90, _settings.RotationRangeDeg, 70);
            nudRange.ValueChanged += (_, __) => _options.RotationRangeDeg = (double)nudRange.Value;
            btnConnect = MakeButton("Connect", (_, __) => ToggleConnection());
            btnDetect = MakeButton("Detect direction…", async (_, __) => await DetectDirection());
            lblDirection = new Label { AutoSize = true, Anchor = AnchorStyles.Left, Margin = new Padding(6, 6, 3, 3) };

            var conn = Stack(
                Flow(Caption("Device"), cboDevice, btnRefresh, Caption("Pit House rotation°"), nudRange),
                Flow(btnConnect, btnDetect, lblDirection));
            left.Controls.Add(Group("Wheel base", conn, fill: true), 0, 0);

            gauge = new WheelGauge { Dock = DockStyle.Fill, Margin = new Padding(3, 6, 3, 6) };
            gauge.TargetPicked += (_, deg) => { StopSweep(); MoveTo(deg); };
            left.Controls.Add(gauge, 0, 1);

            lblMode = Readout(); lblAngle = Readout(); lblTarget = Readout(); lblSpeed = Readout(); lblForce = Readout();
            var readouts = Flow(lblMode, lblAngle, lblTarget, lblSpeed, lblForce);
            readouts.Dock = DockStyle.Fill;
            left.Controls.Add(readouts, 0, 2);

            // Right column: e-stop, position, sweep, tuning.
            var right = new FlowLayoutPanel
            {
                Dock = DockStyle.Fill, FlowDirection = FlowDirection.TopDown, WrapContents = false, AutoScroll = true, Padding = new Padding(0, 0, 8, 0),
            };
            root.Controls.Add(right, 1, 0);

            btnEStop = new Button
            {
                Text = "EMERGENCY STOP\r\n(Esc / Space)",
                Size = new Size(380, 70),
                BackColor = Color.FromArgb(200, 30, 30),
                ForeColor = Color.White,
                FlatStyle = FlatStyle.Flat,
                Font = new Font(Font.FontFamily, 13F, FontStyle.Bold),
                Margin = new Padding(3, 3, 3, 3),
            };
            btnEStop.FlatAppearance.BorderSize = 0;
            btnEStop.Click += (_, __) => EmergencyStop();
            btnClearFault = MakeButton("Clear fault (re-arm, wheel released)", (_, __) => _wheel?.ClearFault());
            btnClearFault.Width = 380;
            right.Controls.Add(btnEStop);
            right.Controls.Add(btnClearFault);

            // Position
            nudTarget = MakeNumber(-1350, 1350, 1, 5, 0, 80);
            var row1 = Flow(Caption("Target°"), nudTarget,
                MakeButton("Go", (_, __) => { StopSweep(); MoveTo((double)nudTarget.Value); }));
            var row2 = Flow(
                MakeButton("◀ Lock", (_, __) => StepOrGo(-_options.RotationRangeDeg / 2, absolute: true), 58),
                MakeButton("−90", (_, __) => StepOrGo(-90), 44),
                MakeButton("−10", (_, __) => StepOrGo(-10), 44),
                MakeButton("Centre", (_, __) => StepOrGo(0, absolute: true), 56),
                MakeButton("+10", (_, __) => StepOrGo(10), 44),
                MakeButton("+90", (_, __) => StepOrGo(90), 44),
                MakeButton("Lock ▶", (_, __) => StepOrGo(_options.RotationRangeDeg / 2, absolute: true), 58));
            var row3 = Flow(
                MakeButton("Hold where it is", (_, __) => { StopSweep(); _wheel?.HoldHere(); }, 150),
                MakeButton("Release (no force)", (_, __) => { StopSweep(); _wheel?.Release(); }, 150));
            var hint = new Label
            {
                AutoSize = true, ForeColor = Color.DimGray, Margin = new Padding(3, 2, 3, 3),
                Text = "Tip: click or drag on the range bar under the wheel.",
            };
            grpPosition = Group("Position", Stack(row1, row2, row3, hint));
            right.Controls.Add(grpPosition);

            // Sweep
            nudSweepAmp = MakeNumber(5, 1350, 0, 10, _settings.SweepAmplitudeDeg, 70);
            nudSweepPeriod = MakeNumber(1, 60, 1, 0.5m, _settings.SweepPeriodSec, 60);
            btnSweep = MakeButton("Start sweep", (_, __) => { if (_sweeping) StopSweep(hold: true); else StartSweep(); }, 100);
            grpSweep = Group("Sine sweep", Flow(Caption("±°"), nudSweepAmp, Caption("period s"), nudSweepPeriod, btnSweep));
            right.Controls.Add(grpSweep);

            // Tuning
            nudStrength = MakeNumber(0, 100, 0, 5, _settings.MaxStrength * 100, 70);
            nudKp = MakeNumber(0, 0.1m, 4, 0.001m, _settings.Kp, 70);
            nudKd = MakeNumber(0, 0.01m, 5, 0.0001m, _settings.Kd, 70);
            nudDamping = MakeNumber(0, 100, 0, 5, _settings.HardwareDamping * 100, 70);
            nudSlew = MakeNumber(10, 1500, 0, 10, _settings.MaxSlewDegPerSec, 70);
            foreach (var n in new[] { nudStrength, nudKp, nudKd, nudDamping, nudSlew })
                n.ValueChanged += (_, __) => ApplyTuning();

            var tuning = new TableLayoutPanel { AutoSize = true, ColumnCount = 2 };
            AddTuningRow(tuning, "Strength cap %", nudStrength);
            AddTuningRow(tuning, "Kp (force per °)", nudKp);
            AddTuningRow(tuning, "Kd (force per °/s)", nudKd);
            AddTuningRow(tuning, "Base damper %", nudDamping);
            AddTuningRow(tuning, "Max slew °/s", nudSlew);
            var resetBtn = MakeButton("Defaults", (_, __) => ResetTuning(), 80);
            right.Controls.Add(Group("Tuning (live)", Stack(tuning, resetBtn)));
        }

        static void AddTuningRow(TableLayoutPanel t, string caption, Control c)
        {
            t.Controls.Add(Caption(caption));
            t.Controls.Add(c);
        }

        static Label Caption(string text) =>
            new Label { Text = text, AutoSize = true, Anchor = AnchorStyles.Left, Margin = new Padding(3, 7, 3, 3) };

        static Label Readout() => new Label
        {
            AutoSize = true, Font = new Font("Consolas", 11F), Margin = new Padding(3, 3, 18, 3),
        };

        static FlowLayoutPanel Flow(params Control[] controls)
        {
            var p = new FlowLayoutPanel { AutoSize = true, AutoSizeMode = AutoSizeMode.GrowAndShrink, WrapContents = false, Margin = new Padding(0) };
            p.Controls.AddRange(controls);
            return p;
        }

        static FlowLayoutPanel Stack(params Control[] controls)
        {
            var p = Flow(controls);
            p.FlowDirection = FlowDirection.TopDown;
            return p;
        }

        static GroupBox Group(string title, Control content, bool fill = false)
        {
            var g = new GroupBox
            {
                Text = title, AutoSize = true, AutoSizeMode = AutoSizeMode.GrowAndShrink,
                Padding = new Padding(6), Margin = new Padding(3, 3, 3, 8), MinimumSize = new Size(380, 0),
            };
            if (fill) g.Dock = DockStyle.Fill;
            content.Dock = DockStyle.Fill;
            g.Controls.Add(content);
            return g;
        }

        static Button MakeButton(string text, EventHandler onClick, int width = 0)
        {
            var b = new Button { Text = text, AutoSize = width == 0, Height = 28 };
            if (width > 0) b.Width = width;
            b.Click += onClick;
            return b;
        }

        static NumericUpDown MakeNumber(decimal min, decimal max, int decimals, decimal step, double value, int width) =>
            new NumericUpDown
            {
                Minimum = min, Maximum = max, DecimalPlaces = decimals, Increment = step, Width = width,
                Value = Math.Min(max, Math.Max(min, (decimal)value)), Margin = new Padding(3, 4, 3, 3),
            };

        // ------------------------------------------------------------------ actions

        void RefreshDevices()
        {
            cboDevice.Items.Clear();
            try
            {
                foreach (var d in WheelController.ListDevices()) cboDevice.Items.Add(d);
            }
            catch (Exception ex)
            {
                MessageBox.Show(this, "Could not enumerate devices: " + ex.Message, Text, MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
            var saved = cboDevice.Items.Cast<WheelDeviceInfo>().FirstOrDefault(d => d.InstanceGuid.ToString() == _settings.DeviceGuid);
            if (saved != null) cboDevice.SelectedItem = saved;
            else if (cboDevice.Items.Count > 0) cboDevice.SelectedIndex = 0;
            UpdateEnabledState(null);
        }

        void ToggleConnection()
        {
            if (_wheel != null) { Disconnect(); return; }
            if (!(cboDevice.SelectedItem is WheelDeviceInfo dev)) return;

            var wheel = new WheelController(_options);
            try
            {
                wheel.Open(dev.InstanceGuid, Handle);
            }
            catch (Exception ex)
            {
                wheel.Dispose();
                MessageBox.Show(this, "Could not open the wheel: " + ex.Message, Text, MessageBoxButtons.OK, MessageBoxIcon.Error);
                return;
            }
            _wheel = wheel;
            _device = dev;
            _settings.DeviceGuid = dev.InstanceGuid.ToString();
            _directionKnown = _settings.ForceSignByDevice.TryGetValue(_settings.DeviceGuid, out int sign);
            if (_directionKnown) _options.ForceSign = sign;
            nudTarget.Value = 0;
        }

        void Disconnect()
        {
            StopSweep();
            _wheel?.Dispose();
            _wheel = null;
            _device = null;
            _directionKnown = false;
        }

        async System.Threading.Tasks.Task DetectDirection()
        {
            if (_wheel == null) return;
            if (MessageBox.Show(this,
                    "Take your hands OFF the wheel and make sure it can turn freely.\n\n" +
                    "The motor will give the wheel a brief, gentle nudge to work out which way it pushes.",
                    "Detect direction", MessageBoxButtons.OKCancel, MessageBoxIcon.Warning) != DialogResult.OK)
                return;

            StopSweep();
            _detecting = true;
            try
            {
                int sign = await _wheel.DetectForceDirectionAsync();
                _settings.ForceSignByDevice[_device.InstanceGuid.ToString()] = sign;
                _directionKnown = true;
            }
            catch (Exception ex)
            {
                MessageBox.Show(this, "Direction detection failed: " + ex.Message, Text, MessageBoxButtons.OK, MessageBoxIcon.Warning);
            }
            finally
            {
                _detecting = false;
            }
        }

        void MoveTo(double deg)
        {
            if (!CanMove()) return;
            _wheel.MoveTo(deg);
            nudTarget.Value = Math.Min(nudTarget.Maximum, Math.Max(nudTarget.Minimum, (decimal)deg));
        }

        // Relative steps go from the current target while positioning, otherwise from the wheel's angle.
        void StepOrGo(double deg, bool absolute = false)
        {
            if (!CanMove()) return;
            StopSweep();
            var s = _wheel.Status;
            double from = s.Mode == WheelMode.Positioning ? s.TargetDeg : s.AngleDeg;
            MoveTo(absolute ? deg : from + deg);
        }

        void StartSweep()
        {
            if (!CanMove()) return;
            _sweeping = true;
            _sweepStart = _clock.Elapsed.TotalSeconds;
            btnSweep.Text = "Stop sweep";
        }

        void StopSweep(bool hold = false)
        {
            if (!_sweeping) return;
            _sweeping = false;
            btnSweep.Text = "Start sweep";
            if (hold) _wheel?.HoldHere();
        }

        void EmergencyStop()
        {
            StopSweep();
            _wheel?.EmergencyStop();
        }

        void ApplyTuning()
        {
            if (_syncingTuning) return;
            _options.MaxStrength = (double)nudStrength.Value / 100;
            _options.Kp = (double)nudKp.Value;
            _options.Kd = (double)nudKd.Value;
            _options.HardwareDamping = (double)nudDamping.Value / 100;
            _options.MaxSlewDegPerSec = (double)nudSlew.Value;
        }

        void ResetTuning()
        {
            var d = new WheelOptions();
            _syncingTuning = true;
            nudStrength.Value = (decimal)(d.MaxStrength * 100);
            nudKp.Value = (decimal)d.Kp;
            nudKd.Value = (decimal)d.Kd;
            nudDamping.Value = (decimal)(d.HardwareDamping * 100);
            nudSlew.Value = (decimal)d.MaxSlewDegPerSec;
            _syncingTuning = false;
            ApplyTuning();
        }

        bool CanMove() =>
            _wheel != null && _directionKnown && !_detecting && _wheel.Status.Mode != WheelMode.Faulted;

        // ------------------------------------------------------------------ polling

        void OnUiTick()
        {
            WheelStatus? status = _wheel?.Status;

            if (status is WheelStatus s)
            {
                if (s.Mode == WheelMode.Faulted && _sweeping) StopSweep();
                if (_sweeping)
                {
                    double t = _clock.Elapsed.TotalSeconds - _sweepStart;
                    _wheel.MoveTo((double)nudSweepAmp.Value * Math.Sin(2 * Math.PI * t / (double)nudSweepPeriod.Value));
                }

                bool positioning = s.Mode == WheelMode.Positioning;
                gauge.SetState(s.AngleDeg, s.TargetDeg, positioning, s.Force, _options.RotationRangeDeg, _options.EndStopMarginDeg);
                lblMode.Text = _detecting ? "DETECTING…" : s.Mode == WheelMode.Faulted ? "FAULT: " + s.Fault : s.Mode.ToString();
                lblMode.ForeColor = s.Mode == WheelMode.Faulted ? Color.Firebrick : positioning ? Color.FromArgb(0, 120, 215) : Color.DimGray;
                lblAngle.Text = $"angle {s.AngleDeg,7:F1}°";
                lblTarget.Text = positioning ? $"target {s.TargetDeg,7:F1}°" : "target     —";
                lblSpeed.Text = $"speed {s.VelocityDegPerSec,6:F0}°/s";
                lblForce.Text = $"force {s.Force * 100,4:F0}%";
            }
            else
            {
                gauge.SetState(0, 0, false, 0, _options.RotationRangeDeg, _options.EndStopMarginDeg);
                lblMode.Text = "Not connected";
                lblMode.ForeColor = Color.DimGray;
                lblAngle.Text = lblTarget.Text = lblSpeed.Text = lblForce.Text = "";
            }

            UpdateEnabledState(status);
        }

        void UpdateEnabledState(WheelStatus? status)
        {
            bool connected = _wheel != null;
            bool faulted = status?.Mode == WheelMode.Faulted;

            cboDevice.Enabled = btnRefresh.Enabled = !connected;
            btnConnect.Text = connected ? "Disconnect" : "Connect";
            btnConnect.Enabled = connected || cboDevice.SelectedItem != null;
            btnDetect.Enabled = connected && !faulted && !_detecting && !_sweeping;
            lblDirection.Text = !connected ? "" : _directionKnown ? $"Direction {(_options.ForceSign > 0 ? "+1" : "−1")}" : "Direction not detected yet";
            lblDirection.ForeColor = connected && !_directionKnown ? Color.Firebrick : Color.DimGray;

            bool canMove = connected && _directionKnown && !_detecting && !faulted;
            grpPosition.Enabled = grpSweep.Enabled = gauge.Interactive = canMove;
            btnEStop.Enabled = connected;
            btnEStop.BackColor = connected ? Color.FromArgb(200, 30, 30) : Color.FromArgb(200, 160, 160);
            btnClearFault.Visible = faulted;
        }

        // ------------------------------------------------------------------ keys & lifetime

        protected override bool ProcessCmdKey(ref Message msg, Keys keyData)
        {
            // Esc/Space are the emergency stop from anywhere in the window. Swallowing Space also stops
            // it doubling as "click the focused button".
            if (keyData == Keys.Escape || keyData == Keys.Space)
            {
                EmergencyStop();
                return true;
            }
            return base.ProcessCmdKey(ref msg, keyData);
        }

        protected override void OnFormClosing(FormClosingEventArgs e)
        {
            _uiTimer.Stop();
            Disconnect();
            _settings.CopyFrom(_options);
            _settings.SweepAmplitudeDeg = (double)nudSweepAmp.Value;
            _settings.SweepPeriodSec = (double)nudSweepPeriod.Value;
            _settings.Save();
            base.OnFormClosing(e);
        }
    }
}
