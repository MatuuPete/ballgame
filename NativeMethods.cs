using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Interop;

namespace WebView2Automation;

/// <summary>
/// DWM interop for modern window chrome: dark non-client area, rounded corners,
/// and the Windows 11 translucent system backdrop (Acrylic / Mica).
///
/// IMPORTANT: none of this uses WPF's AllowsTransparency. A layered WPF window
/// forces software rendering and WebView2 — which is a child HWND composited by
/// the OS — will not draw inside one. DWM backdrops sit behind the window at the
/// compositor level, so they coexist with WebView2 without issue.
/// </summary>
internal static class NativeMethods
{
    // ---- DwmSetWindowAttribute keys ---------------------------------
    private const int DWMWA_USE_IMMERSIVE_DARK_MODE_PRE_20H1 = 19;
    private const int DWMWA_USE_IMMERSIVE_DARK_MODE = 20;
    private const int DWMWA_WINDOW_CORNER_PREFERENCE = 33;
    private const int DWMWA_BORDER_COLOR = 34;
    private const int DWMWA_SYSTEMBACKDROP_TYPE = 38;

    // DWM_WINDOW_CORNER_PREFERENCE
    private const int DWMWCP_DEFAULT = 0;
    private const int DWMWCP_ROUND = 2;

    // DWM_SYSTEMBACKDROP_TYPE
    private const int DWMSBT_AUTO = 0;
    private const int DWMSBT_NONE = 1;
    private const int DWMSBT_MAINWINDOW = 2;      // Mica
    private const int DWMSBT_TRANSIENTWINDOW = 3; // Acrylic — the translucent one
    private const int DWMSBT_TABBEDWINDOW = 4;    // Mica Alt

    private const uint DWMWA_COLOR_NONE = 0xFFFFFFFE;

    [DllImport("dwmapi.dll", PreserveSig = true)]
    private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size);

    [DllImport("dwmapi.dll", PreserveSig = true)]
    private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref uint value, int size);

    /// <summary>Backdrop styles, most translucent first.</summary>
    internal enum Backdrop
    {
        Acrylic,   // heavy blur, strongest "transparent" look
        Mica,      // subtle wallpaper tint
        MicaAlt,   // slightly darker Mica
        None
    }

    private static Version OsVersion => Environment.OSVersion.Version;

    /// <summary>Windows 11 21H2 or newer (rounded corners, dark titlebar).</summary>
    private static bool IsWindows11 => OsVersion.Build >= 22000;

    /// <summary>Windows 11 22H2 or newer — required for DWMWA_SYSTEMBACKDROP_TYPE.</summary>
    private static bool SupportsSystemBackdrop => OsVersion.Build >= 22621;

    /// <summary>Windows 10 2004+ supports the modern dark-mode attribute id.</summary>
    private static bool SupportsDarkMode => OsVersion.Build >= 17763;

    /// <summary>
    /// Applies dark chrome, rounded corners and (where supported) a translucent
    /// backdrop. Returns true if a real backdrop was applied, so the caller knows
    /// whether it can leave the window background transparent.
    /// </summary>
    internal static bool ApplyModernChrome(Window window, Backdrop backdrop = Backdrop.Acrylic)
    {
        var helper = new WindowInteropHelper(window);
        var hwnd = helper.Handle;
        if (hwnd == IntPtr.Zero)
            hwnd = helper.EnsureHandle();
        if (hwnd == IntPtr.Zero) return false;

        TrySetDarkMode(hwnd, true);
        TrySetRoundedCorners(hwnd, true);
        TrySetBorderColour(hwnd);

        return TrySetBackdrop(hwnd, backdrop);
    }

    /// <summary>Dark title bar / system menu / resize border.</summary>
    internal static bool TrySetDarkMode(IntPtr hwnd, bool enabled)
    {
        if (!SupportsDarkMode) return false;
        int value = enabled ? 1 : 0;

        // 20H1+ uses attribute 20; earlier 1809/1903 builds used 19.
        if (DwmSetWindowAttribute(hwnd, DWMWA_USE_IMMERSIVE_DARK_MODE, ref value, sizeof(int)) == 0)
            return true;

        return DwmSetWindowAttribute(hwnd, DWMWA_USE_IMMERSIVE_DARK_MODE_PRE_20H1,
                                     ref value, sizeof(int)) == 0;
    }

    internal static bool TrySetRoundedCorners(IntPtr hwnd, bool rounded)
    {
        if (!IsWindows11) return false;
        int pref = rounded ? DWMWCP_ROUND : DWMWCP_DEFAULT;
        return DwmSetWindowAttribute(hwnd, DWMWA_WINDOW_CORNER_PREFERENCE,
                                     ref pref, sizeof(int)) == 0;
    }

    /// <summary>Suppresses the bright 1px system border that clashes with dark chrome.</summary>
    private static bool TrySetBorderColour(IntPtr hwnd)
    {
        if (!IsWindows11) return false;
        uint colour = DWMWA_COLOR_NONE;
        return DwmSetWindowAttribute(hwnd, DWMWA_BORDER_COLOR,
                                     ref colour, sizeof(uint)) == 0;
    }

    /// <summary>
    /// Requests a translucent system backdrop. Only meaningful on Windows 11 22H2+.
    /// The window background must be transparent for the effect to be visible.
    /// </summary>
    internal static bool TrySetBackdrop(IntPtr hwnd, Backdrop backdrop)
    {
        if (!SupportsSystemBackdrop || backdrop == Backdrop.None) return false;

        int type = backdrop switch
        {
            Backdrop.Acrylic => DWMSBT_TRANSIENTWINDOW,
            Backdrop.Mica => DWMSBT_MAINWINDOW,
            Backdrop.MicaAlt => DWMSBT_TABBEDWINDOW,
            _ => DWMSBT_NONE
        };

        return DwmSetWindowAttribute(hwnd, DWMWA_SYSTEMBACKDROP_TYPE,
                                     ref type, sizeof(int)) == 0;
    }

    /// <summary>Human-readable description for the log console.</summary>
    internal static string DescribeCapabilities() =>
        $"Windows {OsVersion.Major}.{OsVersion.Minor} build {OsVersion.Build} — " +
        $"dark mode: {(SupportsDarkMode ? "yes" : "no")}, " +
        $"rounded corners: {(IsWindows11 ? "yes" : "no")}, " +
        $"acrylic backdrop: {(SupportsSystemBackdrop ? "yes" : "no")}";
}
