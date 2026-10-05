using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Windows.Forms;

namespace TagSimWheel.Gui
{
    /// <summary>
    /// Shows the wheel: a rotating rim/spokes graphic for the live angle, and below it a linear bar
    /// across the full lock-to-lock range with the angle, target and end-stop margins. The bar is
    /// unambiguous past ±180° (the dial wraps), and clicking/dragging on it sets a new target.
    /// </summary>
    sealed class WheelGauge : Control
    {
        static readonly Color RimColor = Color.FromArgb(45, 45, 48);
        static readonly Color AngleColor = Color.FromArgb(0, 120, 215);
        static readonly Color TargetColor = Color.FromArgb(230, 120, 0);
        static readonly Color MarginColor = Color.FromArgb(70, 200, 60, 60);

        double _angle, _target, _force, _range = 900, _margin = 15;
        bool _showTarget, _dragging;

        public WheelGauge()
        {
            SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer |
                     ControlStyles.ResizeRedraw | ControlStyles.UserPaint, true);
            BackColor = Color.White;
        }

        /// <summary>When true, clicking/dragging the range bar raises <see cref="TargetPicked"/>.</summary>
        public bool Interactive { get; set; }

        /// <summary>Raised with a target angle (degrees) while the user clicks or drags on the range bar.</summary>
        public event EventHandler<double> TargetPicked;

        public void SetState(double angleDeg, double targetDeg, bool showTarget, double force, double rangeDeg, double marginDeg)
        {
            _angle = angleDeg;
            _target = targetDeg;
            _showTarget = showTarget;
            _force = force;
            _range = Math.Max(1, rangeDeg);
            _margin = marginDeg;
            Invalidate();
        }

        int BarHeight => (int)(70 * DeviceDpi / 96f);
        float S(float px) => px * DeviceDpi / 96f;

        Rectangle BarRect
        {
            get
            {
                int pad = (int)S(24);
                return new Rectangle(pad, Height - BarHeight + (int)S(18), Math.Max(10, Width - 2 * pad), (int)S(14));
            }
        }

        float XForDeg(Rectangle bar, double deg) =>
            bar.Left + (float)((deg + _range / 2) / _range) * bar.Width;

        protected override void OnPaint(PaintEventArgs e)
        {
            var g = e.Graphics;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.Clear(BackColor);

            DrawDial(g);
            DrawBar(g);
        }

        void DrawDial(Graphics g)
        {
            int dialArea = Height - BarHeight;
            float d = Math.Min(Width, dialArea) - S(40);
            if (d < 40) return;
            float cx = Width / 2f, cy = dialArea / 2f + S(4);
            float r = d / 2;

            // Target pointer: a triangle just outside the rim (wraps past ±180°, the bar shows the true value).
            if (_showTarget)
            {
                var state = g.Save();
                g.TranslateTransform(cx, cy);
                g.RotateTransform((float)_target);
                using var b = new SolidBrush(TargetColor);
                g.FillPolygon(b, new[] { new PointF(0, -r - S(2)), new PointF(-S(8), -r - S(16)), new PointF(S(8), -r - S(16)) });
                g.Restore(state);
            }

            var st = g.Save();
            g.TranslateTransform(cx, cy);
            g.RotateTransform((float)_angle);   // +ve = clockwise = turning right
            float rimW = Math.Max(6, r * 0.14f);
            using (var rim = new Pen(RimColor, rimW))
                g.DrawEllipse(rim, -r + rimW / 2, -r + rimW / 2, 2 * r - rimW, 2 * r - rimW);
            using (var spoke = new Pen(RimColor, rimW * 0.8f) { StartCap = LineCap.Round, EndCap = LineCap.Round })
            {
                float hub = r * 0.3f;
                g.DrawLine(spoke, -r + rimW, 0, -hub, 0);
                g.DrawLine(spoke, hub, 0, r - rimW, 0);
                g.DrawLine(spoke, 0, hub, 0, r - rimW);
                using var hubBrush = new SolidBrush(RimColor);
                g.FillEllipse(hubBrush, -hub, -hub, 2 * hub, 2 * hub);
            }
            // Top-dead-centre stripe, as on a real wheel.
            using (var stripe = new Pen(Color.FromArgb(220, 40, 40), rimW))
                g.DrawArc(stripe, -r + rimW / 2, -r + rimW / 2, 2 * r - rimW, 2 * r - rimW, -96, 12);
            g.Restore(st);

            using var font = new Font(Font.FontFamily, Math.Max(8, r * 0.1f), FontStyle.Bold, GraphicsUnit.Pixel);
            using var fb = new SolidBrush(Color.White);
            var text = $"{_angle:+0.0;-0.0;0.0}°";
            var sz = g.MeasureString(text, font);
            g.DrawString(text, font, fb, cx - sz.Width / 2, cy - sz.Height / 2);
        }

        void DrawBar(Graphics g)
        {
            var bar = BarRect;
            double half = _range / 2;

            using (var track = new SolidBrush(Color.FromArgb(230, 230, 232)))
                g.FillRectangle(track, bar);
            using (var m = new SolidBrush(MarginColor))
            {
                float w = (float)(_margin / _range) * bar.Width;
                g.FillRectangle(m, bar.Left, bar.Top, w, bar.Height);
                g.FillRectangle(m, bar.Right - w, bar.Top, w, bar.Height);
            }

            // Ticks every 90°, labelled every 180°.
            using var tickPen = new Pen(Color.Gray, 1);
            using var smallFont = new Font(Font.FontFamily, S(10), GraphicsUnit.Pixel);
            using var textBrush = new SolidBrush(Color.DimGray);
            for (double deg = -Math.Floor(half / 90) * 90; deg <= half + 1e-6; deg += 90)
            {
                float x = XForDeg(bar, deg);
                bool major = Math.Abs(deg % 180) < 1e-6;
                g.DrawLine(deg == 0 ? Pens.Black : tickPen, x, bar.Bottom, x, bar.Bottom + S(major ? 8 : 4));
                if (major)
                {
                    string label = deg.ToString("+0;-0;0");
                    var sz = g.MeasureString(label, smallFont);
                    g.DrawString(label, smallFont, textBrush, x - sz.Width / 2, bar.Bottom + S(9));
                }
            }

            // Force bar, centred above the track.
            float fx = XForDeg(bar, 0);
            float fw = (float)(Math.Max(-1, Math.Min(1, _force)) * bar.Width / 2);
            using (var fbrush = new SolidBrush(Color.FromArgb(160, 120, 60, 200)))
                g.FillRectangle(fbrush, Math.Min(fx, fx + fw), bar.Top - S(8), Math.Abs(fw), S(5));

            if (_showTarget)
            {
                float tx = XForDeg(bar, _target);
                using var tb = new SolidBrush(TargetColor);
                g.FillPolygon(tb, new[] { new PointF(tx, bar.Bottom), new PointF(tx - S(7), bar.Bottom + S(10)), new PointF(tx + S(7), bar.Bottom + S(10)) });
            }

            float ax = XForDeg(bar, Math.Max(-half, Math.Min(half, _angle)));
            using (var ab = new SolidBrush(AngleColor))
                g.FillRectangle(ab, ax - S(3), bar.Top - S(3), S(6), bar.Height + S(6));
        }

        double DegForX(int x)
        {
            var bar = BarRect;
            double frac = (x - bar.Left) / (double)bar.Width;
            return Math.Round((frac - 0.5) * _range);
        }

        protected override void OnMouseDown(MouseEventArgs e)
        {
            base.OnMouseDown(e);
            var hit = BarRect;
            hit.Inflate(0, (int)S(14));
            if (Interactive && e.Button == MouseButtons.Left && hit.Contains(e.Location))
            {
                _dragging = true;
                Capture = true;
                TargetPicked?.Invoke(this, DegForX(e.X));
            }
        }

        protected override void OnMouseMove(MouseEventArgs e)
        {
            base.OnMouseMove(e);
            if (_dragging && Interactive) TargetPicked?.Invoke(this, DegForX(e.X));
        }

        protected override void OnMouseUp(MouseEventArgs e)
        {
            base.OnMouseUp(e);
            _dragging = false;
            Capture = false;
        }
    }
}
