using System.Collections.ObjectModel;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;

namespace WebView2Automation;

/// <summary>
/// Startup chooser. Shown when no --profile argument was supplied.
///
/// On success <see cref="AcquiredSession"/> holds a profile whose lock is
/// already taken, so the caller can hand it straight to MainWindow without a
/// second chance for another process to claim it in between.
/// </summary>
public partial class ProfilePickerWindow : Window
{
    /// <summary>Row model for the list.</summary>
    internal sealed class ProfileEntry
    {
        public string Name { get; init; } = "";
        public bool InUse { get; init; }
        public Visibility InUseVisibility => InUse ? Visibility.Visible : Visibility.Collapsed;
    }

    private readonly ObservableCollection<ProfileEntry> _entries = new();

    /// <summary>Populated on OK when <see cref="AcquireOnAccept"/> is true.</summary>
    internal ProfileSession? AcquiredSession { get; private set; }

    /// <summary>The chosen name, whether or not a lock was taken.</summary>
    internal string? SelectedProfileName { get; private set; }

    /// <summary>
    /// True (startup): take the lock immediately and hand back a live session.
    /// False (running app): only return the name, because the caller is going
    /// to launch a separate process that must acquire the lock itself.
    /// </summary>
    internal bool AcquireOnAccept { get; set; } = true;

    public ProfilePickerWindow()
    {
        InitializeComponent();

        ProfileList.ItemsSource = _entries;
        Loaded += (_, _) =>
        {
            // Dark caption to match the main window.
            NativeMethods.ApplyModernChrome(this, NativeMethods.Backdrop.None);
            RefreshProfiles();
            NewProfileBox.Focus();
        };
    }

    private void RefreshProfiles(string? selectName = null)
    {
        _entries.Clear();

        foreach (var name in ProfileManager.ListProfiles())
            _entries.Add(new ProfileEntry { Name = name, InUse = ProfileManager.IsInUse(name) });

        var target = selectName is not null
            ? _entries.FirstOrDefault(e => e.Name.Equals(selectName, StringComparison.OrdinalIgnoreCase))
            : _entries.FirstOrDefault(e => !e.InUse) ?? _entries.FirstOrDefault();

        ProfileList.SelectedItem = target;
    }

    private void ShowMessage(string text) => MessageText.Text = text;

    // ------------------------------------------------------------------
    // Selection
    // ------------------------------------------------------------------

    private void ProfileList_SelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        if (ProfileList.SelectedItem is ProfileEntry entry)
        {
            // Selecting a list entry means you are not creating a new one.
            NewProfileBox.Text = string.Empty;
            ShowMessage(entry.InUse
                ? $"\"{entry.Name}\" is open in another window."
                : string.Empty);
        }
    }

    private void ProfileList_MouseDoubleClick(object sender, MouseButtonEventArgs e)
    {
        if (ProfileList.SelectedItem is ProfileEntry) Accept();
    }

    private void NewProfileBox_TextChanged(object sender, TextChangedEventArgs e)
    {
        // Typing a new name deselects the list, so intent is never ambiguous.
        if (!string.IsNullOrWhiteSpace(NewProfileBox.Text))
        {
            ProfileList.SelectedItem = null;
            ShowMessage(string.Empty);
        }
    }

    private void NewProfileBox_KeyDown(object sender, KeyEventArgs e)
    {
        if (e.Key == Key.Enter) Accept();
    }

    private void CreateButton_Click(object sender, RoutedEventArgs e) => Accept();

    private void OpenButton_Click(object sender, RoutedEventArgs e) => Accept();

    private void CancelButton_Click(object sender, RoutedEventArgs e)
    {
        DialogResult = false;
        Close();
    }

    // ------------------------------------------------------------------
    // Acquire
    // ------------------------------------------------------------------

    private void Accept()
    {
        var typed = NewProfileBox.Text?.Trim() ?? string.Empty;

        var name = typed.Length > 0
            ? ProfileManager.Sanitise(typed)
            : (ProfileList.SelectedItem as ProfileEntry)?.Name;

        if (string.IsNullOrWhiteSpace(name))
        {
            ShowMessage("Pick a profile from the list, or type a name to create one.");
            return;
        }

        SelectedProfileName = name;

        if (AcquireOnAccept)
        {
            // Acquire here rather than in the caller: the lock is taken while
            // the choice is still fresh, closing the window where another
            // process could grab the same profile.
            var session = ProfileManager.TryAcquire(name, out var error);

            if (session is null)
            {
                ShowMessage(error);
                RefreshProfiles(name);
                return;
            }

            AcquiredSession = session;
        }
        else
        {
            // Name-only mode: refuse a profile someone already has open, since
            // the new process would just fail to acquire it.
            if (ProfileManager.IsInUse(name))
            {
                ShowMessage($"\"{name}\" is already open in another window.");
                RefreshProfiles(name);
                return;
            }
        }

        DialogResult = true;
        Close();
    }
}
