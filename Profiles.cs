using System.Diagnostics;
using System.IO;
using System.Text;

namespace WebView2Automation;

/// <summary>
/// One acquired profile: its name, its isolated WebView2 user data folder, and
/// the cross-process lock proving no other window is using it.
///
/// Dispose releases the lock, so the profile becomes available again.
/// </summary>
internal sealed class ProfileSession : IDisposable
{
    public string Name { get; }
    public string UserDataFolder { get; }

    private FileStream? _lock;

    internal ProfileSession(string name, string userDataFolder, FileStream lockStream)
    {
        Name = name;
        UserDataFolder = userDataFolder;
        _lock = lockStream;
    }

    public void Dispose()
    {
        try { _lock?.Dispose(); }
        catch { /* releasing a lock must never throw on shutdown */ }
        _lock = null;
    }
}

/// <summary>
/// Profile discovery and acquisition.
///
/// Each profile maps to its own directory, handed to
/// CoreWebView2Environment.CreateAsync as the user data folder. Cookies,
/// localStorage, IndexedDB and cache all live inside it, so two windows on
/// different profiles cannot see or clobber each other's session.
///
/// A folder can only be used by one process at a time — WebView2 fails with an
/// opaque error otherwise — hence the lock file.
/// </summary>
internal static class ProfileManager
{
    public const string DefaultProfileName = "Default";

    /// <summary>%LOCALAPPDATA%\KaHoopsArena\Profiles</summary>
    public static string ProfilesRoot { get; } = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "KaHoopsArena", "Profiles");

    /// <summary>Where pre-profile builds kept their single session.</summary>
    private static string LegacyUserDataFolder { get; } = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "WebView2Automation", "UserData");

    // ------------------------------------------------------------------
    // Command line
    // ------------------------------------------------------------------

    /// <summary>
    /// Reads --profile=Name, --profile Name, or -p Name from the command line.
    /// Returns null when absent, which is the signal to show the picker.
    /// </summary>
    public static string? ParseProfileArgument(string[] args)
    {
        if (args is null) return null;

        for (var i = 0; i < args.Length; i++)
        {
            var arg = args[i];

            if (arg.StartsWith("--profile=", StringComparison.OrdinalIgnoreCase))
                return Sanitise(arg["--profile=".Length..]);

            if (arg.StartsWith("/profile:", StringComparison.OrdinalIgnoreCase))
                return Sanitise(arg["/profile:".Length..]);

            var isFlag = arg.Equals("--profile", StringComparison.OrdinalIgnoreCase)
                      || arg.Equals("-p", StringComparison.OrdinalIgnoreCase);

            if (isFlag && i + 1 < args.Length)
                return Sanitise(args[i + 1]);
        }

        return null;
    }

    /// <summary>True when --pick-profile forces the chooser even with a name supplied.</summary>
    public static bool ForcePicker(string[] args) =>
        args?.Any(a => a.Equals("--pick-profile", StringComparison.OrdinalIgnoreCase)) == true;

    // ------------------------------------------------------------------
    // Paths
    // ------------------------------------------------------------------

    /// <summary>
    /// Strips anything that cannot appear in a folder name, and blocks path
    /// traversal — a profile name arriving from the command line is untrusted
    /// input that gets turned into a filesystem path.
    /// </summary>
    public static string Sanitise(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw)) return DefaultProfileName;

        var trimmed = raw.Trim().Trim('"');
        var invalid = Path.GetInvalidFileNameChars();
        var sb = new StringBuilder(trimmed.Length);

        foreach (var c in trimmed)
            if (!invalid.Contains(c) && c != Path.DirectorySeparatorChar && c != Path.AltDirectorySeparatorChar)
                sb.Append(c);

        var cleaned = sb.ToString().Trim(' ', '.');
        if (cleaned.Length == 0) return DefaultProfileName;
        if (cleaned.Length > 48) cleaned = cleaned[..48];

        // Reserved device names would produce an unusable directory.
        var reserved = new[] { "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "LPT1", "LPT2" };
        if (reserved.Contains(cleaned, StringComparer.OrdinalIgnoreCase))
            cleaned = "_" + cleaned;

        return cleaned;
    }

    public static string GetProfilePath(string name) =>
        Path.Combine(ProfilesRoot, Sanitise(name));

    private static string GetLockPath(string name) =>
        Path.Combine(ProfilesRoot, Sanitise(name) + ".lock");

    /// <summary>Profile names already on disk, alphabetically, Default first.</summary>
    public static IReadOnlyList<string> ListProfiles()
    {
        try
        {
            Directory.CreateDirectory(ProfilesRoot);

            var names = Directory.GetDirectories(ProfilesRoot)
                                 .Select(Path.GetFileName)
                                 .Where(n => !string.IsNullOrWhiteSpace(n))
                                 .Select(n => n!)
                                 .OrderBy(n => n, StringComparer.OrdinalIgnoreCase)
                                 .ToList();

            if (!names.Contains(DefaultProfileName, StringComparer.OrdinalIgnoreCase))
                names.Insert(0, DefaultProfileName);
            else
            {
                names.RemoveAll(n => n.Equals(DefaultProfileName, StringComparison.OrdinalIgnoreCase));
                names.Insert(0, DefaultProfileName);
            }

            return names;
        }
        catch
        {
            return new[] { DefaultProfileName };
        }
    }

    /// <summary>Cheap check for the picker's "in use" marker. Inherently racy —
    /// TryAcquire is the authority.</summary>
    public static bool IsInUse(string name)
    {
        var path = GetLockPath(name);
        if (!File.Exists(path)) return false;

        try
        {
            using var _ = new FileStream(path, FileMode.Open, FileAccess.ReadWrite, FileShare.None);
            return false;   // opened exclusively, so nobody holds it
        }
        catch (IOException)
        {
            return true;
        }
        catch
        {
            return false;
        }
    }

    // ------------------------------------------------------------------
    // Acquisition
    // ------------------------------------------------------------------

    /// <summary>
    /// Creates the profile directory if needed and takes an exclusive lock.
    /// Returns null when another window already holds it.
    /// </summary>
    public static ProfileSession? TryAcquire(string name, out string error)
    {
        error = string.Empty;
        var clean = Sanitise(name);

        try
        {
            Directory.CreateDirectory(ProfilesRoot);

            var folder = GetProfilePath(clean);
            var isNew = !Directory.Exists(folder);
            Directory.CreateDirectory(folder);

            // First run of the profile build: adopt the old single-session
            // folder as Default so existing logins survive the upgrade.
            if (isNew
                && clean.Equals(DefaultProfileName, StringComparison.OrdinalIgnoreCase)
                && Directory.Exists(LegacyUserDataFolder))
            {
                TryMigrateLegacyFolder(folder);
            }

            // FileShare.None: a second process attempting the same open fails,
            // which is exactly the collision we are trying to surface.
            var lockStream = new FileStream(
                GetLockPath(clean),
                FileMode.OpenOrCreate,
                FileAccess.ReadWrite,
                FileShare.None,
                bufferSize: 1,
                FileOptions.DeleteOnClose);

            var stamp = Encoding.UTF8.GetBytes(
                $"pid={Environment.ProcessId} started={DateTime.Now:O}");
            lockStream.Write(stamp, 0, stamp.Length);
            lockStream.Flush();

            return new ProfileSession(clean, folder, lockStream);
        }
        catch (IOException)
        {
            error = $"Profile \"{clean}\" is already open in another window. " +
                    "Pick a different profile, or close that window first.";
            return null;
        }
        catch (UnauthorizedAccessException ex)
        {
            error = $"No permission to use the profile folder:\n{GetProfilePath(clean)}\n\n{ex.Message}";
            return null;
        }
        catch (Exception ex)
        {
            error = $"Could not prepare profile \"{clean}\":\n{ex.Message}";
            return null;
        }
    }

    /// <summary>
    /// Moves the pre-profile session folder into Profiles\Default. Move is
    /// preferred over copy — the cache can be hundreds of megabytes — and a
    /// failure is non-fatal, it just means signing in again.
    /// </summary>
    private static void TryMigrateLegacyFolder(string destination)
    {
        try
        {
            if (Directory.EnumerateFileSystemEntries(destination).Any()) return;

            Directory.Delete(destination);                       // Move needs a clear target
            Directory.Move(LegacyUserDataFolder, destination);
            Debug.WriteLine($"Migrated legacy session folder to {destination}");
        }
        catch
        {
            Directory.CreateDirectory(destination);              // leave the old folder alone
        }
    }

    /// <summary>Starts another copy of the app on a different profile.</summary>
    public static void LaunchNewInstance(string profileName)
    {
        var exe = Environment.ProcessPath;
        if (string.IsNullOrEmpty(exe)) return;

        Process.Start(new ProcessStartInfo
        {
            FileName = exe,
            Arguments = $"--profile=\"{Sanitise(profileName)}\"",
            UseShellExecute = true
        });
    }
}
