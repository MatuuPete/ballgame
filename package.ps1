<#
    package.ps1 — build a distributable KaHoops Arena package.

    Usage:
        .\package.ps1                       self-contained zip (default, ~60 MB zipped)
        .\package.ps1 -FrameworkDependent   small zip, target machine needs .NET 8 Desktop Runtime
        .\package.ps1 -NoZip                build the folder but skip the archive
        .\package.ps1 -Runtime win-arm64    for an ARM machine (Surface Pro X etc.)

    If PowerShell refuses to run this:
        Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
#>

[CmdletBinding()]
param(
    [switch]$FrameworkDependent,
    [switch]$NoZip,
    [string]$Runtime = 'win-x64'
)

$ErrorActionPreference = 'Stop'
$projectDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Push-Location $projectDir

try {
    $selfContained = -not $FrameworkDependent

    # ---- version from the csproj, so the zip name tracks releases ----
    $csproj  = Join-Path $projectDir 'WebView2Automation.csproj'
    $version = ([xml](Get-Content $csproj)).Project.PropertyGroup.Version | Where-Object { $_ } | Select-Object -First 1
    if (-not $version) { $version = '1.0.0' }

    $stageName = "KaHoopsArena-v$version-$Runtime"
    $stageDir  = Join-Path $projectDir "package\$stageName"
    $zipPath   = Join-Path $projectDir "package\$stageName.zip"

    Write-Host ''
    Write-Host '  Packaging KaHoops Arena' -ForegroundColor Cyan
    Write-Host "  Version        : $version"
    Write-Host "  Runtime        : $Runtime"
    Write-Host ("  Self-contained : {0}" -f $(if ($selfContained) { 'yes — no .NET needed on the target' } else { 'no — target needs .NET 8 Desktop Runtime' }))
    Write-Host "  Output         : $stageDir"
    Write-Host ''

    # ---- a running instance locks the exe and fails the publish ----
    Get-Process KaHoopsArena, WebView2Automation -ErrorAction SilentlyContinue |
        ForEach-Object {
            Write-Host "  Closing running instance (PID $($_.Id))..." -ForegroundColor DarkYellow
            $_ | Stop-Process -Force
        }
    Start-Sleep -Milliseconds 400

    if (Test-Path $stageDir) { Remove-Item $stageDir -Recurse -Force }
    if (Test-Path $zipPath)  { Remove-Item $zipPath  -Force }

    # ---- build ----
    $publishArgs = @(
        'publish'
        '-c', 'Release'
        '-r', $Runtime
        '--self-contained', $(if ($selfContained) { 'true' } else { 'false' })
        '-p:PublishSingleFile=true'
        '-p:IncludeNativeLibrariesForSelfExtract=true'
        '-p:DebugType=None'
        '-p:DebugSymbols=false'
        '-o', $stageDir
    )

    & dotnet @publishArgs
    if ($LASTEXITCODE -ne 0) { throw "dotnet publish failed with exit code $LASTEXITCODE." }

    # ---- verify the pieces that actually matter at runtime ----
    $exe = Join-Path $stageDir 'KaHoopsArena.exe'
    if (-not (Test-Path $exe)) { throw "Expected KaHoopsArena.exe in $stageDir" }

    $required = @('Scripts\automation.js', 'Scripts\bridge.js', 'Scripts\session-init.js')
    $missing  = $required | Where-Object { -not (Test-Path (Join-Path $stageDir $_)) }
    if ($missing) {
        Write-Warning "Missing from publish output: $($missing -join ', ')"
        Write-Warning 'Copying from the project folder as a fallback.'
        New-Item -ItemType Directory -Force -Path (Join-Path $stageDir 'Scripts') | Out-Null
        foreach ($f in $missing) { Copy-Item (Join-Path $projectDir $f) (Join-Path $stageDir $f) -Force }
    }

    # Stray pdb/xml files just bloat the archive.
    Get-ChildItem $stageDir -Include *.pdb, *.xml -Recurse -File |
        Remove-Item -Force -ErrorAction SilentlyContinue

    # ---- instructions that travel with the build ----
    $runtimeNote = if ($selfContained) {
        "Nothing else to install - .NET is bundled."
    } else {
        ".NET 8 Desktop Runtime is required. If the app won't start, install it:`r`n" +
        "     winget install Microsoft.DotNet.DesktopRuntime.8"
    }

    @"
KaHoops Arena  v$version  ($Runtime)
=========================================

SETUP
-----
1. Right-click the ZIP you received -> Properties -> tick "Unblock" -> OK.
   Do this BEFORE extracting, or Windows blocks every file inside it.

2. Extract the whole folder anywhere you like, for example:
       C:\Tools\KaHoopsArena
   Do NOT extract into Program Files.

3. Run KaHoopsArena.exe.
   Windows may show "Windows protected your PC" the first time.
   Click "More info" -> "Run anyway". The app is unsigned; that warning is expected.

REQUIREMENTS
------------
   $runtimeNote

   Microsoft Edge WebView2 Runtime is required. It is already present on
   Windows 11 and up-to-date Windows 10. If the app reports it missing:
       winget install Microsoft.EdgeWebView2Runtime

IMPORTANT
---------
   Keep the Scripts folder next to KaHoopsArena.exe. Moving the .exe on its
   own will start the app with a blank browser panel.

   Your Hoops Arena login does NOT travel with this package. Sign in once on
   this machine and it will be remembered from then on.

USING IT
--------
   1. Sign in to Hoops Arena in the left-hand panel.
   2. Pick Quick, Standard or Full session.
   3. Press "Start playing".

   Match History shows results as they come in. The Activity tab has the
   detailed log - tick "Show extra technical detail" there when reporting a
   problem.

   Stop ends the session after the current step. Press Stop a second time to
   stop immediately.
"@ | Set-Content (Join-Path $stageDir 'READ ME FIRST.txt') -Encoding UTF8

    $sizeMb = [math]::Round(((Get-ChildItem $stageDir -Recurse -File | Measure-Object Length -Sum).Sum / 1MB), 1)

    # ---- archive ----
    if (-not $NoZip) {
        Write-Host '  Compressing...' -ForegroundColor DarkGray
        Compress-Archive -Path (Join-Path $stageDir '*') -DestinationPath $zipPath -CompressionLevel Optimal
        $zipMb = [math]::Round(((Get-Item $zipPath).Length / 1MB), 1)
    }

    Write-Host ''
    Write-Host '  Done.' -ForegroundColor Green
    Write-Host "  Folder : $stageDir  ($sizeMb MB)"
    if (-not $NoZip) { Write-Host "  Archive: $zipPath  ($zipMb MB)" }
    Write-Host ''
    Write-Host '  Copy the ZIP to the other machine, unblock it, then extract.' -ForegroundColor DarkGray
    Write-Host ''

    explorer.exe (Join-Path $projectDir 'package')
}
finally {
    Pop-Location
}
