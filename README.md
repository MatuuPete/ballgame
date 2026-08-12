# WebView2 Automation Harness

A WPF shell that hosts a target web app in WebView2, injects a JavaScript automation
bundle on demand, and streams `console.*` output plus structured progress back into a
native log console — replacing the manual "paste script into DevTools" loop.

```
WebView2Automation/
├─ WebView2Automation.csproj
├─ app.manifest
├─ App.xaml / App.xaml.cs          dark theme resources
├─ MainWindow.xaml                 split view: browser | control panel + log
├─ MainWindow.xaml.cs              environment setup, injection, message routing
└─ Scripts/
   ├─ bridge.js                    console + error relay (document-created script)
   └─ automation.js                template loop with startLoop / stopLoop
```

---

## 1. Setup

### Prerequisites

- Windows 10 1809+ / Windows 11
- .NET 8 SDK (any of net6.0/7.0/8.0/9.0-windows works — change `TargetFramework`)
- **WebView2 Evergreen Runtime** — preinstalled on Windows 11 and on up-to-date
  Windows 10. If missing, install the Evergreen Bootstrapper from
  <https://developer.microsoft.com/microsoft-edge/webview2/>. The app detects the
  absence and logs a message rather than crashing.

### NuGet

One package:

```powershell
dotnet add package Microsoft.Web.WebView2
```

or in Visual Studio: **Manage NuGet Packages → Browse → `Microsoft.Web.WebView2` → Install**.

The `.csproj` already pins `1.0.2903.40`. Any 1.0.19xx+ version supports every API used here.

### Build & run

```powershell
cd WebView2Automation
dotnet restore
dotnet build
dotnet run
```

> `dotnet run` from the project directory copies `Scripts\*.js` next to the exe
> (`CopyToOutputDirectory=PreserveNewest`). You can edit the JS and just restart the
> app — no recompile of C# needed.

### Deployment note

The `Microsoft.Web.WebView2` package brings native `WebView2Loader.dll` per
architecture. For a published build, prefer an explicit RID:

```powershell
dotnet publish -c Release -r win-x64 --self-contained false
```

---

## 2. Session persistence

Everything Chromium persists — cookies, `localStorage`, `IndexedDB`, service workers,
cache — lives in the **user data folder**. Point it at a stable path and logins survive
restarts:

```csharp
private static readonly string UserDataFolder = Path.Combine(
    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
    "WebView2Automation", "UserData");

var environment = await CoreWebView2Environment.CreateAsync(
    browserExecutableFolder: null,     // use the installed Evergreen runtime
    userDataFolder: UserDataFolder,
    options: new CoreWebView2EnvironmentOptions
    {
        AdditionalBrowserArguments = "--disable-background-timer-throttling",
        Language = "en-US"
    });

await Browser.EnsureCoreWebView2Async(environment);
```

Resolves to `%LOCALAPPDATA%\WebView2Automation\UserData`.

**Declarative alternative** (`CoreWebView2CreationProperties`) if you prefer a fixed path
and no explicit environment object — set it in XAML before the control initialises:

```xml
<wv2:WebView2 x:Name="Browser">
    <wv2:WebView2.CreationProperties>
        <wv2:CoreWebView2CreationProperties
            UserDataFolder="C:\ProgramData\WebView2Automation\UserData"
            Language="en-US" />
    </wv2:WebView2.CreationProperties>
</wv2:WebView2>
```

Or in code before `EnsureCoreWebView2Async(null)`:

```csharp
Browser.CreationProperties = new CoreWebView2CreationProperties
{
    UserDataFolder = UserDataFolder
};
await Browser.EnsureCoreWebView2Async();
```

Gotchas:

- If you never set it, WebView2 creates a folder next to your exe named
  `<AppName>.exe.WebView2` — which breaks when the exe sits in `Program Files`
  (no write access) and gets wiped by installers.
- The folder must be writable and **cannot be shared by two processes** using
  different environment options at the same time.
- Only *persistent* cookies survive. If the site issues session cookies, the login
  ends when the browser process ends regardless of this setting.
- To force a clean profile, delete the folder or call
  `core.Profile.ClearBrowsingDataAsync(...)`.

---

## 3. Bidirectional interop

### JS → C#

`bridge.js` is registered with `AddScriptToExecuteOnDocumentCreatedAsync`, which is the
important detail: it runs **before any page script, on every document**, including SPA
reloads and iframes. So console hooks reattach automatically after navigation with no
host involvement.

```csharp
core.Settings.IsWebMessageEnabled = true;   // required
await core.AddScriptToExecuteOnDocumentCreatedAsync(await LoadScriptAsync("bridge.js"));
core.WebMessageReceived += OnWebMessageReceived;
```

Every message is a JSON object with a `type` discriminator:

| `type`     | Fields                                              | Effect in WPF                       |
|------------|-----------------------------------------------------|-------------------------------------|
| `console`  | `level`, `text`, `source`                           | Colour-coded log line               |
| `progress` | `current`, `total`, `text`                          | Progress bar + "Iteration X of Y"   |
| `status`   | `text`                                              | Status label                        |
| `started`  | `total`                                             | Disables inputs, enables Stop       |
| `done`     | `succeeded`, `failed`, `cancelled`                  | Re-enables inputs, final summary    |
| `error`    | `text`, `source`                                    | Red log line                        |

Read them with `WebMessageAsJson` (works for objects, arrays and primitives).
`TryGetWebMessageAsString` throws if the payload was not a bare string, so avoid it
unless you control both ends and only send strings.

`WebMessageReceived` fires on the UI thread — no `Dispatcher.Invoke` needed. The log is
still batched through a `DispatcherTimer` because a chatty page can post thousands of
lines per second and per-message `RichTextBox` appends will lock up the UI.

### C# → JS

```csharp
_automationSource ??= await LoadScriptAsync("automation.js");
await Browser.CoreWebView2.ExecuteScriptAsync(_automationSource);   // idempotent

var json = JsonSerializer.Serialize(config);
await Browser.CoreWebView2.ExecuteScriptAsync($"window.startLoop({json});");
```

Notes:

- `ExecuteScriptAsync` takes a JS **expression**, and its return value is
  **JSON-encoded** — a string result comes back wrapped in quotes, and `undefined`
  comes back as the literal `"null"`.
- Only JSON-serialisable values cross the boundary. Serialising config to a JSON
  object literal is the safest way to pass structured parameters; never string-concat
  raw user input into script text.
- It returns as soon as the expression evaluates. `startLoop` deliberately kicks off
  an un-awaited async IIFE and reports progress over `postMessage`, rather than
  returning a promise the host would have to poll.
- For strongly-typed calls in the other direction, `AddHostObjectToScript` exposes a
  COM-visible C# object as `window.chrome.webview.hostObjects.*`. `postMessage` is
  lighter and enough for this workflow.

---

## 4. The JS template

`Scripts/automation.js` is a working skeleton. The only part you should need to
rewrite is `performIteration`:

```js
async function performIteration(i, config) {
    var target = await waitForSelector(config.targetSelector, 10000);
    target.click();
    await sleep(config.actionDelayMs);
    // throw new Error('assertion failed') to trigger the retry path
    return 'ok';
}
```

Everything around it is provided:

- `runIterationWithRetry` honours **Retry Threshold** with linear backoff
- the loop posts `{type:'progress', current, total}` after each iteration
- `window.stopLoop()` sets a cancel flag checked at every await point — cooperative
  cancellation, so the current iteration finishes cleanly rather than being torn
  mid-DOM-write
- `window.loopStatus()` returns a snapshot, useful from DevTools (F12 is enabled)
- a re-injection guard (`window.__automationInstalled`) means clicking Start twice
  never stacks two loops

---

## Known behaviours worth knowing

- **Navigation kills automation state.** `bridge.js` reattaches automatically;
  `automation.js` does not, because it is injected via `ExecuteScriptAsync` into a
  specific document. The host detects navigation during a run and resets the UI. If
  your workflow navigates between iterations, move `automation.js` into
  `AddScriptToExecuteOnDocumentCreatedAsync` as well and have the host re-issue
  `startLoop` on `NavigationCompleted`.
- **Background throttling.** Chromium throttles timers in hidden windows. The
  `--disable-background-timer-throttling` switch is set for this reason; keep the
  window visible for timing-sensitive runs.
- **The log relay is not free.** At very high console volume, disable *Verbose* to
  drop `console.debug`/`console.info` at the C# boundary.
- **Automating third-party sites** may violate their terms of service and trip bot
  detection. Point this at applications you own or are authorised to test.
