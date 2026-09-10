<#
.SYNOPSIS
  Sign a single artifact with Azure Trusted Signing via signtool + the Trusted Signing dlib.

.DESCRIPTION
  Tauri invokes this per-artifact through bundle.windows.signCommand. With Tauri's signCommand,
  the placeholder "%1" is substituted with the absolute path to the file to sign, and is passed
  to this script as the first positional argument ($args[0]).

  signtool is located from the Windows SDK; the Trusted Signing dlib (Azure.CodeSigning.Dlib.dll
  from the Microsoft.Trusted.Signing.Client NuGet) is resolved from the env var
  TRUSTED_SIGNING_DLIB. If that env var is unset, this script fails loudly (non-zero exit) so a
  misconfigured signing build never ships an unsigned artifact.

  This script is INERT until the release workflow injects bundle.windows.signCommand at build
  time (gated on the repo variable ENABLE_MSI_SIGNING == 'true'). The committed tauri.conf.json
  has NO signCommand, so normal builds never invoke this file. See ./README.md.

.PARAMETER FileToSign
  Absolute path to the artifact to sign. Tauri passes this as %1 -> $args[0].

.EXAMPLE
  $env:TRUSTED_SIGNING_DLIB = "C:\tools\trusted-signing\bin\x64\Azure.CodeSigning.Dlib.dll"
  .\signing\sign.ps1 "C:\path\to\Remo Code Supervisor_0.12.1_x64_en-US.msi"
#>

$ErrorActionPreference = 'Stop'

# --- 1. Resolve the artifact path (Tauri %1 -> $args[0]) ---------------------
$FileToSign = $args[0]
if ([string]::IsNullOrWhiteSpace($FileToSign)) {
    Write-Error "sign.ps1: no file path supplied. Tauri passes the artifact path as '%1' (first argument)."
    exit 1
}
if (-not (Test-Path -LiteralPath $FileToSign)) {
    Write-Error "sign.ps1: file to sign does not exist: $FileToSign"
    exit 1
}

# --- 2. Resolve the Trusted Signing dlib (fail closed if unset) --------------
$Dlib = $env:TRUSTED_SIGNING_DLIB
if ([string]::IsNullOrWhiteSpace($Dlib)) {
    Write-Error @"
sign.ps1: env var TRUSTED_SIGNING_DLIB is not set.
It must point to Azure.CodeSigning.Dlib.dll from the 'Microsoft.Trusted.Signing.Client' NuGet package,
e.g. C:\tools\trusted-signing\bin\x64\Azure.CodeSigning.Dlib.dll
Refusing to sign so the build fails loudly instead of shipping an unsigned artifact.
See supervisor/tauri/signing/README.md.
"@
    exit 1
}
if (-not (Test-Path -LiteralPath $Dlib)) {
    Write-Error "sign.ps1: TRUSTED_SIGNING_DLIB points at a missing file: $Dlib"
    exit 1
}

# --- 3. Resolve the metadata json (lives next to this script) ----------------
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Metadata  = Join-Path $ScriptDir 'trusted-signing-metadata.json'
if (-not (Test-Path -LiteralPath $Metadata)) {
    Write-Error "sign.ps1: metadata file missing: $Metadata"
    exit 1
}

# --- 4. Locate signtool from the Windows SDK ---------------------------------
# Lookup order:
#   1. $env:SIGNTOOL_PATH override (explicit, wins if set)
#   2. signtool already on PATH
#   3. Newest x64 signtool.exe under the installed Windows 10/11 SDK bin dirs
# windows-latest GitHub runners ship a Windows SDK, so #3 resolves without extra install.
function Resolve-SignTool {
    if ($env:SIGNTOOL_PATH -and (Test-Path -LiteralPath $env:SIGNTOOL_PATH)) {
        return $env:SIGNTOOL_PATH
    }
    $onPath = Get-Command signtool.exe -ErrorAction SilentlyContinue
    if ($onPath) { return $onPath.Source }

    $sdkRoots = @(
        "${env:ProgramFiles(x86)}\Windows Kits\10\bin",
        "${env:ProgramFiles}\Windows Kits\10\bin"
    ) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }

    $candidate = $sdkRoots |
        ForEach-Object { Get-ChildItem -Path $_ -Recurse -Filter signtool.exe -ErrorAction SilentlyContinue } |
        Where-Object { $_.FullName -match '\\x64\\signtool\.exe$' } |
        Sort-Object FullName -Descending |
        Select-Object -First 1
    if ($candidate) { return $candidate.FullName }
    return $null
}

$SignTool = Resolve-SignTool
if (-not $SignTool) {
    Write-Error @"
sign.ps1: could not find signtool.exe.
Install the Windows SDK (Signing Tools for Desktop Apps component) or set SIGNTOOL_PATH.
See supervisor/tauri/signing/README.md.
"@
    exit 1
}

# --- 5. Sign -----------------------------------------------------------------
Write-Host "sign.ps1: signtool = $SignTool"
Write-Host "sign.ps1: dlib     = $Dlib"
Write-Host "sign.ps1: metadata = $Metadata"
Write-Host "sign.ps1: artifact = $FileToSign"

& $SignTool sign `
    /v `
    /fd SHA256 `
    /tr http://timestamp.acs.microsoft.com `
    /td SHA256 `
    /dlib "$Dlib" `
    /dmdf "$Metadata" `
    "$FileToSign"

if ($LASTEXITCODE -ne 0) {
    Write-Error "sign.ps1: signtool failed with exit code $LASTEXITCODE for $FileToSign"
    exit $LASTEXITCODE
}

Write-Host "sign.ps1: signed OK -> $FileToSign"
exit 0
