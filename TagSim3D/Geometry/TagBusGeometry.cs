// Pure C# port of `computeGeometry` (and its helpers) from
// TagSimSteer/tag-steering-simulator.jsx. No Unity dependency on purpose — this
// is plain .NET so it can be dropped into a Unity project's Assets folder, unit
// tested standalone, or reused from any other C# host without dragging in
// engine types. See TagSimSteer/CLAUDE.md, "Porting to 3D / C#" for the
// process this file is part of: the JS file stays the source of truth for the
// 2D sim and for any future geometry bug fixes/tweaks, which get flagged there
// and mirrored here — this port is not meant to silently drift from it.
//
// Domain model, conventions, and wheel numbering are documented in full in
// TagSimSteer/CLAUDE.md ("Domain model", "Wheel numbering convention") and are
// preserved here unchanged:
//   - Chassis-local frame: x = forward, y = left (nearside positive, offside
//     negative). Every method here takes/returns points in this frame.
//   - Steady-state cornering kinematics only (bicycle model extended to a
//     third, counter-steering tag axle) — no tyre slip, no inertia.
//   - Wheels: 1/2 = front (nearside/offside, steer), 3/4 = drive nearside dual
//     pair (3 outermost), 5/6 = drive offside dual pair (6 outermost),
//     7/8 = tag (nearside/offside, counter-steer). Odd = nearside = left.
//   - `deltaFDeg` here uses the raw geometry sign convention (positive = steer
//     toward nearside) — NOT the UI-inverted convention TagSimSteer's slider
//     uses (`deltaFdeg = -steerInput`, so dragging right steers right). Any UI
//     layer built on top of this engine makes that inversion itself; it is
//     deliberately not baked into the geometry engine.
//   - `IsStraight` is `deltaFDeg == 0` exactly, no tolerance. Do not
//     reintroduce one — see TagSimSteer/CLAUDE.md for why (an earlier version
//     rounded small angles to "straight" and lost curvature near dead ahead).
//
// `innerDriveRadius` from the JS version is not ported: TagSimSteer/CLAUDE.md
// flags it as computed-but-unused dead code in the source.

using System;
using System.Collections.Generic;

namespace TagSim3D.Geometry
{
    /// <summary>Chassis-local (or world) 2D point. x = forward, y = left, in metres.</summary>
    public readonly struct Point2D
    {
        public readonly double X;
        public readonly double Y;

        public Point2D(double x, double y)
        {
            X = x;
            Y = y;
        }

        public static Point2D operator +(Point2D a, Point2D b) => new Point2D(a.X + b.X, a.Y + b.Y);
    }

    /// <summary>Fixed physical dimensions of the bus (metres). Matches TagSimSteer's geometry sliders.</summary>
    public readonly struct BusParams
    {
        /// <summary>Front axle to drive axle wheelbase.</summary>
        public readonly double Lfd;
        /// <summary>Drive axle to tag axle wheelbase.</summary>
        public readonly double Ldt;
        /// <summary>Front overhang (drive-axle-relative front body extent beyond Lfd).</summary>
        public readonly double Fo;
        /// <summary>Rear overhang (drive-axle-relative rear body extent beyond Ldt).</summary>
        public readonly double Ro;
        /// <summary>Body width.</summary>
        public readonly double Wb;
        /// <summary>Axle track width (wheel centre to wheel centre).</summary>
        public readonly double Tw;

        public BusParams(double lfd, double ldt, double fo, double ro, double wb, double tw)
        {
            Lfd = lfd; Ldt = ldt; Fo = fo; Ro = ro; Wb = wb; Tw = tw;
        }
    }

    /// <summary>Steering/throttle input for one geometry evaluation.</summary>
    public readonly struct SteeringInput
    {
        /// <summary>Front steer angle in degrees, raw geometry sign convention (positive = toward nearside).</summary>
        public readonly double DeltaFDeg;
        /// <summary>0..1 scale from locked-straight (0) to ideal tag steer (1).</summary>
        public readonly double TagRatio;
        public readonly bool LockoutOn;
        public readonly double LockoutSpeed;
        public readonly double Speed;

        public SteeringInput(double deltaFDeg, double tagRatio, bool lockoutOn, double lockoutSpeed, double speed)
        {
            DeltaFDeg = deltaFDeg; TagRatio = tagRatio; LockoutOn = lockoutOn; LockoutSpeed = lockoutSpeed; Speed = speed;
        }
    }

    /// <summary>Body footprint corners, chassis-local.</summary>
    public readonly struct BodyCorners
    {
        public readonly Point2D FL, FR, RL, RR;
        public BodyCorners(Point2D fl, Point2D fr, Point2D rl, Point2D rr) { FL = fl; FR = fr; RL = rl; RR = rr; }
    }

    /// <summary>Wheel hub centres, chassis-local (single point per side; duals are handled separately).</summary>
    public readonly struct WheelCenters
    {
        public readonly Point2D FrontL, FrontR, DriveL, DriveR, TagL, TagR;
        public WheelCenters(Point2D frontL, Point2D frontR, Point2D driveL, Point2D driveR, Point2D tagL, Point2D tagR)
        {
            FrontL = frontL; FrontR = frontR; DriveL = driveL; DriveR = driveR; TagL = tagL; TagR = tagR;
        }
    }

    /// <summary>Full result of one geometry evaluation — mirrors `computeGeometry`'s return object.</summary>
    public sealed class GeometryResult
    {
        public bool IsStraight;
        public double DeltaFDeg;
        public double DeltaF; // radians
        /// <summary>Turn radius about the drive axle. Null when IsStraight.</summary>
        public double? R;
        public double IdealDeltaT;
        public double AppliedDeltaT;
        public bool TagLocked;
        public double ScrubDeg;

        public BodyCorners BodyCorners;
        public WheelCenters WheelCenters;
        /// <summary>Turn centre in chassis-local coordinates, (0, R). Null when IsStraight.</summary>
        public Point2D? C;

        /// <summary>
        /// Distance from C to every named reference point (body corners, wheel centres, the three
        /// drive-axle dual points w3/w4/w6, and each steered wheel's four rotated footprint
        /// corners as "&lt;wheelKey&gt;_corner0".."_corner3"). Empty when IsStraight — there is no
        /// turn centre to measure radii from.
        /// </summary>
        public Dictionary<string, double> Radii = new Dictionary<string, double>();

        public double OuterRadius;
        /// <summary>Drive axle's own swept width, |radii[w3] - radii[w6]|. Null when IsStraight.</summary>
        public double? OffTracking;
        public double? TurningDiameter;
        public double FrontOuterWheelRadius;

        /// <summary>"Mowing the grass": how far body corner FL/FR swings past wheel 1/2's own path.</summary>
        public double Mow1, Mow2;
        /// <summary>Tail swing: how far body corner RL/RR sits from tag wheel 7/8's own path.</summary>
        public double TailSwing7, TailSwing8;

        public double StraightHalfExtent;
    }

    public static class TagBusGeometry
    {
        // ---------- wheel footprint constants (metres) ----------
        // Matches WHEEL_HALF_LEN/WHEEL_HALF_W/DUAL_GAP in tag-steering-simulator.jsx. DUAL_HALF_LEN/
        // DUAL_HALF_W are not ported — the JS file itself flags them as dead code (all 8 wheels
        // render at the same physical size now).
        public const double WheelHalfLen = 0.42;
        public const double WheelHalfW = 0.16;
        /// <summary>Centre-to-centre spacing of a dual (twin) tyre pair.</summary>
        public const double DualGap = 0.28;

        public static double ToRadians(double deg) => deg * Math.PI / 180.0;
        public static double ToDegrees(double rad) => rad * 180.0 / Math.PI;

        public static Point2D Rotate(Point2D p, double angleRad)
        {
            double c = Math.Cos(angleRad), s = Math.Sin(angleRad);
            return new Point2D(p.X * c - p.Y * s, p.X * s + p.Y * c);
        }

        private static double Distance(Point2D a, Point2D b) => Math.Sqrt((a.X - b.X) * (a.X - b.X) + (a.Y - b.Y) * (a.Y - b.Y));

        private static Point2D[] WheelLocalPoints(double halfLen, double halfW) => new[]
        {
            new Point2D(halfLen, halfW), new Point2D(halfLen, -halfW),
            new Point2D(-halfLen, -halfW), new Point2D(-halfLen, halfW),
        };

        /// <summary>The wheel's four footprint corners, world/chassis frame, after rotating by its own steer angle and translating to its centre.</summary>
        public static Point2D[] WheelStaticCorners(Point2D center, double angleRad, double halfLen = WheelHalfLen, double halfW = WheelHalfW)
        {
            var local = WheelLocalPoints(halfLen, halfW);
            var result = new Point2D[4];
            for (int i = 0; i < 4; i++)
            {
                var r = Rotate(local[i], angleRad);
                result[i] = new Point2D(center.X + r.X, center.Y + r.Y);
            }
            return result;
        }

        /// <summary>
        /// Evaluate steady-state cornering geometry for one instant: wheel/body positions, turn
        /// radius, off-tracking, mow1/mow2, tailSwing7/8, scrub angle. Pure function, no state.
        /// </summary>
        public static GeometryResult Compute(BusParams p, SteeringInput s)
        {
            bool isStraight = s.DeltaFDeg == 0; // exact, deliberately no tolerance — see file header
            double deltaF = ToRadians(s.DeltaFDeg);

            double? R = null;
            double idealDeltaT = 0;
            if (!isStraight)
            {
                double r = p.Lfd / Math.Tan(deltaF);
                R = r;
                idealDeltaT = -Math.Atan(p.Ldt / r);
            }
            bool tagLocked = s.LockoutOn && s.Speed >= s.LockoutSpeed;
            double appliedDeltaT = isStraight ? 0 : (tagLocked ? 0 : idealDeltaT * s.TagRatio);
            double scrubDeg = isStraight ? 0 : ToDegrees(idealDeltaT - appliedDeltaT);

            double halfW = p.Wb / 2, halfT = p.Tw / 2;
            var bodyCorners = new BodyCorners(
                fl: new Point2D(p.Lfd + p.Fo, halfW),
                fr: new Point2D(p.Lfd + p.Fo, -halfW),
                rl: new Point2D(-(p.Ldt + p.Ro), halfW),
                rr: new Point2D(-(p.Ldt + p.Ro), -halfW));
            var wheelCenters = new WheelCenters(
                frontL: new Point2D(p.Lfd, halfT), frontR: new Point2D(p.Lfd, -halfT),
                driveL: new Point2D(0, halfT), driveR: new Point2D(0, -halfT),
                tagL: new Point2D(-p.Ldt, halfT), tagR: new Point2D(-p.Ldt, -halfT));

            var result = new GeometryResult
            {
                IsStraight = isStraight,
                DeltaFDeg = s.DeltaFDeg,
                DeltaF = deltaF,
                R = R,
                IdealDeltaT = idealDeltaT,
                AppliedDeltaT = appliedDeltaT,
                TagLocked = tagLocked,
                ScrubDeg = scrubDeg,
                BodyCorners = bodyCorners,
                WheelCenters = wheelCenters,
            };

            Point2D w3Center = new Point2D(0, halfT + DualGap / 2); // leftmost (nearside outer)
            Point2D w4Center = new Point2D(0, halfT - DualGap / 2); // nearside inner
            Point2D w6Center = new Point2D(0, -halfT - DualGap / 2); // rightmost (offside outer)

            if (!isStraight)
            {
                var c = new Point2D(0, R.Value);
                result.C = c;

                var allPts = new Dictionary<string, Point2D>
                {
                    ["FL"] = bodyCorners.FL, ["FR"] = bodyCorners.FR, ["RL"] = bodyCorners.RL, ["RR"] = bodyCorners.RR,
                    ["frontL"] = wheelCenters.FrontL, ["frontR"] = wheelCenters.FrontR,
                    ["driveL"] = wheelCenters.DriveL, ["driveR"] = wheelCenters.DriveR,
                    ["tagL"] = wheelCenters.TagL, ["tagR"] = wheelCenters.TagR,
                    ["w3"] = w3Center, ["w4"] = w4Center, ["w6"] = w6Center,
                };

                // Front and tag wheels steer, so their corners can swing outside their own centre's
                // radius at high lock — fold the actual rotated footprint in, not just the centre
                // point (matches JS: "so wheels like #2 are fully covered by the outer envelope").
                var steeredWheels = new (string Key, Point2D Center, double Angle)[]
                {
                    ("frontL", wheelCenters.FrontL, deltaF),
                    ("frontR", wheelCenters.FrontR, deltaF),
                    ("tagL", wheelCenters.TagL, appliedDeltaT),
                    ("tagR", wheelCenters.TagR, appliedDeltaT),
                };
                foreach (var sw in steeredWheels)
                {
                    var corners = WheelStaticCorners(sw.Center, sw.Angle);
                    for (int i = 0; i < corners.Length; i++)
                        allPts[sw.Key + "_corner" + i] = corners[i];
                }

                foreach (var kv in allPts)
                    result.Radii[kv.Key] = Distance(kv.Value, c);

                double outerRadius = double.MinValue;
                foreach (var v in result.Radii.Values) outerRadius = Math.Max(outerRadius, v);
                result.OuterRadius = outerRadius;

                // #3 is the inner drive wheel on a left turn, #6 on a right turn (unused beyond the
                // off-tracking calc below — matches JS, which computes but doesn't return this).
                result.OffTracking = Math.Abs(result.Radii["w3"] - result.Radii["w6"]);
                result.TurningDiameter = 2 * outerRadius;

                double frontOuter = double.MinValue;
                foreach (var kv in result.Radii)
                    if (kv.Key.StartsWith("frontL_corner") || kv.Key.StartsWith("frontR_corner"))
                        frontOuter = Math.Max(frontOuter, kv.Value);
                result.FrontOuterWheelRadius = frontOuter;

                // "Mowing the grass": how far the front overhang corner (FL/FR) swings past its own
                // wheel's path (1 or 2) — positive means the nose cuts in beyond where that wheel tracks.
                result.Mow1 = result.Radii["frontL"] - result.Radii["FL"];
                result.Mow2 = result.Radii["frontR"] - result.Radii["FR"];
                // Tail swing: how far each rear corner sits from its own same-side tag wheel's path
                // (RL vs #7 nearside, RR vs #8 offside).
                result.TailSwing7 = result.Radii["RL"] - result.Radii["tagL"];
                result.TailSwing8 = result.Radii["RR"] - result.Radii["tagR"];
            }

            result.StraightHalfExtent = ((p.Lfd + p.Fo + p.Ldt + p.Ro) / 2) * 1.35;

            return result;
        }
    }
}
