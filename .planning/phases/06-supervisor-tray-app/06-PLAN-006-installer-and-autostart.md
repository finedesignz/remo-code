---
plan_id: 06-PLAN-006-installer-and-autostart
wave: 3
depends_on: [06-PLAN-001-tauri-scaffold, 06-PLAN-002-sidecar-and-process-control]
files_modified:
  - supervisor/tauri/src-tauri/tauri.conf.json
  - supervisor/tauri/src-tauri/build.rs
  - supervisor/tauri/src-tauri/installer/wix/main.wxs.tera
  - supervisor/tauri/src-tauri/installer/wix/fragments/uninstall.wxs
  - supervisor/tauri/src-tauri/src/main.rs
  - supervisor/tauri/src-tauri/src/updater.rs
  - .github/workflows/release-supervisor.yml
  - README.md
autonomous: true
requirements: [R-06-05, R-06-06, R-06-10, R-06-12]
---

# Plan 06-006 — MSI installer, autostart, updater, NSSM coexistence

<tasks>

<task id="T1">
<action>Configure the Tauri MSI bundler in `tauri.conf.json`. Set `bundle.windows.wix.language = ["en-US"]`, `bundle.windows.allowDowngrades = false`, `bundle.windows.shortcuts = [{ name: "Remo Supervisor", target: "[INSTALLDIR]\\Remo Supervisor.exe", description: "Remote-control supervisor for Claude Code sessions" }]` (Start Menu shortcut; no desktop shortcut by default — keep it minimal). `bundle.publisher = "Fine Design Z"`. `bundle.copyright = "2026 Fine Design Z"`. `bundle.shortDescription = "Remote-control supervisor for Claude Code"`. `bundle.longDescription = "Securely run and remote-control Claude Code sessions from any browser via app.remo-code.com."`. `bundle.icon = ["icons/icon.ico"]`.</action>
<read_first>
- supervisor/tauri/src-tauri/tauri.conf.json (after PLAN-001)
- https://v2.tauri.app/distribute/windows-installer/ (latest WiX reference)
</read_first>
<acceptance_criteria>
- `npx tauri build` produces `supervisor/tauri/src-tauri/target/release/bundle/msi/Remo Supervisor_0.3.0_x64_en-US.msi`
- Running the MSI installs the app to `%LOCALAPPDATA%\Programs\Remo Supervisor\` (or wherever Tauri's default puts it per the chosen `installMode`)
- A Start Menu shortcut named "Remo Supervisor" is created
- No desktop shortcut is created (verified post-install)
</acceptance_criteria>
</task>

<task id="T2">
<action>Ship the Bun sidecar binary inside the MSI. In `tauri.conf.json`, add `bundle.externalBin = ["binaries/remo-code-supervisor"]`. Build script (extend `build.rs`): before the `tauri_build::build()` call, run `bun build --compile --target=bun-windows-x64 supervisor/src/index.ts --outfile supervisor/tauri/src-tauri/binaries/remo-code-supervisor-x86_64-pc-windows-msvc.exe`. Document the exact Bun version used in `README.md` so future builds reproduce.</action>
<read_first>
- https://v2.tauri.app/develop/sidecar/#shipping-with-the-application
- https://bun.sh/docs/bundler/executables (--compile flag)
</read_first>
<acceptance_criteria>
- `npx tauri build` produces an MSI that, when installed, has `remo-code-supervisor-x86_64-pc-windows-msvc.exe` inside the install dir
- Launching the tray app spawns this exact binary as the sidecar (verified by Process Explorer showing the path)
- The bundled `.exe` is independent — does NOT require Bun to be installed on the user's machine
</acceptance_criteria>
</task>

<task id="T3">
<action>Enable Tauri autostart on first install. In `main.rs`'s `setup` closure, on first run (detect via `cfg.autostart === true` AND `is_enabled() === false` on the autostart plugin), call `app.autolaunch().enable()`. On subsequent runs, sync the autostart plugin state with `cfg.autostart` (toggle the OS entry to match). On uninstall, the MSI's uninstall script removes the Run-key entry — task T5 below.

Add a Settings UI control wired to this state. (UI side already exists in PLAN-003's `SettingsPage` — add a row to the Connection card or a separate "Startup" card showing the toggle. Wire to `save_config({ ..., autostart: !current })` then the `main.rs` sync logic kicks in on the next reload.)</action>
<read_first>
- https://v2.tauri.app/plugin/autostart/ (autolaunch API)
- supervisor/tauri/ui/src/components/SettingsPage.tsx (existing rows)
</read_first>
<acceptance_criteria>
- After install, `HKCU\Software\Microsoft\Windows\CurrentVersion\Run\com.finedesign.remo-supervisor` exists and points at the installed `.exe`
- Toggling autostart OFF in the UI removes the Run-key within 2s
- Toggling back ON re-adds it
- Logging out and back in launches the tray app with NO console window
</acceptance_criteria>
</task>

<task id="T4">
<action>Configure the Tauri Updater. `supervisor/tauri/src-tauri/src/updater.rs` exports a `check_for_updates(app: AppHandle) -> Result<Option<UpdateInfo>, ...>`. Wired into the Settings UI's "Check for updates" button (PLAN-003 T2 card 7). The updater endpoint is `https://github.com/finedesignz/remo-code/releases/latest/download/supervisor-tauri-update.json`. **v1 ships UNSIGNED** — the `pubkey` field in `tauri.conf.json` is the placeholder from PLAN-001; document in `README.md` that SmartScreen will warn on install and that EV cert procurement is deferred (see CONTEXT.md `<deferred>`).

Create `.github/workflows/release-supervisor.yml`. Trigger: tags matching `supervisor-v*`. Steps: checkout, set up Rust + Bun, build the Bun sidecar exe, run `npx tauri build`, upload the MSI as a release asset, generate the `supervisor-tauri-update.json` manifest (Tauri's `tauri signer` would normally sign — for v1, generate an unsigned manifest with the version + URL + a known-empty signature). Document the manual release process in `README.md`.</action>
<read_first>
- https://v2.tauri.app/plugin/updater/ (manifest format)
- .github/workflows/ (if any existing workflow patterns — copy auth + cache style)
</read_first>
<acceptance_criteria>
- The GH Actions workflow builds an MSI and produces a `supervisor-tauri-update.json` artifact on every `supervisor-v*` tag
- `check_for_updates` returns `Some(UpdateInfo)` when a newer version is on the manifest
- Clicking "Check for updates" in the UI surfaces the result (newer-available / up-to-date / error)
- README documents the SmartScreen warning + the manual `git tag supervisor-v0.3.0 && git push --tags` release flow
</acceptance_criteria>
</task>

<task id="T5">
<action>Customize the WiX uninstall fragment (`supervisor/tauri/src-tauri/installer/wix/fragments/uninstall.wxs`). On uninstall:
1. Remove the autostart Run-key entry (`<Registry Root="HKCU" Key="Software\Microsoft\Windows\CurrentVersion\Run" Name="com.finedesign.remo-supervisor" />` with `RemoveKeyOnUninstall`)
2. Prompt the user (custom dialog) before deleting `%APPDATA%\remo-code\supervisor.json` and `%LOCALAPPDATA%\remo-code-supervisor\audit.jsonl`. Default = KEEP. Use a WiX `<UI>` with a custom message dialog.
3. Always remove app binaries and the Start Menu shortcut.

If WiX is too heavy for the per-file prompt in v1, accept a simpler default: ALWAYS preserve config + audit log (the only path) and document this in the uninstaller dialog. The user can manually delete `%APPDATA%\remo-code\` if they want a clean wipe.</action>
<read_first>
- https://v2.tauri.app/distribute/windows-installer/#customize-the-wix-installer
- supervisor/src/config.ts (CONFIG_PATH — for the registry path constants)
</read_first>
<acceptance_criteria>
- Uninstalling the MSI removes the Run-key entry
- Config file at `%APPDATA%\remo-code\supervisor.json` is preserved by default
- Audit JSONL is preserved by default
- Start Menu shortcut is removed
- Reinstalling on top of a previous install preserves the config (verified end-to-end)
</acceptance_criteria>
</task>

<task id="T6">
<action>Update `README.md`. Add a "Supervisor" section (or extend if one exists) with two clearly-separated subsections: **Desktop (tray app)** — points users to the GitHub release MSI + describes the SmartScreen warning + lists what the tray app does. **Headless / Servers (NSSM)** — points to `npx remo-code-supervisor install` + describes the existing CLI flow. Cross-link to `docs/supervisor-tray.md` (PLAN-007 creates it).</action>
<read_first>
- README.md (whole file)
</read_first>
<acceptance_criteria>
- README explains both distribution channels (tray app + npm/NSSM)
- SmartScreen warning is acknowledged in the tray-app section
- Cross-link to `docs/supervisor-tray.md` exists (the doc lands in PLAN-007)
</acceptance_criteria>
</task>

</tasks>

must_haves:
- MSI installer builds successfully and installs without errors
- Bun sidecar exe is bundled inside the MSI — user does NOT need Bun installed
- Autostart Run-key registered on install, removed on uninstall, toggleable from Settings (R-06-06)
- Updater manifest is published on GitHub Releases via Actions; v1 ships unsigned (R-06-10)
- Uninstall preserves config + audit log by default, removes binaries + Run-key (R-06-12)
- README documents both distribution channels (R-06-05)
