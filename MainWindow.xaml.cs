using System.Collections.Concurrent;
using System.Collections.ObjectModel;
using System.IO;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Windows;
// Explicit rather than relying on implicit usings — RadioButton and
// TextChangedEventArgs live here. Note: do NOT add System.Windows.Shapes,
// its Path type collides with System.IO.Path used above.
using System.Windows.Controls;
using System.Windows.Documents;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Threading;
using Microsoft.Web.WebView2.Core;

namespace WebView2Automation;

public partial class MainWindow : Window
{
    // ------------------------------------------------------------------
    // Configuration
    // ------------------------------------------------------------------
    private const string DefaultUrl = "https://hoops-arena.com/match";

    /// <summary>
    /// The profile this window owns. Its folder is the WebView2 user data
    /// folder, which is what keeps windows isolated: cookies, localStorage,
    /// IndexedDB and cache all live inside it, so signing in or clearing data
    /// in one profile cannot touch another.
    /// </summary>
    private readonly ProfileSession _profile;

    private string UserDataFolder => _profile.UserDataFolder;

    private static readonly string ScriptsFolder =
        Path.Combine(AppContext.BaseDirectory, "Scripts");

    private static readonly JsonSerializerOptions JsonOpts = new()
    {
        PropertyNameCaseInsensitive = true,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
    };

    // ------------------------------------------------------------------
    // State
    // ------------------------------------------------------------------
    private bool _webViewReady;
    private bool _isRunning;
    private string? _automationSource;

    /// <summary>Page the automation always begins from.</summary>
    private const string MatchUrl = "https://hoops-arena.com/match";

    /// <summary>
    /// Set while Start navigates on purpose. Without it, OnNavigationStarting
    /// would see a navigation during a run and cancel the very run that caused it.
    /// </summary>
    private bool _navigatingForStart;

    private readonly ConcurrentQueue<(string Text, Brush Colour)> _logQueue = new();
    private readonly DispatcherTimer _logFlushTimer;
    private const int MaxLogBlocks = 3000;

    // Stop handling. The host must never depend solely on the page to unlock
    // the UI — a script that throws, navigates away, or simply forgets to post
    // 'done' would otherwise strand the operator with a dead Start button.
    private bool _stopRequested;
    private DispatcherTimer? _stopWatchdog;
    private static readonly TimeSpan StopGracePeriod = TimeSpan.FromSeconds(15);

    // Rolling match history. Newest first; anything past the cap falls off the
    // bottom, so memory stays flat no matter how long a session runs.
    private const int MaxMatchRecords = 15;
    private readonly ObservableCollection<MatchRecord> _matchHistory = new();

    // Right-panel visibility. Global (not per-profile) — it describes how the
    // app looks, not which account is signed in.
    private readonly UiSettings _uiSettings = UiSettings.Load();
    private GridLength? _expandedControlPanelWidth;

    /// <summary>
    /// Designer/fallback constructor. Acquires the Default profile so the
    /// window is still constructible without App having resolved one.
    /// </summary>
    public MainWindow() : this(
        ProfileManager.TryAcquire(ProfileManager.DefaultProfileName, out _)
        ?? new ProfileSession(ProfileManager.DefaultProfileName,
                              ProfileManager.GetProfilePath(ProfileManager.DefaultProfileName),
                              null!))
    {
    }

    internal MainWindow(ProfileSession profile)
    {
        _profile = profile ?? throw new ArgumentNullException(nameof(profile));

        InitializeComponent();

        // Which profile this window is on, so multiple windows are tellable apart.
        Title = $"KaHoops Arena — {_profile.Name}";
        ProfileLabel.Text = _profile.Name;

        // Bound in code rather than XAML so the window's DataContext stays free.
        MatchGrid.ItemsSource = _matchHistory;

        _logFlushTimer = new DispatcherTimer(DispatcherPriority.Background)
        {
            Interval = TimeSpan.FromMilliseconds(120)
        };
        _logFlushTimer.Tick += (_, _) => FlushLogQueue();
        _logFlushTimer.Start();

        // Chrome must be applied once the HWND exists.
        SourceInitialized += OnSourceInitialized;
        StateChanged += OnWindowStateChanged;
        Loaded += async (_, _) => await InitialiseWebViewAsync();
        Closed += (_, _) => _logFlushTimer.Stop();

        ApplyRightPanelVisibility(_uiSettings.RightPanelCollapsed);
    }

    // ==================================================================
    // Window chrome
    // ==================================================================
    private void OnSourceInitialized(object? sender, EventArgs e)
    {
        // Acrylic where available; otherwise fall back to an opaque soft black so
        // the window never renders as a flat void on Windows 10.
        var applied = NativeMethods.ApplyModernChrome(this, NativeMethods.Backdrop.Acrylic);

        if (applied)
        {
            // Let the DWM backdrop show through the window's own background.
            Background = Brushes.Transparent;
        }
        else
        {
            Background = (Brush)FindResource("OpaqueFallback");
        }

        Log(NativeMethods.DescribeCapabilities(), LogLevel.Debug);
        Log(applied
                ? "Acrylic backdrop enabled."
                : "Acrylic unavailable on this OS build — using opaque theme.",
            LogLevel.Debug);
    }

    private void OnWindowStateChanged(object? sender, EventArgs e)
    {
        // Swap the maximise glyph for a restore glyph.
        var key = WindowState == WindowState.Maximized ? "GlyphRestore" : "GlyphMaximise";
        MaximiseGlyph.Data = (Geometry)FindResource(key);
        MaximiseButton.ToolTip = WindowState == WindowState.Maximized ? "Restore" : "Maximise";
    }

    private void MinimiseButton_Click(object sender, RoutedEventArgs e)
        => WindowState = WindowState.Minimized;

    private void MaximiseButton_Click(object sender, RoutedEventArgs e)
        => WindowState = WindowState == WindowState.Maximized
            ? WindowState.Normal
            : WindowState.Maximized;

    private void CloseButton_Click(object sender, RoutedEventArgs e) => Close();

    // ==================================================================
    // Right panel visibility
    // ==================================================================
    private void PanelToggleButton_Click(object sender, RoutedEventArgs e)
    {
        _uiSettings.RightPanelCollapsed = !_uiSettings.RightPanelCollapsed;
        ApplyRightPanelVisibility(_uiSettings.RightPanelCollapsed);
        _uiSettings.Save();
    }

    /// <summary>
    /// Collapsing zeroes both the control-panel column and its splitter so
    /// the browser column (Width="*") fills the freed space; expanding
    /// restores whatever width was last in effect, including a manual
    /// GridSplitter resize done before collapsing — not just the XAML default.
    /// </summary>
    private void ApplyRightPanelVisibility(bool collapsed)
    {
        if (collapsed)
        {
            if (ControlPanelColumn.ActualWidth > 0)
                _expandedControlPanelWidth = new GridLength(ControlPanelColumn.ActualWidth);

            ControlPanelRoot.Visibility = Visibility.Collapsed;
            MainSplitter.Visibility = Visibility.Collapsed;
            ControlPanelColumn.MinWidth = 0;
            ControlPanelColumn.Width = new GridLength(0);
            MainSplitterColumn.Width = new GridLength(0);
            PanelToggleButton.ToolTip = "Show control panel";
        }
        else
        {
            ControlPanelColumn.MinWidth = 380;
            ControlPanelColumn.Width = _expandedControlPanelWidth ?? new GridLength(470);
            MainSplitterColumn.Width = new GridLength(8);
            ControlPanelRoot.Visibility = Visibility.Visible;
            MainSplitter.Visibility = Visibility.Visible;
            PanelToggleButton.ToolTip = "Hide control panel";
        }
    }

    // ==================================================================
    // Profile menu
    // ==================================================================

    /// <summary>
    /// Builds the profile dropdown fresh on each click, so "in use" states
    /// reflect windows opened since the last time it was shown.
    ///
    /// Selecting a profile opens a NEW window rather than switching this one.
    /// A CoreWebView2Environment is fixed to its user data folder once created
    /// — swapping it would mean tearing down and rebuilding the control and
    /// losing whatever is on screen. Chrome and Edge behave the same way.
    /// </summary>
    private void ProfileButton_Click(object sender, RoutedEventArgs e)
    {
        var menu = new ContextMenu
        {
            PlacementTarget = ProfileButton,
            Placement = System.Windows.Controls.Primitives.PlacementMode.Bottom,
            HorizontalOffset = 0,
            VerticalOffset = 4,
            MinWidth = 220
        };

        var header = new MenuItem
        {
            Header = "PROFILES",
            IsEnabled = false,
            FontSize = 10,
            FontWeight = FontWeights.SemiBold
        };
        menu.Items.Add(header);

        foreach (var name in ProfileManager.ListProfiles())
        {
            var isCurrent = name.Equals(_profile.Name, StringComparison.OrdinalIgnoreCase);
            var inUse = !isCurrent && ProfileManager.IsInUse(name);

            var item = new MenuItem
            {
                Header = name,
                IsChecked = isCurrent,
                // Current profile: nothing to do. Busy profile: the new process
                // could not acquire the lock, so do not pretend otherwise.
                IsEnabled = !isCurrent && !inUse,
                InputGestureText = isCurrent ? "this window"
                                 : inUse ? "already open"
                                 : "open"
            };

            if (item.IsEnabled)
            {
                var captured = name;
                item.Click += (_, _) => OpenProfileWindow(captured);
            }

            menu.Items.Add(item);
        }

        menu.Items.Add(new Separator());

        var createItem = new MenuItem { Header = "New profile…" };
        createItem.Click += (_, _) => CreateProfileWindow();
        menu.Items.Add(createItem);

        var folderItem = new MenuItem { Header = "Open profiles folder" };
        folderItem.Click += (_, _) => OpenProfilesFolder();
        menu.Items.Add(folderItem);

        menu.IsOpen = true;
    }

    /// <summary>Launches another instance of the app on the given profile.</summary>
    private void OpenProfileWindow(string profileName)
    {
        try
        {
            ProfileManager.LaunchNewInstance(profileName);
            Log($"Opening a new window on profile \"{profileName}\".", LogLevel.Info);
        }
        catch (Exception ex)
        {
            Log($"Could not open profile \"{profileName}\": {ex.Message}", LogLevel.Error);
            MessageBox.Show(this, ex.Message, "Could not open profile",
                MessageBoxButton.OK, MessageBoxImage.Warning);
        }
    }

    private void CreateProfileWindow()
    {
        // Name-only mode: the new process acquires the lock itself, so this
        // dialog must not take it first.
        var picker = new ProfilePickerWindow
        {
            Owner = this,
            AcquireOnAccept = false,
            Title = "KaHoops Arena — New profile"
        };

        if (picker.ShowDialog() == true && !string.IsNullOrWhiteSpace(picker.SelectedProfileName))
            OpenProfileWindow(picker.SelectedProfileName!);
    }

    private void OpenProfilesFolder()
    {
        try
        {
            Directory.CreateDirectory(ProfileManager.ProfilesRoot);
            System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo
            {
                FileName = ProfileManager.ProfilesRoot,
                UseShellExecute = true
            });
        }
        catch (Exception ex)
        {
            Log("Could not open the profiles folder: " + ex.Message, LogLevel.Error);
        }
    }

    // ==================================================================
    // 1. WebView2 bootstrap + session persistence
    // ==================================================================
    private async Task InitialiseWebViewAsync()
    {
        try
        {
            // Belt and braces — ProfileManager already created this, but the
            // folder must exist before CreateAsync or it throws.
            Directory.CreateDirectory(UserDataFolder);

            Log($"Profile \"{_profile.Name}\"", LogLevel.Info);
            Log("Session folder: " + UserDataFolder, LogLevel.Debug);

            var options = new CoreWebView2EnvironmentOptions
            {
                AdditionalBrowserArguments = "--disable-background-timer-throttling",
                Language = "en-US"
            };

            // The per-profile folder is what isolates this window. Two windows
            // given different folders get independent cookie jars and caches;
            // two given the SAME folder from different processes will fail here.
            var environment = await CoreWebView2Environment.CreateAsync(
                browserExecutableFolder: null,
                userDataFolder: UserDataFolder,
                options: options);

            // Must complete before any navigation — Source/Navigate before this
            // would spin up the default environment and defeat the isolation.
            await Browser.EnsureCoreWebView2Async(environment);

            var core = Browser.CoreWebView2;

            core.Settings.IsWebMessageEnabled = true;
            core.Settings.AreDevToolsEnabled = true;
            core.Settings.AreDefaultContextMenusEnabled = true;
            core.Settings.IsStatusBarEnabled = false;
            core.Settings.AreHostObjectsAllowed = true;

            core.WebMessageReceived += OnWebMessageReceived;
            core.NavigationStarting += OnNavigationStarting;
            core.NavigationCompleted += OnNavigationCompleted;
            core.SourceChanged += (_, _) => AddressBar.Text = core.Source;
            core.ProcessFailed += (_, ev) =>
                Log($"WebView2 process failed: {ev.ProcessFailedKind}", LogLevel.Error);

            core.NewWindowRequested += (_, ev) =>
            {
                ev.Handled = true;
                core.Navigate(ev.Uri);
            };

            // Console bridge runs before any page script, on every document.
            var bridgeSource = await LoadScriptAsync("bridge.js");
            await core.AddScriptToExecuteOnDocumentCreatedAsync(bridgeSource);

            _automationSource = await LoadScriptAsync("automation.js");

            _webViewReady = true;
            SetStatus("Ready.");
            SetHint("Log in on the left if you haven't already, then press Start playing.");
            Log("WebView2 initialised. Runtime " + environment.BrowserVersionString, LogLevel.Success);
            Log("Persistent profile: " + UserDataFolder, LogLevel.Info);

            core.Navigate(AddressBar.Text?.Trim() is { Length: > 0 } u ? u : DefaultUrl);
        }
        catch (UnauthorizedAccessException ex)
        {
            Log("No permission to use the profile folder: " + ex.Message, LogLevel.Error);
            SetStatus("Couldn't open this profile.");
            SetHint("Windows denied access to the profile folder. Try a different profile.");
        }
        catch (WebView2RuntimeNotFoundException)
        {
            Log("The WebView2 Evergreen Runtime is not installed. " +
                "Get it from https://developer.microsoft.com/microsoft-edge/webview2/", LogLevel.Error);
            SetStatus("Missing a required Windows component.");
            SetHint("The Microsoft Edge WebView2 Runtime needs installing. " +
                    "Search for \"WebView2 Runtime\" on microsoft.com, install it, then reopen KaHoops Arena.");
        }
        // FileNotFoundException derives from IOException, so it must be caught
        // first — otherwise the profile-lock handler below swallows a missing
        // Scripts folder and reports it as the wrong problem.
        catch (FileNotFoundException ex)
        {
            Log(ex.Message, LogLevel.Error);
            Log("The Scripts folder must sit beside the executable.", LogLevel.Warn);
            SetStatus("Some program files are missing.");
            SetHint("The Scripts folder must sit next to KaHoopsArena.exe. " +
                    "If you copied the app somewhere, copy that folder too.");
        }
        catch (IOException ex)
        {
            // Almost always: the same folder is open in another process.
            Log("Profile folder is locked: " + ex.Message, LogLevel.Error);
            SetStatus("This profile is in use.");
            SetHint("Another window already has this profile open. Close it, or start with a different profile.");
        }
        catch (Exception ex)
        {
            Log("WebView2 initialisation failed: " + ex.Message, LogLevel.Error);
            SetStatus("Initialisation failed.");
        }
    }

    /// <summary>Helper modules injected ahead of automation.js, in order.</summary>
    private static readonly string[] OptionalModules = { "session-init.js" };

    private static async Task<string> LoadScriptAsync(string fileName)
    {
        var path = Path.Combine(ScriptsFolder, fileName);
        if (!File.Exists(path))
            throw new FileNotFoundException($"Script '{fileName}' not found. Expected at: {path}", path);
        return await File.ReadAllTextAsync(path);
    }

    /// <summary>Returns null instead of throwing when the file is absent.</summary>
    private static async Task<string?> TryLoadScriptAsync(string fileName)
    {
        var path = Path.Combine(ScriptsFolder, fileName);
        return File.Exists(path) ? await File.ReadAllTextAsync(path) : null;
    }

    // ==================================================================
    // 2. JS -> C#
    // ==================================================================
    private void OnWebMessageReceived(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        string raw;
        try { raw = e.WebMessageAsJson; }
        catch (Exception ex) { Log("Malformed web message: " + ex.Message, LogLevel.Error); return; }

        BridgeMessage? msg;
        try { msg = JsonSerializer.Deserialize<BridgeMessage>(raw, JsonOpts); }
        catch { Log(raw, LogLevel.Info); return; }

        if (msg is null) { Log(raw, LogLevel.Info); return; }

        // Type matching is case-insensitive, so JS may send either the original
        // lowercase names ("console", "progress") or the uppercase ones
        // ("LOG", "MATCH_SUMMARY") without the host caring.
        switch (msg.Type?.ToLowerInvariant())
        {
            // ---- structured match record -> DataGrid -------------------
            case "match_summary":
                HandleMatchSummary(raw);
                break;

            // ---- plain log line -> console tab -------------------------
            case "log":
                var logLevel = msg.Level?.ToLowerInvariant() switch
                {
                    "error" => LogLevel.Error,
                    "warn" => LogLevel.Warn,
                    "debug" => LogLevel.Debug,
                    "success" => LogLevel.Success,
                    _ => LogLevel.Info
                };
                if (logLevel == LogLevel.Debug && VerboseCheck.IsChecked != true) return;
                Log(msg.Body, logLevel, msg.Source);
                break;

            case "console":
                var level = msg.Level?.ToLowerInvariant() switch
                {
                    "error" => LogLevel.Error,
                    "warn" => LogLevel.Warn,
                    "debug" or "info" => LogLevel.Debug,
                    _ => LogLevel.Info
                };
                if (level == LogLevel.Debug && VerboseCheck.IsChecked != true) return;
                Log(msg.Text ?? string.Empty, level, msg.Source);
                break;

            case "progress":
                var current = msg.Current ?? 0;
                var total = msg.Total ?? 0;
                RunProgress.Value = total > 0 ? current * 100.0 / total : 0;
                RunPillText.Text = $"{current} / {total}";
                SetStatus($"Playing — match {current} of {total}");
                SetHint(msg.Text is { Length: > 0 } ? "Last result: " + msg.Text : "In progress...");
                Log($"Iteration {current} of {total} complete" +
                    (msg.Text is { Length: > 0 } ? $" ({msg.Text})" : ""), LogLevel.Progress);
                break;

            case "status":
                SetStatus(msg.Text ?? "");
                Log(msg.Text ?? "", LogLevel.Status);
                break;

            case "started":
                SetRunningState(true);
                RunProgress.Value = 0;
                RunPillText.Text = $"0 / {msg.Total ?? 0}";
                Log($"Run started — {msg.Total ?? 0} iterations queued.", LogLevel.Success);
                break;

            case "done":
                SetRunningState(false);
                RunProgress.Value = 100;
                SetStatus(msg.Cancelled == true ? "Stopped." : "All done!");
                SetHint(msg.Cancelled == true
                    ? "You can press Start playing again whenever you like."
                    : $"Played {msg.Current ?? 0} match(es). See the Match History tab for results.");
                Log(msg.Cancelled == true
                        ? $"Run cancelled after {msg.Current ?? 0} iteration(s)."
                        : $"Run finished: {msg.Succeeded ?? 0} succeeded, {msg.Failed ?? 0} failed.",
                    msg.Cancelled == true ? LogLevel.Warn : LogLevel.Success);
                break;

            case "error":
                Log(msg.Text ?? "Unknown script error", LogLevel.Error, msg.Source);
                break;

            default:
                Log(raw, LogLevel.Info);
                break;
        }
    }

    // ==================================================================
    // Match history
    // ==================================================================

    /// <summary>
    /// Deserialises a MATCH_SUMMARY payload and prepends it to the grid.
    /// Deliberately re-parses the raw JSON into a dedicated DTO rather than
    /// widening BridgeMessage: the two message shapes are unrelated, and
    /// keeping them apart means a malformed summary cannot corrupt the
    /// console/progress path.
    /// </summary>
    private void HandleMatchSummary(string rawJson)
    {
        MatchSummaryMessage? summary;
        try
        {
            summary = JsonSerializer.Deserialize<MatchSummaryMessage>(rawJson, JsonOpts);
        }
        catch (Exception ex)
        {
            Log("MATCH_SUMMARY could not be parsed: " + ex.Message, LogLevel.Error);
            return;
        }

        if (summary is null)
        {
            Log("MATCH_SUMMARY was empty.", LogLevel.Warn);
            return;
        }

        static string Clean(string? value) =>
            string.IsNullOrWhiteSpace(value) || value.Trim() == "null" ? "—" : value.Trim();

        var record = new MatchRecord
        {
            Timestamp = DateTime.Now,
            Outcome = string.IsNullOrWhiteSpace(summary.Outcome)
                ? "UNKNOWN"
                : summary.Outcome.Trim().ToUpperInvariant(),
            MyScore = summary.MyScore,
            OpponentScore = summary.OpponentScore,
            MvpName = Clean(summary.MvpName),
            // Falls back to the superseded field so older payloads still populate.
            OpponentName = Clean(summary.OpponentName ?? summary.MvpHandle)
        };

        AddMatchRecord(record);

        Log($"Match recorded: {record.Outcome} {record.MyScore}-{record.OpponentScore} " +
            $"vs {record.OpponentName} | MVP {record.MvpName}",
            record.Outcome == "VICTORY" ? LogLevel.Success : LogLevel.Warn,
            "history");
    }

    /// <summary>Newest first, capped at <see cref="MaxMatchRecords"/>.</summary>
    private void AddMatchRecord(MatchRecord record)
    {
        _matchHistory.Insert(0, record);

        while (_matchHistory.Count > MaxMatchRecords)
            _matchHistory.RemoveAt(_matchHistory.Count - 1);

        MatchGrid.ScrollIntoView(record);
        UpdateHistorySummary();
    }

    private void UpdateHistorySummary()
    {
        if (_matchHistory.Count == 0)
        {
            HistorySummary.Text = "No matches recorded yet.";
            return;
        }

        var wins = _matchHistory.Count(r => r.Outcome == "VICTORY");
        var losses = _matchHistory.Count(r => r.Outcome == "DEFEAT");
        var decided = wins + losses;
        var rate = decided > 0 ? wins * 100.0 / decided : 0;

        HistorySummary.Text =
            $"Last {_matchHistory.Count} — {wins}W / {losses}L ({rate:0.0}% win rate)";
    }

    private void ClearHistoryButton_Click(object sender, RoutedEventArgs e)
    {
        _matchHistory.Clear();
        UpdateHistorySummary();
        Log("Match history cleared.", LogLevel.Info);
    }

    // ==================================================================
    // 3. C# -> JS
    // ==================================================================
    private async void StartButton_Click(object sender, RoutedEventArgs e)
    {
        if (!_webViewReady) { Log("WebView2 is not ready yet.", LogLevel.Warn); return; }
        if (_isRunning) { Log("A run is already in progress.", LogLevel.Warn); return; }

        if (!TryReadConfig(out var config, out var error))
        {
            Log(error, LogLevel.Error);
            SetStatus("Check your settings");
            SetHint(error);
            return;
        }

        var isRanked = ReferenceEquals(PlayModeTabs.SelectedItem, RankTab);
        var isBig3 = ReferenceEquals(PlayModeTabs.SelectedItem, BigThreeTab);

        try
        {
            SetRunningState(true);
            RunProgress.Value = 0;

            // Reloading is a last resort: it discards the game's in-memory
            // state and costs several seconds. When we're already on Hoops
            // Arena the script opens the Match Hall by clicking MATCH in the
            // bottom dock instead, which keeps everything intact.
            var current = Browser.CoreWebView2.Source ?? string.Empty;

            if (!current.Contains("hoops-arena.com", StringComparison.OrdinalIgnoreCase))
            {
                SetStatus("Opening Hoops Arena...");
                SetHint(MatchUrl);
                Log("Not on Hoops Arena — navigating to " + MatchUrl, LogLevel.Info);

                var loaded = await NavigateAndWaitAsync(MatchUrl, TimeSpan.FromSeconds(30));
                if (!loaded)
                {
                    SetRunningState(false);
                    SetStatus("Couldn't open Hoops Arena.");
                    SetHint("Check your internet connection, then try again.");
                    Log("Navigation failed or timed out.", LogLevel.Error);
                    return;
                }

                // Let the SPA finish mounting before scripts query the DOM.
                await Task.Delay(1200);
            }
            else
            {
                Log("Already on Hoops Arena — no reload needed.", LogLevel.Debug);
            }

            SetStatus("Starting...");
            SetHint(isRanked ? "Opening the Ranked queue."
                  : isBig3 ? "Opening the BIG3 queue."
                  : "Opening the Match Hall.");

            // Always reload from disk so edits take effect on the next Start
            // without republishing.
            var json = JsonSerializer.Serialize(config, JsonOpts);

            if (isRanked)
            {
                // ranked.js is self-contained (its own DOM helpers + waitFor),
                // so it doesn't need the Scrimmage optional modules.
                var rankedSource = await LoadScriptAsync("ranked.js");
                await Browser.CoreWebView2.ExecuteScriptAsync(rankedSource);

                var rankedResult = await Browser.CoreWebView2.ExecuteScriptAsync($"window.startRankedLoop({json});");
                Log("startRankedLoop() dispatched. Immediate return: " + rankedResult, LogLevel.Debug);
            }
            else if (isBig3)
            {
                // big3.js is likewise self-contained. Its selectors are still
                // unverified placeholders — expect this to need real tuning.
                var big3Source = await LoadScriptAsync("big3.js");
                await Browser.CoreWebView2.ExecuteScriptAsync(big3Source);

                var big3Result = await Browser.CoreWebView2.ExecuteScriptAsync($"window.startBig3Loop({json});");
                Log("startBig3Loop() dispatched. Immediate return: " + big3Result, LogLevel.Debug);
            }
            else
            {
                // Optional helper modules, injected before the main bundle so the
                // automation can call into them. Missing files are not fatal.
                foreach (var module in OptionalModules)
                {
                    var source = await TryLoadScriptAsync(module);
                    if (source is null)
                    {
                        Log($"Optional module '{module}' not found — skipped.", LogLevel.Debug);
                        continue;
                    }
                    await Browser.CoreWebView2.ExecuteScriptAsync(source);
                    Log($"Injected {module}.", LogLevel.Debug);
                }

                _automationSource = await LoadScriptAsync("automation.js");
                await Browser.CoreWebView2.ExecuteScriptAsync(_automationSource);

                // Clear any state left behind by a previous run that ended badly.
                await Browser.CoreWebView2.ExecuteScriptAsync(
                    "(typeof window.__resetAutomation === 'function') ? window.__resetAutomation() : 'no-reset';");

                var result = await Browser.CoreWebView2.ExecuteScriptAsync($"window.startLoop({json});");
                Log("startLoop() dispatched. Immediate return: " + result, LogLevel.Debug);
            }
        }
        catch (Exception ex)
        {
            SetRunningState(false);
            Log("Failed to start automation: " + ex.Message, LogLevel.Error);
        }
    }

    private async void StopButton_Click(object sender, RoutedEventArgs e)
    {
        if (!_webViewReady) return;

        // Second press = give up waiting and take the UI back immediately.
        if (_stopRequested)
        {
            await ForceResetAsync("Force-stopped by operator — UI unlocked without waiting for the page.");
            return;
        }

        _stopRequested = true;
        StopButton.Content = "■  Force Stop";
        StopButton.ToolTip = "Press again to unlock the UI immediately";
        SetStatus("Stopping...");
        SetHint("Finishing the current step. Press Stop again to stop immediately.");
        Log("Stop requested from host.", LogLevel.Warn);

        StartStopWatchdog();

        try
        {
            await Browser.CoreWebView2.ExecuteScriptAsync(
                "(typeof window.stopLoop === 'function') ? window.stopLoop() : 'no-loop';");
        }
        catch (Exception ex)
        {
            Log("Stop request failed: " + ex.Message, LogLevel.Error);
            await ForceResetAsync("Could not reach the page — unlocking the UI.");
        }
    }

    /// <summary>
    /// If the page has not reported 'done' within the grace period, unlock the
    /// UI anyway. Without this a script that never posts 'done' leaves Start
    /// permanently disabled and the only recovery is restarting the app.
    /// </summary>
    private void StartStopWatchdog()
    {
        _stopWatchdog?.Stop();
        _stopWatchdog = new DispatcherTimer { Interval = StopGracePeriod };
        _stopWatchdog.Tick += async (_, _) =>
        {
            _stopWatchdog?.Stop();
            if (_isRunning)
            {
                await ForceResetAsync(
                    $"Page did not acknowledge stop within {StopGracePeriod.TotalSeconds:0}s — UI unlocked. " +
                    "The script may still be running; reload the page to be certain.");
            }
        };
        _stopWatchdog.Start();
    }

    /// <summary>Unlocks the UI and tells the page to drop any lingering state.</summary>
    private async Task ForceResetAsync(string reason)
    {
        _stopWatchdog?.Stop();
        SetRunningState(false);
        Log(reason, LogLevel.Warn);
        SetStatus("Stopped.");
        SetHint("Ready to go again whenever you are.");

        try
        {
            await Browser.CoreWebView2.ExecuteScriptAsync(
                "(typeof window.__resetAutomation === 'function') ? window.__resetAutomation() : 'no-reset';");
        }
        catch { /* page may be gone; the UI is unlocked either way */ }
    }

    // ==================================================================
    // Presets
    // ==================================================================

    /// <summary>
    /// Matches, rest seconds. Matches = 0 means "let the page decide" — the
    /// script plays out whatever the rewards counter says is left. Putting a
    /// large number here instead would be a lie the UI then has to repeat.
    /// </summary>
    private const string AutoMatches = "Auto";

    /// <summary>
    /// Consecutive failures tolerated before the scrimmage phase aborts.
    /// Fixed rather than exposed — it exists to stop a runaway loop when the
    /// site changes, and is not something a user should have to reason about.
    /// </summary>
    private const int DefaultFailureLimit = 3;

    private static readonly Dictionary<string, (int Matches, double RestSeconds)> Presets = new()
    {
        ["PresetQuick"] = (5, 2),
        ["PresetStandard"] = (25, 2),
        ["PresetFull"] = (0, 3)
    };

    private bool _applyingPreset;

    private void Preset_Checked(object sender, RoutedEventArgs e)
    {
        // Fields are created after this can first fire during XAML load.
        if (sender is not RadioButton rb || MatchCountBox is null) return;
        if (!Presets.TryGetValue(rb.Name, out var preset)) return;

        var auto = preset.Matches <= 0;

        _applyingPreset = true;
        MatchCountBox.Text = auto ? AutoMatches : preset.Matches.ToString();
        PauseSecondsBox.Text = preset.RestSeconds.ToString("0.#");
        _applyingPreset = false;

        // No point letting anyone edit a field the script is going to override.
        MatchCountBox.IsEnabled = !auto;

        SetStatus($"{rb.Content} selected.");
        SetHint(auto
            ? "Plays until your rewards counter is full, then stops. If it's already full, pick Quick or Standard instead."
            : $"Plays {preset.Matches} matches even if your rewards are already full.");
    }

    /// <summary>
    /// Only Scrimmage Play is implemented. The other tabs are visible so the
    /// roadmap is obvious, but Start is disabled on them rather than silently
    /// running the scrimmage loop under a different name.
    /// </summary>
    private void PlayModeTabs_SelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        // Fires during XAML load, before the rest of the panel exists.
        if (!ReferenceEquals(e.OriginalSource, PlayModeTabs)) return;
        if (StartButton is null || ScrimmageTab is null) return;

        var mode = (PlayModeTabs.SelectedItem as TabItem)?.Header?.ToString() ?? "";
        var implemented = ReferenceEquals(PlayModeTabs.SelectedItem, ScrimmageTab)
                        || ReferenceEquals(PlayModeTabs.SelectedItem, RankTab)
                        || ReferenceEquals(PlayModeTabs.SelectedItem, BigThreeTab);

        StartButton.IsEnabled = implemented && !_isRunning;

        if (!implemented)
        {
            SetStatus($"{Titleise(mode)} isn't available yet.");
            SetHint("Switch to Scrimmage Play to start a session.");
        }
        else if (!_isRunning)
        {
            SetStatus("Ready.");
            SetHint("Press Start playing when you're ready.");
        }
    }

    /// <summary>"RANK PLAY" -> "Rank Play", for use in a sentence.</summary>
    private static string Titleise(string header) =>
        System.Globalization.CultureInfo.CurrentCulture.TextInfo
            .ToTitleCase(header.ToLowerInvariant())
            .Replace("Rookieg", "RookieG");

    /// <summary>Editing a field by hand clears the preset selection.</summary>
    private void Setting_Changed(object sender, TextChangedEventArgs e)
    {
        if (_applyingPreset || PresetQuick is null) return;
        PresetQuick.IsChecked = false;
        PresetStandard.IsChecked = false;
        PresetFull.IsChecked = false;
        MatchCountBox.IsEnabled = true;   // leaving Full session re-enables it
    }

    /// <summary>
    /// Navigates and resolves once the load finishes. Returns false on failure
    /// or timeout — a hung page must not leave Start waiting forever.
    /// </summary>
    private async Task<bool> NavigateAndWaitAsync(string url, TimeSpan timeout)
    {
        var core = Browser.CoreWebView2;
        var tcs = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);

        // CoreWebView2.NavigationCompleted fires for the top-level document only,
        // so the first completion after Navigate() is the one we want.
        void OnCompleted(object? sender, CoreWebView2NavigationCompletedEventArgs e)
            => tcs.TrySetResult(e.IsSuccess);

        core.NavigationCompleted += OnCompleted;
        _navigatingForStart = true;

        try
        {
            core.Navigate(url);

            var finished = await Task.WhenAny(tcs.Task, Task.Delay(timeout));
            if (finished != tcs.Task)
            {
                Log($"Match page did not finish loading within {timeout.TotalSeconds:0}s.", LogLevel.Warn);
                return false;
            }
            return tcs.Task.Result;
        }
        catch (Exception ex)
        {
            Log("Navigation failed: " + ex.Message, LogLevel.Error);
            return false;
        }
        finally
        {
            // Awaits resume on the UI thread, so unsubscribing here is safe.
            core.NavigationCompleted -= OnCompleted;
            _navigatingForStart = false;
        }
    }

    private bool TryReadConfig(out RunConfig config, out string error)
    {
        config = new RunConfig();
        error = string.Empty;

        // Rank Play and BIG3 Play have their own fields — no Full-session/Auto
        // concept for either, since neither has a rewards-counter equivalent
        // to "play until full". Only Scrimmage supports that preset.
        var isScrimmage = ReferenceEquals(PlayModeTabs.SelectedItem, ScrimmageTab);
        var isBig3 = ReferenceEquals(PlayModeTabs.SelectedItem, BigThreeTab);
        var matchCountBox = isScrimmage ? MatchCountBox : isBig3 ? Big3MatchCountBox : RankMatchCountBox;
        var pauseSecondsBox = isScrimmage ? PauseSecondsBox : isBig3 ? Big3PauseSecondsBox : RankPauseSecondsBox;

        // "Auto" (the Full session preset) sends 0, which the script reads as
        // "play out the remaining rewards".
        var matchText = matchCountBox.Text.Trim();
        int matches;

        if (isScrimmage && matchText.Equals(AutoMatches, StringComparison.OrdinalIgnoreCase))
        {
            matches = 0;
        }
        else if (!int.TryParse(matchText, out matches) || matches <= 0)
        {
            error = "Please enter how many matches to play — a whole number, at least 1.";
            return false;
        }

        // Presented in seconds because milliseconds mean nothing to most people.
        if (!double.TryParse(pauseSecondsBox.Text.Trim(), out var restSeconds) || restSeconds < 0)
        {
            error = "Rest between matches should be a number of seconds, for example 2.";
            return false;
        }
        if (restSeconds > 300)
        {
            error = "Rest between matches looks too long — please use 300 seconds or less.";
            return false;
        }

        config = new RunConfig
        {
            TargetIterations = matches,
            ActionDelayMs = (int)Math.Round(restSeconds * 1000),
            RetryThreshold = DefaultFailureLimit,
            Verbose = VerboseCheck.IsChecked == true
        };
        return true;
    }

    // ==================================================================
    // Navigation
    // ==================================================================
    private void OnNavigationStarting(object? sender, CoreWebView2NavigationStartingEventArgs e)
    {
        Log("Navigating -> " + e.Uri, LogLevel.Debug);

        // _navigatingForStart covers the deliberate jump to the match page that
        // Start performs; that navigation must not cancel its own run.
        if (_isRunning && !e.IsRedirected && !_navigatingForStart)
        {
            SetRunningState(false);
            Log("Navigation occurred during a run — automation state was discarded.", LogLevel.Warn);
            SetStatus("Stopped — the page changed.");
            SetHint("Press Start playing to begin again.");
        }
    }

    private void OnNavigationCompleted(object? sender, CoreWebView2NavigationCompletedEventArgs e)
    {
        if (e.IsSuccess)
        {
            Log("Loaded " + Browser.CoreWebView2.Source, LogLevel.Success);
            if (!_isRunning)
            {
                SetStatus("Page loaded.");
                SetHint("Press Start playing when you're ready.");
            }
        }
        else
        {
            Log($"Navigation failed: {e.WebErrorStatus}", LogLevel.Error);
            SetStatus("Couldn't load the page.");
            SetHint("Check your internet connection, then press the reload button above the browser.");
        }
    }

    private void GoButton_Click(object sender, RoutedEventArgs e) => NavigateToAddressBar();

    private void AddressBar_KeyDown(object sender, KeyEventArgs e)
    {
        if (e.Key == Key.Enter) NavigateToAddressBar();
    }

    private void NavigateToAddressBar()
    {
        if (!_webViewReady) return;
        var url = AddressBar.Text.Trim();
        if (url.Length == 0) return;
        if (!url.Contains("://")) url = "https://" + url;
        try { Browser.CoreWebView2.Navigate(url); }
        catch (Exception ex) { Log("Bad URL: " + ex.Message, LogLevel.Error); }
    }

    private void BackButton_Click(object sender, RoutedEventArgs e)
    {
        if (_webViewReady && Browser.CoreWebView2.CanGoBack) Browser.CoreWebView2.GoBack();
    }

    private void ForwardButton_Click(object sender, RoutedEventArgs e)
    {
        if (_webViewReady && Browser.CoreWebView2.CanGoForward) Browser.CoreWebView2.GoForward();
    }

    private void ReloadButton_Click(object sender, RoutedEventArgs e)
    {
        if (_webViewReady) Browser.CoreWebView2.Reload();
    }

    // ==================================================================
    // UI state + logging
    // ==================================================================
    private void SetRunningState(bool running)
    {
        _isRunning = running;

        if (!running)
        {
            _stopWatchdog?.Stop();
            _stopRequested = false;
            StopButton.Content = "■  Stop";
            StopButton.ToolTip = null;
        }

        // Never re-enable Start while an unimplemented mode is showing.
        var onImplementedTab = PlayModeTabs is null
                          || ReferenceEquals(PlayModeTabs.SelectedItem, ScrimmageTab)
                          || ReferenceEquals(PlayModeTabs.SelectedItem, RankTab)
                          || ReferenceEquals(PlayModeTabs.SelectedItem, BigThreeTab);

        StartButton.IsEnabled = !running && onImplementedTab;
        StopButton.IsEnabled = running;
        // Stays locked under the Full session preset even when idle.
        MatchCountBox.IsEnabled = !running && PresetFull.IsChecked != true;
        PauseSecondsBox.IsEnabled = !running;
        PresetQuick.IsEnabled = !running;
        PresetStandard.IsEnabled = !running;
        PresetFull.IsEnabled = !running;
        RankMatchCountBox.IsEnabled = !running;
        RankPauseSecondsBox.IsEnabled = !running;
        Big3MatchCountBox.IsEnabled = !running;
        Big3PauseSecondsBox.IsEnabled = !running;
        RunPill.Visibility = running ? Visibility.Visible : Visibility.Collapsed;

        if (!running) SetHint("Press Start playing when you're ready.");
    }

    private void SetStatus(string text) => StatusText.Text = text;

    private void SetHint(string text) => StatusHint.Text = text;

    private void ClearLogButton_Click(object sender, RoutedEventArgs e)
    {
        while (_logQueue.TryDequeue(out _)) { }
        LogBox.Document.Blocks.Clear();
    }

    private enum LogLevel { Info, Debug, Warn, Error, Success, Status, Progress }

    private static Brush BrushFor(LogLevel level) => level switch
    {
        LogLevel.Error => new SolidColorBrush(Color.FromRgb(0xF0, 0x6E, 0x6E)),
        LogLevel.Warn => new SolidColorBrush(Color.FromRgb(0xE8, 0xB1, 0x39)),
        LogLevel.Success => new SolidColorBrush(Color.FromRgb(0x5E, 0xD1, 0x8E)),
        LogLevel.Status => new SolidColorBrush(Color.FromRgb(0x6F, 0xB4, 0xFF)),
        LogLevel.Progress => new SolidColorBrush(Color.FromRgb(0xFF, 0x8A, 0x3D)),
        LogLevel.Debug => new SolidColorBrush(Color.FromRgb(0x80, 0x80, 0x8C)),
        _ => new SolidColorBrush(Color.FromRgb(0xDC, 0xDC, 0xE2))
    };

    private void Log(string text, LogLevel level = LogLevel.Info, string? source = null)
    {
        var prefix = level switch
        {
            LogLevel.Error => "ERR ",
            LogLevel.Warn => "WARN",
            LogLevel.Success => "OK  ",
            LogLevel.Status => "STAT",
            LogLevel.Progress => "PROG",
            LogLevel.Debug => "DBG ",
            _ => "LOG "
        };

        var suffix = string.IsNullOrEmpty(source) ? "" : $"  [{source}]";
        _logQueue.Enqueue(($"{DateTime.Now:HH:mm:ss.fff}  {prefix}  {text}{suffix}", BrushFor(level)));
    }

    private void FlushLogQueue()
    {
        if (_logQueue.IsEmpty) return;

        var doc = LogBox.Document;
        var appended = 0;

        while (appended < 400 && _logQueue.TryDequeue(out var entry))
        {
            doc.Blocks.Add(new Paragraph(new Run(entry.Text))
            {
                Foreground = entry.Colour,
                Margin = new Thickness(0)
            });
            appended++;
        }

        while (doc.Blocks.Count > MaxLogBlocks)
            doc.Blocks.Remove(doc.Blocks.FirstBlock);

        // Always follows the newest entry — the toggle for this was removed as
        // nobody wanted the alternative.
        LogBox.ScrollToEnd();
    }
}

// ======================================================================
// DTOs
// ======================================================================
internal sealed class BridgeMessage
{
    public string? Type { get; set; }
    public string? Level { get; set; }
    public string? Text { get; set; }

    /// <summary>Alias for <see cref="Text"/>. The LOG contract specifies
    /// { type:"LOG", message:"..." }, so accept either field name.</summary>
    public string? Message { get; set; }

    /// <summary>Whichever of the two the sender populated.</summary>
    public string Body => Text ?? Message ?? string.Empty;

    public string? Source { get; set; }
    public int? Current { get; set; }
    public int? Total { get; set; }
    public int? Succeeded { get; set; }
    public int? Failed { get; set; }
    public bool? Cancelled { get; set; }
}

/// <summary>
/// Wire format for a MATCH_SUMMARY payload:
/// { "type":"MATCH_SUMMARY", "outcome":"DEFEAT", "myScore":110,
///   "opponentScore":125, "opponentName":"[MNR] S1MPLE" }
/// </summary>
internal sealed class MatchSummaryMessage
{
    public string? Type { get; set; }
    public string? Outcome { get; set; }
    public int MyScore { get; set; }
    public int OpponentScore { get; set; }

    /// <summary>Player who earned MVP, e.g. "TIM DUNCAN".</summary>
    public string? MvpName { get; set; }

    /// <summary>Opponent's handle, e.g. "[MNR] S1MPLE". Read page-wide from
    /// the rightmost tagged element, not from the MVP card — the MVP is often
    /// your own player, which made that source unreliable.</summary>
    public string? OpponentName { get; set; }

    /// <summary>Superseded field, still accepted from older payloads.</summary>
    public string? MvpHandle { get; set; }
}

/// <summary>A single row in the Match History grid.</summary>
internal sealed class MatchRecord
{
    public DateTime Timestamp { get; init; }
    public string Outcome { get; init; } = "UNKNOWN";
    public int MyScore { get; init; }
    public int OpponentScore { get; init; }
    public string MvpName { get; init; } = "—";
    public string OpponentName { get; init; } = "—";

    /// <summary>Pre-formatted for the grid; avoids a converter.</summary>
    public string TimestampText => Timestamp.ToString("HH:mm:ss");

    public bool IsWin => Outcome == "VICTORY";
    public int Margin => MyScore - OpponentScore;
}

internal sealed class RunConfig
{
    [JsonPropertyName("targetIterations")] public int TargetIterations { get; set; }
    [JsonPropertyName("actionDelayMs")] public int ActionDelayMs { get; set; }
    [JsonPropertyName("retryThreshold")] public int RetryThreshold { get; set; }
    [JsonPropertyName("targetSelector")] public string TargetSelector { get; set; } = "";
    [JsonPropertyName("verbose")] public bool Verbose { get; set; }
}
