using System;
using System.Collections.Generic;
using System.IO;
using System.Text.Json;

namespace TagSimWheel.Gui
{
    /// <summary>GUI settings persisted to %AppData%\TagSimWheel\settings.json between runs.</summary>
    sealed class AppSettings
    {
        public string DeviceGuid { get; set; }
        public double RotationRangeDeg { get; set; } = 900;

        // Tuning (mirrors WheelOptions; defaults come from there on first run).
        public double MaxStrength { get; set; } = new WheelOptions().MaxStrength;
        public double Kp { get; set; } = new WheelOptions().Kp;
        public double Kd { get; set; } = new WheelOptions().Kd;
        public double HardwareDamping { get; set; } = new WheelOptions().HardwareDamping;
        public double MaxSlewDegPerSec { get; set; } = new WheelOptions().MaxSlewDegPerSec;

        public double SweepAmplitudeDeg { get; set; } = 90;
        public double SweepPeriodSec { get; set; } = 6;

        /// <summary>Detected force direction per device instance GUID, so detection is a one-off.</summary>
        public Dictionary<string, int> ForceSignByDevice { get; set; } = new Dictionary<string, int>();

        static string FilePath =>
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "TagSimWheel", "settings.json");

        public static AppSettings Load()
        {
            try
            {
                if (File.Exists(FilePath))
                    return JsonSerializer.Deserialize<AppSettings>(File.ReadAllText(FilePath)) ?? new AppSettings();
            }
            catch (Exception) { /* corrupt or unreadable - fall back to defaults */ }
            return new AppSettings();
        }

        public void Save()
        {
            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(FilePath));
                File.WriteAllText(FilePath, JsonSerializer.Serialize(this, new JsonSerializerOptions { WriteIndented = true }));
            }
            catch (Exception) { /* settings are a convenience; never fail closing over them */ }
        }

        public WheelOptions ToOptions() => new WheelOptions
        {
            RotationRangeDeg = RotationRangeDeg,
            MaxStrength = MaxStrength,
            Kp = Kp,
            Kd = Kd,
            HardwareDamping = HardwareDamping,
            MaxSlewDegPerSec = MaxSlewDegPerSec,
        };

        public void CopyFrom(WheelOptions o)
        {
            RotationRangeDeg = o.RotationRangeDeg;
            MaxStrength = o.MaxStrength;
            Kp = o.Kp;
            Kd = o.Kd;
            HardwareDamping = o.HardwareDamping;
            MaxSlewDegPerSec = o.MaxSlewDegPerSec;
        }
    }
}
