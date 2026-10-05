using System;

namespace TagSimWheel
{
    /// <summary>A force-feedback game controller found by <see cref="WheelController.ListDevices"/>.</summary>
    public sealed class WheelDeviceInfo
    {
        public WheelDeviceInfo(Guid instanceGuid, string name, string productName)
        {
            InstanceGuid = instanceGuid;
            Name = name;
            ProductName = productName;
        }

        public Guid InstanceGuid { get; }
        public string Name { get; }
        public string ProductName { get; }

        public override string ToString() => Name;
    }

    public enum WheelMode
    {
        /// <summary>No position control: zero force (the hardware damper still applies).</summary>
        Released,
        /// <summary>Motor drives the wheel toward <see cref="WheelStatus.TargetDeg"/>.</summary>
        Positioning,
        /// <summary>Latched after a fault or <see cref="WheelController.EmergencyStop"/>; call ClearFault to re-arm.</summary>
        Faulted,
    }

    /// <summary>One snapshot of the control loop. Angles are degrees from centre as the device reports them.</summary>
    public readonly struct WheelStatus
    {
        public WheelStatus(WheelMode mode, double angleDeg, double velocityDegPerSec, double setpointDeg,
                           double targetDeg, double force, string fault)
        {
            Mode = mode;
            AngleDeg = angleDeg;
            VelocityDegPerSec = velocityDegPerSec;
            SetpointDeg = setpointDeg;
            TargetDeg = targetDeg;
            Force = force;
            Fault = fault;
        }

        public WheelMode Mode { get; }
        public double AngleDeg { get; }
        public double VelocityDegPerSec { get; }
        /// <summary>Rate-limited position the loop is currently steering toward on the way to the target.</summary>
        public double SetpointDeg { get; }
        public double TargetDeg { get; }
        /// <summary>Commanded force, -1..1 of full scale (after the strength cap).</summary>
        public double Force { get; }
        public string Fault { get; }
    }
}
