<#
    publish.ps1 — build a double-clickable WebView2Automation.exe.

    Usage:
        .\publish.ps1                 framework-dependent (~3 MB, needs .NET 8 Desktop Runtime)
        .\publish.ps1 -SelfContained  standalone (~150 MB, runs on a bare Windows box)
        .\publish.ps1 -Output D:\Tools\WebView2Automation

    If PowerShell refuses to run this, unblock the script for the session:
        Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
#>

[CmdletBinding()]
param(
    [switch]$SelfContained,
    [string]$Runtime = 'win-x64',
    [string]$Output
)

$ErrorActionPreference = 'Stop'
$projectDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Push-Location $projectDir

try {
    if (-not $Output) {
        $Output = Join-Path $projectDir "dist\$Runtime"
    }

    Write-Host ''
    Write-Host '  Publishing WebView2Automation' -ForegroundColor Cyan
    Write-Host "  Runtime        : $Runtime"
    Write-Host ("  Self-contained : {0}" -f $(if ($SelfContained) { 'yes (bundles .NET)' } else { 'no (needs .NET 8 Desktop Runtime)' }))
    Write-Host "  Output         : $Output"
    Write-Host ''

    $args = @(
        'publish'
        '-c', 'Release'
        '-r', $Runtime
        '--self-contained', $(if ($SelfContained) { 'true' } else { 'false' })
        '-p:PublishSingleFile=true'
        '-p:IncludeNativeLibrariesForSelfExtract=true'
        '-p:DebugType=None'
        '-p:DebugSymbols=false'
        '-o', $Output
    )

    & dotnet @args
    if ($LASTEXITCODE -ne 0) { throw "dotnet publish failed with exit code $LASTEXITCODE." }

    $exe = Join-Path $Output 'WebView2Automation.exe'
    if (-not (Test-Path $exe)) { throw "Expected executable not found at $exe" }

    # The JS bundles must sit beside the exe. Verify rather than assume.
    $scripts = @('Scripts\bridge.js', 'Scripts\automation.js')
    $missing = $scripts | Where-Object { -not (Test-Path (Join-Path $Output $_)) }
    if ($missing) {
        Write-Warning "Missing from output: $($missing -join ', ')"
        Write-Warning 'Copying from the project folder as a fallback.'
        New-Item -ItemType Directory -Force -Path (Join-Path $Output 'Scripts') | Out-Null
        foreach ($s in $missing) {
            Copy-Item (Join-Path $projectDir $s) (Join-Path $Output $s) -Force
        }
    }

    $sizeMb = [math]::Round(((Get-ChildItem $Output -Recurse -File |
                Measure-Object -Property Length -Sum).Sum / 1MB), 1)

    Write-Host ''
    Write-Host '  Done.' -ForegroundColor Green
    Write-Host "  Executable : $exe"
    Write-Host "  Total size : $sizeMb MB"
    Write-Host ''
    Write-Host '  Next: right-click the exe -> Send to -> Desktop (create shortcut),' -ForegroundColor DarkGray
    Write-Host '        or Pin to taskbar. Keep the Scripts folder beside it.' -ForegroundColor DarkGray
    Write-Host ''

    # Offer to create a desktop shortcut.
    $reply = Read-Host '  Create a Desktop shortcut now? [y/N]'
    if ($reply -match '^(y|yes)$') {
        $lnk = Join-Path ([Environment]::GetFolderPath('Desktop')) 'WebView2 Automation.lnk'
        $shell = New-Object -ComObject WScript.Shell
        $sc = $shell.CreateShortcut($lnk)
        $sc.TargetPath = $exe
        $sc.WorkingDirectory = $Output      # critical: Scripts\ is resolved relative to this
        $sc.Description = 'WebView2 automation harness'
        $sc.Save()
        Write-Host "  Shortcut created: $lnk" -ForegroundColor Green
    }

    explorer.exe $Output
}
finally {
    Pop-Location
}
