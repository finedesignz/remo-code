<#
.SYNOPSIS
  Build the Remo Code Supervisor Tauri app locally, only when sources changed.

.DESCRIPTION
  1. Pulls latest `main` (fast-forward only) in the canonical checkout.
  2. Compares HEAD against the last successfully built SHA stored in
     `supervisor/tauri/.last-built-sha`. If no files under `supervisor/tauri/`
     (or root `package.json` / `Cargo.toml` / `Cargo.lock`) changed since that
     SHA, exits early with "no changes".
  3. Builds the UI (`bun install && bun run build`) and the Tauri MSI
     (`cargo tauri build`).
  4. Writes the new HEAD SHA into `.last-built-sha` and prints the MSI path.

.PARAMETER Install
  After a successful build, run the MSI via msiexec /passive /i.

.PARAMETER Watch
  Loop forever, polling `git fetch` every 5 minutes and rebuilding when a
  relevant change lands.

.PARAMETER Force
  Build even if the stamp file says nothing changed.

.EXAMPLE
  pwsh -File supervisor/tauri/scripts/build-and-update.ps1
  pwsh -File supervisor/tauri/scripts/build-and-update.ps1 -Install
  pwsh -File supervisor/tauri/scripts/build-and-update.ps1 -Watch
#>
[CmdletBinding()]
param(
    [switch]$Install,
    [switch]$Watch,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'

# --------------------------------------------------------------------------- #
# Paths
# --------------------------------------------------------------------------- #
$RepoRoot     = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$SupervisorPkgDir = Join-Path $RepoRoot 'supervisor'        # holds supervisor/package.json + scripts/compile-sidecar.mjs
$SupervisorDir= Join-Path $RepoRoot 'supervisor\tauri'
$UiDir        = Join-Path $SupervisorDir 'ui'
$SrcTauriDir  = Join-Path $SupervisorDir 'src-tauri'
$StampFile    = Join-Path $SupervisorDir '.last-built-sha'
$BundleDir    = Join-Path $SrcTauriDir 'target\release\bundle\msi'

function Write-Section($title) {
    Write-Host ""
    Write-Host ("=" * 70) -ForegroundColor Cyan
    Write-Host ("  " + $title) -ForegroundColor Cyan
    Write-Host ("=" * 70) -ForegroundColor Cyan
}

function Invoke-Native($exe, $argList, $cwd) {
    Write-Host "[$cwd] $exe $($argList -join ' ')" -ForegroundColor DarkGray
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $exe
    foreach ($a in $argList) { [void]$psi.ArgumentList.Add($a) }
    $psi.WorkingDirectory = $cwd
    $psi.UseShellExecute = $false
    $proc = [System.Diagnostics.Process]::Start($psi)
    $proc.WaitForExit()
    if ($proc.ExitCode -ne 0) {
        throw "Command failed ($exe): exit $($proc.ExitCode)"
    }
}

function Get-RelevantPaths {
    @(
        'supervisor/tauri',
        'package.json',
        'bun.lockb',
        'bun.lock'
    )
}

function Has-RelevantChanges($sinceSha) {
    if (-not $sinceSha) { return $true }
    Push-Location $RepoRoot
    try {
        $paths = Get-RelevantPaths
        $args = @('diff', '--name-only', "$sinceSha..HEAD", '--') + $paths
        $changed = & git @args
        if ($LASTEXITCODE -ne 0) { return $true }   # if compare fails, rebuild
        return ($changed | Where-Object { $_ -ne '' }).Count -gt 0
    } finally { Pop-Location }
}

function Read-Stamp {
    if (Test-Path $StampFile) {
        return (Get-Content -Raw -Path $StampFile).Trim()
    }
    return $null
}

function Write-Stamp($sha) {
    Set-Content -Path $StampFile -Value $sha -NoNewline
}

function Sync-Main {
    Write-Section 'git: fetch + ff-only pull main'
    Push-Location $RepoRoot
    try {
        & git fetch origin --quiet
        $currentBranch = (& git rev-parse --abbrev-ref HEAD).Trim()
        if ($currentBranch -eq 'main') {
            $localSha  = (& git rev-parse HEAD).Trim()
            $remoteSha = (& git rev-parse origin/main).Trim()
            if ($localSha -ne $remoteSha) {
                Write-Host "main is behind origin/main — pulling" -ForegroundColor Yellow
                & git pull --ff-only origin main
            } else {
                Write-Host "main already up to date." -ForegroundColor Green
            }
        } else {
            Write-Host "On branch '$currentBranch' (not main) — skipping pull." -ForegroundColor Yellow
        }
    } finally { Pop-Location }
}

function Build-Once {
    Sync-Main

    $headSha = (& git -C $RepoRoot rev-parse HEAD).Trim()
    $lastSha = Read-Stamp

    Write-Host ""
    Write-Host ("HEAD:        {0}" -f $headSha)
    Write-Host ("Last built:  {0}" -f ($(if ($lastSha) { $lastSha } else { '(none)' })))

    if (-not $Force -and $lastSha -eq $headSha) {
        Write-Host "no changes (HEAD == last built SHA)." -ForegroundColor Green
        return $false
    }
    if (-not $Force -and -not (Has-RelevantChanges $lastSha)) {
        Write-Host "no changes (nothing relevant changed since last build)." -ForegroundColor Green
        Write-Stamp $headSha   # advance stamp so we don't re-check forever
        return $false
    }

    Write-Section 'ui: bun install && bun run build'
    Invoke-Native 'bun' @('install') $UiDir
    Invoke-Native 'bun' @('run', 'build') $UiDir

    Write-Section 'sidecar: bun build --compile (version-injected)'
    # Recompile the sidecar binary with the authoritative version baked in, so
    # `cargo tauri build` bundles a fresh sidecar that reports the manifest
    # version (not a stale one). Shared with CI via supervisor/package.json.
    Invoke-Native 'bun' @('run', 'build:sidecar') $SupervisorPkgDir

    Write-Section 'tauri: cargo tauri build'
    # `cargo tauri build` is run from src-tauri's parent (the tauri.conf.json
    # lives next to src-tauri). `tauri-cli` is invoked via cargo subcommand.
    Invoke-Native 'cargo' @('tauri', 'build') $SupervisorDir

    $msi = Get-ChildItem -Path $BundleDir -Filter '*.msi' -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if (-not $msi) {
        throw "Build reported success but no .msi found under $BundleDir"
    }

    Write-Stamp $headSha
    Write-Section 'build OK'
    Write-Host ("MSI: {0}" -f $msi.FullName) -ForegroundColor Green
    $script:LastMsi = $msi.FullName
    return $true
}

# --------------------------------------------------------------------------- #
# Main
# --------------------------------------------------------------------------- #
$script:LastMsi = $null

if ($Watch) {
    Write-Section 'watch mode — Ctrl-C to stop'
    while ($true) {
        try {
            $built = Build-Once
            if ($built -and $Install -and $script:LastMsi) {
                Write-Section 'install (msiexec /passive)'
                Start-Process msiexec -ArgumentList @('/i', $script:LastMsi, '/passive') -Wait
            }
        } catch {
            Write-Host "build cycle failed: $_" -ForegroundColor Red
        }
        Write-Host ""
        Write-Host "sleeping 5 min..." -ForegroundColor DarkGray
        Start-Sleep -Seconds 300
    }
} else {
    $built = Build-Once
    if ($built -and $Install -and $script:LastMsi) {
        Write-Section 'install (msiexec /passive)'
        Start-Process msiexec -ArgumentList @('/i', $script:LastMsi, '/passive') -Wait
        Write-Host "install complete." -ForegroundColor Green
    }
}
