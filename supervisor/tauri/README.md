# Remo Code Supervisor — Tauri Tray App

Windows tray companion for Remo Code. Spawns the Bun-based supervisor sidecar,
runs an autostart entry, and ships a small settings UI.

- **Identifier:** `com.finedesignz.remo-code-supervisor`
- **Bundle target:** MSI (Windows)
- **Tauri:** 2.x

## Local build

```powershell
pwsh -File supervisor/tauri/scripts/build-and-update.ps1            # build if changed
pwsh -File supervisor/tauri/scripts/build-and-update.ps1 -Install   # build + run msiexec /passive
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
in the settings window — clicking **Install** downloads the signed MSI,
applies it, and relaunches the app.

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
