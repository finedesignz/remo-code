<#
.SYNOPSIS
  Woodpecker CI: build the Supervisor MSI on a native Windows agent, Authenticode-signed
  via Azure Trusted Signing, with a valid Tauri updater signature.

.DESCRIPTION
  This is the Woodpecker port of the `release-supervisor.yml` GitHub Actions workflow.
  It preserves the workflow's single load-bearing correctness constraint:

    *** Signing MUST happen DURING tauri bundling, via bundle.windows.signCommand. ***

  Tauri computes the updater `.sig` over the final MSI bytes. If you sign the MSI
  AFTER `cargo tauri build` (e.g. a post-build `signtool sign` pass), the Authenticode
  signature mutates the file after the `.sig` was generated, and every existing install
  silently fails updater signature verification. So we inject `signCommand` into
  tauri.conf.json BEFORE the build and let Tauri call sign.ps1 per-artifact.

  Run from the repo root.
#>
$ErrorActionPreference = 'Stop'

$RepoRoot      = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$SupervisorDir = Join-Path $RepoRoot 'supervisor\tauri'
$SrcTauriDir   = Join-Path $SupervisorDir 'src-tauri'
$ConfPath      = Join-Path $SrcTauriDir 'tauri.conf.json'
$MetaPath      = Join-Path $SupervisorDir 'signing\trusted-signing-metadata.json'
$BundleDir     = Join-Path $SrcTauriDir 'target\x86_64-pc-windows-msvc\release\bundle\msi'

function Section($m) { Write-Host "`n=== $m ===" -ForegroundColor Cyan }

# Write UTF-8 WITHOUT a BOM.
# Windows PowerShell 5.1's `Set-Content -Encoding utf8` emits a BOM, and a BOM at the
# head of tauri.conf.json makes every strict JSON parser fail -- bun dies with
# "JSON Parse error: Unrecognized token '<feff>'" when compile-sidecar.mjs reads it.
function Write-JsonNoBom($Path, $Object) {
    $json = $Object | ConvertTo-Json -Depth 20
    [IO.File]::WriteAllText($Path, $json, (New-Object Text.UTF8Encoding($false)))
}

# ---------------------------------------------------------------------------
# 0. Normalise secrets coming from Woodpecker.
#    Woodpecker rejects empty secret values, so an empty updater-key passphrase
#    is stored as the sentinel __EMPTY__ and mapped back to "" here.
# ---------------------------------------------------------------------------
if ($env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD -eq '__EMPTY__') {
    $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = ''
}

# Woodpecker exports CI=woodpecker. The Tauri CLI maps $CI onto its --ci flag, which
# only accepts true/false -> "invalid value 'woodpecker' for '--ci'". Normalise it.
if ($env:CI -and $env:CI -notin @('true','false')) { $env:CI = 'true' }

# PROOF MODE (PROOF_SKIP_UPDATER_SIG=1): skip ONLY the Tauri updater .sig, so the
# Windows-agent + Azure-Trusted-Signing path can be proven end-to-end without the
# updater key passphrase. Azure Authenticode signing stays MANDATORY.
# A build produced this way MUST NOT be released: the in-app updater rejects an MSI
# with no .sig. Never set this on a tag/release run.
$SkipUpdaterSig = $env:PROOF_SKIP_UPDATER_SIG -eq '1'

# Fail closed: never let a "successful" build ship an unsigned or unsignable MSI.
$required = @('AZURE_CLIENT_ID','AZURE_CLIENT_SECRET','AZURE_TENANT_ID','TRUSTED_SIGNING_DLIB')
if (-not $SkipUpdaterSig) { $required += 'TAURI_SIGNING_PRIVATE_KEY' }
foreach ($v in $required) {
    if ([string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($v))) {
        throw "required env var $v is not set - refusing to build"
    }
}
if ($SkipUpdaterSig) {
    Write-Warning 'PROOF_SKIP_UPDATER_SIG=1 -> updater .sig will NOT be generated. NOT RELEASABLE.'
    Remove-Item Env:\TAURI_SIGNING_PRIVATE_KEY -ErrorAction SilentlyContinue
    Remove-Item Env:\TAURI_SIGNING_PRIVATE_KEY_PASSWORD -ErrorAction SilentlyContinue
}
if (-not (Test-Path -LiteralPath $env:TRUSTED_SIGNING_DLIB)) {
    throw "TRUSTED_SIGNING_DLIB points at a missing file: $($env:TRUSTED_SIGNING_DLIB)"
}

# ---------------------------------------------------------------------------
# 1. Point the signing metadata at the real cert profile.
#    The committed default is stale; CERT_PROFILE_NAME is the source of truth.
# ---------------------------------------------------------------------------
Section 'configure signing metadata'
if (-not [string]::IsNullOrWhiteSpace($env:CERT_PROFILE_NAME)) {
    $meta = Get-Content -Raw -LiteralPath $MetaPath | ConvertFrom-Json
    $meta.CertificateProfileName = $env:CERT_PROFILE_NAME
    Write-JsonNoBom $MetaPath $meta
    Write-Host "CertificateProfileName = $($env:CERT_PROFILE_NAME)"
}
Get-Content -Raw -LiteralPath $MetaPath | Write-Host

# ---------------------------------------------------------------------------
# 2. Inject bundle.windows.signCommand for THIS build only (not committed).
#    Tauri runs signCommand with cwd = src-tauri, so the path is relative to it.
# ---------------------------------------------------------------------------
Section 'inject bundle.windows.signCommand'
$conf = Get-Content -Raw -LiteralPath $ConfPath | ConvertFrom-Json
$signCmd = 'powershell -ExecutionPolicy Bypass -File ../signing/sign.ps1 %1'
if (-not $conf.bundle.windows) {
    $conf.bundle | Add-Member -NotePropertyName windows -NotePropertyValue (@{}) -Force
}
$conf.bundle.windows | Add-Member -NotePropertyName signCommand -NotePropertyValue $signCmd -Force
Write-JsonNoBom $ConfPath $conf
Write-Host "signCommand = $signCmd"

# ---------------------------------------------------------------------------
# 3. Build UI + sidecar
# ---------------------------------------------------------------------------
Section 'ui: bun install && bun run build'
Push-Location (Join-Path $SupervisorDir 'ui')
& bun install;   if ($LASTEXITCODE) { throw "bun install failed" }
& bun run build; if ($LASTEXITCODE) { throw "ui build failed" }
Pop-Location

Section 'sidecar: bun run build:sidecar'
Push-Location (Join-Path $RepoRoot 'supervisor')
& bun install;            if ($LASTEXITCODE) { throw "bun install (supervisor) failed" }
& bun run build:sidecar;  if ($LASTEXITCODE) { throw "sidecar compile failed" }
Pop-Location

# ---------------------------------------------------------------------------
# 4. Bundle. Tauri calls sign.ps1 mid-bundle, THEN computes the updater .sig
#    over the already-Authenticode-signed MSI.
# ---------------------------------------------------------------------------
Section 'cargo tauri build (signs during bundling)'
Push-Location $SupervisorDir
& cargo tauri build --target x86_64-pc-windows-msvc
$code = $LASTEXITCODE
Pop-Location

# ---------------------------------------------------------------------------
# 5. Verify: Authenticode chain + updater .sig presence.
#    Runs even when the build failed at a LATER stage (e.g. updater signing), so a
#    successfully Authenticode-signed MSI is still archived + verified as evidence.
#    The original build failure is re-raised afterwards - this never turns a failed
#    build green.
# ---------------------------------------------------------------------------
Section 'verify signature'
$msi = Get-ChildItem -LiteralPath $BundleDir -Filter '*.msi' -ErrorAction SilentlyContinue |
       Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $msi) {
    if ($code) { throw "cargo tauri build failed with exit code $code (no MSI produced)" }
    throw "no .msi produced under $BundleDir"
}

# Archive out of the ephemeral workspace before Woodpecker reaps it.
$archive = 'C:\Woodpecker\evidence'
New-Item -ItemType Directory -Force -Path $archive | Out-Null
Copy-Item $msi.FullName $archive -Force
if (Test-Path -LiteralPath "$($msi.FullName).sig") { Copy-Item "$($msi.FullName).sig" $archive -Force }
Write-Host "archived -> $archive\$($msi.Name)"
Write-Host "MSI: $($msi.FullName)  ($([math]::Round($msi.Length/1MB,2)) MB)"

$signtool = $env:SIGNTOOL_PATH
if ([string]::IsNullOrWhiteSpace($signtool)) { throw 'SIGNTOOL_PATH not set' }

# /pa = Authenticode policy, /v = verbose. Non-zero exit => not validly signed.
& $signtool verify /pa /v $msi.FullName
if ($LASTEXITCODE) { throw "signtool verify FAILED - MSI is not validly signed (exit $LASTEXITCODE)" }

$sig = "$($msi.FullName).sig"
if (Test-Path -LiteralPath $sig) {
    Write-Host "updater .sig present (computed over the SIGNED msi): $sig"
} elseif (-not $SkipUpdaterSig) {
    Write-Warning "no updater .sig produced"
}

# Re-raise a build failure that happened after the MSI was signed (e.g. updater key).
if ($code) {
    throw "cargo tauri build failed with exit code $code (MSI was Authenticode-signed and verified above, but a later bundling stage failed)"
}

Write-Host "`nSIGNED MSI OK -> $($msi.FullName)"
