using System.IO;
using System.Text.Json;

namespace WebView2Automation;

/// <summary>
/// Small, global (not per-profile) window-layout preferences — things like
/// panel visibility that describe how the app looks, not which Hoops Arena
/// account is signed in. Shared across profiles; each window reads it once
/// on startup and writes it back whenever the user changes something, but
/// windows already open do not live-sync with each other.
/// </summary>
internal sealed class UiSettings
{
    public bool RightPanelCollapsed { get; set; }

    private static string SettingsPath { get; } = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "KaHoopsArena", "ui-settings.json");

    public static UiSettings Load()
    {
        try
        {
            if (File.Exists(SettingsPath))
            {
                var settings = JsonSerializer.Deserialize<UiSettings>(File.ReadAllText(SettingsPath));
                if (settings is not null) return settings;
            }
        }
        catch
        {
            // Corrupt or unreadable — fall back to defaults rather than crash startup.
        }
        return new UiSettings();
    }

    public void Save()
    {
        try
        {
            var dir = Path.GetDirectoryName(SettingsPath);
            if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
            File.WriteAllText(SettingsPath, JsonSerializer.Serialize(this));
        }
        catch
        {
            // Best effort — a failed save just means the default next launch.
        }
    }
}
