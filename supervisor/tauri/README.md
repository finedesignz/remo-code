# Remo Code Supervisor — Tauri Tray App

Windows tray companion for Remo Code. Spawns the Bun-based supervisor sidecar,
runs an autostart entry, and ships a small settings UI.

- **Identifier:** `com.finedesignz.remo-code-supervisor`
- **Bundle target:** NSIS, per-user (`installMode: currentUser`) — since v0.13.0
- **Tauri:** 2.x

## Upgrading from v0.12.x or earlier (one-time manual step)

**Uninstall the old MSI before installing the v0.13.0+ `-setup.exe`.**

Through v0.12.x the supervisor shipped as a **per-machine MSI** (`Program Files`,
HKLM). From v0.13.0 it ships as a **per-user NSIS** installer (`%LOCALAPPDATA%`,
HKCU) so that silent auto-updates never raise a UAC prompt. An NSIS installer does
not — and cannot — uninstall an MSI: they are different installer technologies with
separate registries.

So on a host that still has the old MSI, installing the new `-setup.exe` leaves
**both** copies present, each with its own autostart entry. That is the doubled
tray / stale-sidecar failure class fixed in #327, reintroduced by hand. It cannot
happen silently (v0.12.1 defaults `auto_update: false`, so the old copy will not
update itself into this state), but a human clicking **Install** will hit it.

Uninstall the old one first:

```powershell
# Settings → Apps → "Remo Code Supervisor" → Uninstall, or:
Get-Package "Remo Code Supervisor" | Uninstall-Package
```

Then run the v0.13.0+ `Remo Code Supervisor_<version>_x64-setup.exe`. Fresh installs
and v0.13.0 → v0.13.x auto-updates need none of this.

## Local build

```powershell
pwsh -File supervisor/tauri/scripts/build-and-update.ps1            # build if changed
pwsh -File supervisor/tauri/scripts/build-and-update.ps1 -Install   # build + run the NSIS setup silently (/S)
pwsh -File supervisor/tauri/scripts/build-and-update.ps1 -Watch     # poll git every 5 min, build on change
pwsh -File supervisor/tauri/scripts/build-and-update.ps1 -Force     # rebuild even if stamp says clean
```

The script tracks the last successful build in `.last-built-sha` and only
rebuilds when something under `supervisor/tauri/` (or the workspace
`package.json` / lockfile) changed since that SHA.

## Auto-updater

Installed copies of the app check
`https://github.com/finedesignz/remo-code/releases/latest/download/latest.json`
on startup (after a short delay) and again whenever the settings window
regains focus. When an update is available the user sees a non-blocking toast
in the settings window — clicking **Install** downloads the signed NSIS setup,
applies it, and relaunches the app.

`auto_update` defaults to **on** as of v0.13.0. That default is only safe because
the installer is per-user: it writes to `%LOCALAPPDATA%` + HKCU, so an unattended
`downloadAndInstall()` cannot trigger a UAC consent dialog with nobody at the
keyboard (the v0.8.3 hang). The two settings are coupled — if the bundle ever
returns to a per-machine installer, `auto_update` must default back to `false` in
the same commit. `supervisor/test/nsis-peruser-autoupdate-guard.test.ts` enforces
this.

Updates are Ed25519-signed. The public key is baked into
`src-tauri/tauri.conf.json`; the private key lives only in GitHub Actions
secrets. See [UPDATER-SETUP.md](./UPDATER-SETUP.md) for first-time keygen and
rotation instructions.

## Cutting a release

```bash
# bump version in src-tauri/tauri.conf.json AND src-tauri/Cargo.toml AND ui/package.json,
# commit, then:
git tag supervisor-v0.3.1
git push origin supervisor-v0.3.1
```

The `release-supervisor` GitHub Actions workflow takes over — builds the UI,
builds the MSI with `tauri-apps/tauri-action`, signs it, and publishes a
GitHub Release containing the MSI, its `.sig`, and the `latest.json` manifest.

## Rolling the signing key

See [UPDATER-SETUP.md § 5](./UPDATER-SETUP.md#5-rotating-the-key). Heads-up:
key rotation forces every installed copy to be reinstalled manually once —
plan and announce accordingly.
