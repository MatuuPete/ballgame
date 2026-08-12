using System.Windows;

namespace WebView2Automation;

public partial class App : Application
{
    /// <summary>
    /// Profile this process owns. Held for the lifetime of the app; disposing
    /// it releases the lock so the profile can be opened again.
    /// </summary>
    internal ProfileSession? Session { get; private set; }

    protected override void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);

        DispatcherUnhandledException += (_, args) =>
        {
            MessageBox.Show(args.Exception.ToString(), "Unhandled exception",
                MessageBoxButton.OK, MessageBoxImage.Error);
            args.Handled = true;
        };

        // ShutdownMode must not be OnLastWindowClose while only the picker is
        // open, or dismissing it would tear the app down before MainWindow exists.
        ShutdownMode = ShutdownMode.OnExplicitShutdown;

        var session = ResolveProfile(e.Args);
        if (session is null)
        {
            Shutdown();
            return;
        }

        Session = session;

        var main = new MainWindow(session);
        MainWindow = main;
        ShutdownMode = ShutdownMode.OnMainWindowClose;
        main.Show();
    }

    /// <summary>
    /// Command line wins; otherwise the picker is shown.
    ///   KaHoopsArena.exe --profile=Work
    ///   KaHoopsArena.exe --profile Work
    ///   KaHoopsArena.exe -p Work
    ///   KaHoopsArena.exe --pick-profile      (forces the chooser)
    /// </summary>
    private static ProfileSession? ResolveProfile(string[] args)
    {
        var requested = ProfileManager.ParseProfileArgument(args);
        var forcePicker = ProfileManager.ForcePicker(args);

        if (requested is not null && !forcePicker)
        {
            var session = ProfileManager.TryAcquire(requested, out var error);
            if (session is not null) return session;

            // A named profile that is busy falls back to the picker rather than
            // failing outright — usually the user just wants another window.
            MessageBox.Show(
                error + "\n\nChoose a different profile.",
                "Profile unavailable",
                MessageBoxButton.OK, MessageBoxImage.Warning);
        }

        var picker = new ProfilePickerWindow();
        return picker.ShowDialog() == true ? picker.AcquiredSession : null;
    }

    protected override void OnExit(ExitEventArgs e)
    {
        Session?.Dispose();   // releases the lock file
        base.OnExit(e);
    }
}
