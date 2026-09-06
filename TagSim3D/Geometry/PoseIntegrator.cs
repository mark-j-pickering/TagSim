// Pure C# port of the dead-reckoning pose integration from TagSimSteer's "Drive the turn" effect
// (tag-steering-simulator.jsx, the `useEffect` gated on `animating`, ~line 683). No Unity
// dependency on purpose, same rationale as TagBusGeometry.cs: drop into Assets/Scripts, unit test
// standalone, or reuse from any other C# host. See TagSimSteer/CLAUDE.md, "Porting to 3D / C#".
//
// This is Euler integration of {x, y, theta} from the current speed and the curvature implied by
// GeometryResult (v / R, or 0 when IsStraight) — exactly what the JS effect does per animation
// frame. It is deliberately not "rotate about the current turn centre": TagSimSteer's CLAUDE.md
// ("Coordinate pipeline") records that alternative was tried and reverted because it breaks
// continuity every time the turn centre moves, i.e. on every steering input. Don't reintroduce it
// here either.
//
// dt clamping (the JS clamps to 50ms to guard against tab-switch/stall stutter) is left to the
// caller, same as the JS itself does it in the animation-frame callback rather than inside the
// math — a Unity MonoBehaviour has its own frame-time source (Time.deltaTime) and its own opinion
// on whether/how to clamp it.

using System;

namespace TagSim3D.Geometry
{
    /// <summary>
    /// Vehicle position/heading in world space, metres/radians. x = forward-world, y = left-world
    /// at theta = 0 (matches the chassis-local convention at the identity pose).
    /// </summary>
    public readonly struct Pose
    {
        public readonly double X;
        public readonly double Y;
        public readonly double Theta;

        public Pose(double x, double y, double theta)
        {
            X = x;
            Y = y;
            Theta = theta;
        }

        public static readonly Pose Identity = new Pose(0, 0, 0);

        /// <summary>
        /// Transform a chassis-local point into world space at this pose. Port of `poseTransform`
        /// in tag-steering-simulator.jsx — used everywhere a chassis-local geometry point (body
        /// corner, wheel centre, turn centre) needs to be placed in the world.
        /// </summary>
        public Point2D Transform(Point2D chassisLocal)
        {
            double c = Math.Cos(Theta), s = Math.Sin(Theta);
            return new Point2D(
                X + chassisLocal.X * c - chassisLocal.Y * s,
                Y + chassisLocal.X * s + chassisLocal.Y * c);
        }
    }

    public static class PoseIntegrator
    {
        /// <summary>
        /// Advance a pose by one time step of dead-reckoning integration, given the geometry
        /// evaluated for the current steering input and a speed in km/h. Pure function, no state —
        /// mirrors the JS `step()` body exactly (v = speedKmh * 1000/3600 m/s, omega = v/R or 0
        /// when IsStraight, then Euler-integrate x/y/theta by dt).
        /// </summary>
        public static Pose Step(Pose prev, GeometryResult geom, double speedKmh, double dt)
        {
            double v = speedKmh * 1000.0 / 3600.0;
            double omega = geom.IsStraight ? 0 : v / geom.R.Value;
            return new Pose(
                prev.X + v * dt * Math.Cos(prev.Theta),
                prev.Y + v * dt * Math.Sin(prev.Theta),
                prev.Theta + omega * dt);
        }
    }
}
