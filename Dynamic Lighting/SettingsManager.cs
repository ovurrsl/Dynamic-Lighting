using System;
using System.IO;
using System.Text.Json;

namespace Dynamic_Lighting
{
    public class AppSettings
    {
        public int TargetDeviceIndex { get; set; } = 0; // 0 = All, 1 = Arduino, 2 = ASUS, 3 = Corsair
        public string Mode { get; set; } = "Static"; // "Static", "Breathing", "Rainbow"
        public byte ColorR { get; set; } = 255;
        public byte ColorG { get; set; } = 0;
        public byte ColorB { get; set; } = 0;
        public double Speed { get; set; } = 1.0;
        public bool LivePreview { get; set; } = true;
    }

    public static class SettingsManager
    {
        private static readonly string SettingsFilePath = GetSettingsPath();

        private static string GetSettingsPath()
        {
            try
            {
                // Packaged execution path
                return Path.Combine(Windows.Storage.ApplicationData.Current.LocalFolder.Path, "settings.json");
            }
            catch
            {
                // Fallback unpackaged execution path
                return Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "settings.json");
            }
        }

        public static AppSettings Load()
        {
            try
            {
                if (File.Exists(SettingsFilePath))
                {
                    string json = File.ReadAllText(SettingsFilePath);
                    var settings = JsonSerializer.Deserialize<AppSettings>(json);
                    if (settings != null)
                    {
                        return settings;
                    }
                }
            }
            catch (Exception)
            {
                // Ignore load failures and return defaults
            }

            return new AppSettings();
        }

        public static void Save(AppSettings settings)
        {
            try
            {
                var options = new JsonSerializerOptions { WriteIndented = true };
                string json = JsonSerializer.Serialize(settings, options);
                string? directory = Path.GetDirectoryName(SettingsFilePath);
                if (directory != null && !Directory.Exists(directory))
                {
                    Directory.CreateDirectory(directory);
                }
                File.WriteAllText(SettingsFilePath, json);
            }
            catch (Exception)
            {
                // Ignore save failures
            }
        }
    }
}
