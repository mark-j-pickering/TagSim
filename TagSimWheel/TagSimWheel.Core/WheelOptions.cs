namespace TagSimWheel
{
    /// <summary>
    /// Tuning and safety limits for <see cref="WheelController"/>. Every property may be changed
    /// while the controller is running; the control loop re-reads them each tick.
    /// </summary>
    public sealed class WheelOptions
    {
        /// <summary>
        /// Lock-to-lock rotation the wheel base is set to (Moza Pit House "Steering wheel rotation").
        /// Must match the base setting, otherwise angles are scaled wrongly: DirectInput only reports
        /// the axis as a fraction of this range.
        /// </summary>
        public double RotationRangeDeg { get; set; } = 900;

        /// <summary>Hard cap on motor output, 0..1 of the base's maximum torque. Start low.</summary>
        public double MaxStrength { get; set; } = 0.25;

        /// <summary>Proportional gain: fraction of full force per degree of position error.</summary>
        public double Kp { get; set; } = 0.01;

        /// <summary>Derivative gain: fraction of full force per deg/s of wheel speed (software damping).</summary>
        public double Kd { get; set; } = 0.0004;

        /// <summary>
        /// Coefficient (0..1) of the base's own hardware damper effect, which runs inside the base at a
        /// far higher rate than this loop and keeps it from oscillating. Applies while the device is open,
        /// including when released, so the wheel also feels slightly weighted by hand.
        /// </summary>
        public double HardwareDamping { get; set; } = 0.10;

        /// <summary>Maximum rate the commanded position moves toward the target, deg/s.</summary>
        public double MaxSlewDegPerSec { get; set; } = 180;

        /// <summary>Force cap ramps from 0 to <see cref="MaxStrength"/> over this time whenever force is engaged.</summary>
        public double SoftStartSeconds { get; set; } = 1.0;

        /// <summary>Above this wheel speed (deg/s) the controller faults and drops all force.</summary>
        public double FaultSpeedDegPerSec { get; set; } = 1500;

        /// <summary>Targets are kept this far inside each end stop.</summary>
        public double EndStopMarginDeg { get; set; } = 15;

        /// <summary>
        /// +1 or -1: which constant-force sign increases the reported angle. Device/driver dependent;
        /// set it with <see cref="WheelController.DetectForceDirectionAsync"/> or from saved settings.
        /// </summary>
        public int ForceSign { get; set; } = 1;

        /// <summary>Control loop rate. 200-500 Hz is typical for games.</summary>
        public int UpdateHz { get; set; } = 250;
    }
}
