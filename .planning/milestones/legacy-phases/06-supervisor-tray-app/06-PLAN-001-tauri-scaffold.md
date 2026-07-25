---
plan_id: 06-PLAN-001-tauri-scaffold
wave: 1
depends_on: []
files_modified:
  - supervisor/tauri/src-tauri/Cargo.toml
  - supervisor/tauri/src-tauri/tauri.conf.json
  - supervisor/tauri/src-tauri/build.rs
  - supervisor/tauri/src-tauri/src/main.rs
  - supervisor/tauri/src-tauri/src/tray.rs
  - supervisor/tauri/src-tauri/icons/icon.ico
  - supervisor/tauri/src-tauri/icons/idle.png
  - supervisor/tauri/src-tauri/icons/running.png
  - supervisor/tauri/src-tauri/icons/crashed.png
  - supervisor/tauri/ui/package.json
  - supervisor/tauri/ui/vite.config.ts
  - supervisor/tauri/ui/tsconfig.json
  - supervisor/tauri/ui/tailwind.config.ts
  - supervisor/tauri/ui/postcss.config.js
  - supervisor/tauri/ui/index.html
  - supervisor/tauri/ui/src/main.tsx
  - supervisor/tauri/ui/src/App.tsx
  - supervisor/tauri/ui/src/index.css
  - .gitignore
autonomous: true
requirements: [R-06-01, R-06-02, R-06-06, R-06-07, R-06-10]
---

# Plan 06-001 — Tauri scaffold + tray + plugin wiring

<tasks>

<task id="T1">
<action>Create the Rust crate skeleton at `supervisor/tauri/src-tauri/`. `Cargo.toml` declares package name `remo-supervisor-tauri`, `edition = "2021"`, `[lib]` for `tauri-build`, `[dependencies]` for `tauri` (v2), `tauri-plugin-single-instance` (v2), `tauri-plugin-autostart` (v2), `tauri-plugin-updater` (v2), `tauri-plugin-global-shortcut` (v2), `serde` + `serde_json`, `tokio` (with `time` feature), `windows` crate (only on `cfg(target_os = "windows")`) for `CREATE_NO_WINDOW` and `Get-Service` calls. `build.rs` calls `tauri_build::build()`. Pin Tauri to a single 2.x minor — pick latest stable per `cargo search tauri` at scaffold time and DOCUMENT the exact version in the PR body.</action>
<read_first>
- supervisor/package.json (for naming + repo URL conventions)
- .planning/codebase/STACK.md (existing dep style)
- https://v2.tauri.app/start/create-project/ (latest scaffold reference — fetch via ctx_fetch_and_index)
</read_first>
<acceptance_criteria>
- `cargo check --manifest-path supervisor/tauri/src-tauri/Cargo.toml` succeeds on a Windows dev box
- All four `tauri-plugin-*` deps resolve from crates.io with the chosen 2.x minor
- `build.rs` exists and is one line: `fn main() { tauri_build::build() }`
</acceptance_criteria>
</task>

<task id="T2">
<action>Write `supervisor/tauri/src-tauri/tauri.conf.json`. Locked fields: `productName: "Remo Supervisor"`, `version: "0.3.0"`, `identifier: "com.finedesign.remo-supervisor"`, `app.windows: [{ label: "settings", title: "Remo Supervisor", width: 720, height: 560, resizable: true, visible: false, decorations: true, transparent: false }]` (hidden on launch — tray is the entry surface), `app.security.csp: "default-src 'self'; style-src 'self' 'unsafe-inline'"`, `bundle.active: true`, `bundle.targets: ["msi"]`, `bundle.windows.wix.template: null` (use Tauri's default), `bundle.windows.allowDowngrades: false`, `plugins.updater.endpoints: ["https://github.com/finedesignz/remo-code/releases/latest/download/supervisor-tauri-update.json"]`, `plugins.updater.pubkey` set to the placeholder `"REPLACE_WITH_TAURI_UPDATER_PUBKEY"` with a `TODO` comment in the PR body noting v1 ships unsigned.</action>
<read_first>
- https://v2.tauri.app/reference/config/ (latest schema)
- supervisor/package.json (version + repo URL)
</read_first>
<acceptance_criteria>
- `tauri.conf.json` validates against the Tauri v2 schema (`tauri info` doesn't error out)
- Main settings window is `visible: false` on boot — only shown when user clicks the tray icon
- `bundle.targets` includes `msi`
- The `productName`, `identifier`, and `version` match the locked values above
</acceptance_criteria>
</task>

<task id="T3">
<action>Write `supervisor/tauri/src-tauri/src/main.rs`. Top of `fn main()`: invoke `tauri::Builder::default()` then chain in this exact order: `.plugin(tauri_plugin_single_instance::init(...))` with a handler that focuses the existing settings window (no-op if it's already focused), `.plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, Some(vec![])))`, `.plugin(tauri_plugin_updater::Builder::new().build())`, `.plugin(tauri_plugin_global_shortcut::Builder::new().with_handler(<kill switch handler>).build())`. The kill-switch handler stub logs `kill_switch:activated` and emits a Tauri event (no actual stop logic yet — that lands in PLAN-002 once the sidecar is wired). Register `Ctrl+Shift+Alt+K` as the only shortcut. The `setup` closure builds the tray (delegated to `tray::build`) and registers the shortcut. `.invoke_handler(tauri::generate_handler![])` is empty for now — commands land in PLAN-004.</action>
<read_first>
- https://v2.tauri.app/plugin/single-instance/ (handler signature)
- https://v2.tauri.app/plugin/autostart/ (init signature)
- https://v2.tauri.app/plugin/global-shortcut/ (Builder API)
- https://v2.tauri.app/plugin/updater/ (Builder API)
</read_first>
<acceptance_criteria>
- `cargo build --release --manifest-path supervisor/tauri/src-tauri/Cargo.toml` succeeds
- Launching the built `.exe` shows NO console window (verified by inspecting the bundle subsystem — must be `windows` not `console`)
- Second launch of the same binary focuses the first instance (verified by Process Explorer showing only one PID)
- Pressing `Ctrl+Shift+Alt+K` logs `kill_switch:activated` to the Tauri log
</acceptance_criteria>
</task>

<task id="T4">
<action>Write `supervisor/tauri/src-tauri/src/tray.rs`. Function `build(app: &AppHandle) -> Result<(), tauri::Error>`. Build a `TrayIconBuilder` with: icon = `icons/idle.png` (default state), tooltip = "Remo Supervisor (idle)", menu containing the items in this exact order: **Open Settings**, **Start**, **Stop**, **Restart supervisor**, separator, **Status: idle** (disabled — purely informational, updated by event listener in PLAN-002), separator, **Quit**. Left-click on the icon shows the settings window. Right-click shows the menu. Menu item handlers stub to logging only — PLAN-002 wires Start/Stop/Restart to the sidecar; PLAN-004 wires Open Settings to `window.show() + window.set_focus()`.</action>
<read_first>
- https://v2.tauri.app/learn/system-tray/ (TrayIconBuilder API)
</read_first>
<acceptance_criteria>
- Tray icon appears in the Windows notification area after launching the built `.exe`
- Right-click shows a menu with all 7 entries (5 actionable + 1 status + 1 quit) in the exact order above
- Left-click shows the (otherwise-hidden) settings window
- **Quit** menu item exits the process cleanly (no hang, no orphaned subprocesses — sidecar isn't spawned yet so this is trivially true at this stage)
</acceptance_criteria>
</task>

<task id="T5">
<action>Create the React + Vite + Tailwind UI scaffold at `supervisor/tauri/ui/`. `package.json` declares `"type": "module"`, deps: `react ^19.0.0`, `react-dom ^19.0.0`, `@tauri-apps/api` (matching Tauri v2 minor), `tailwindcss ^4.0.0`, `@tailwindcss/vite ^4.2.2`, `vite ^6.2.0`, `typescript ^5.7`. Vite config: `plugins: [react(), tailwindcss()]`, `build.outDir: '../src-tauri/ui-dist'` (Tauri reads from there per `tauri.conf.json.build.frontendDist`), `server.port: 1420`, `server.strictPort: true`. `tsconfig.json` mirrors `web/tsconfig.json` (strict, ESM, jsx react-jsx). `index.html` is minimal: `<html><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>`. `src/main.tsx` mounts `<App />`. `src/App.tsx` renders a placeholder "Remo Supervisor — Settings (scaffold)" surface that matches the visual baseline of `web/src/components/SettingsPage.tsx`. `src/index.css` copies the CSS custom-property block from `web/src/index.css` verbatim (both `.light` and `.dark` blocks) — same theme tokens, same hover behavior.</action>
<read_first>
- web/package.json (matching versions)
- web/vite.config.ts (plugin order)
- web/tsconfig.json (strict settings)
- web/src/index.css (CSS custom properties to copy)
- web/src/components/SettingsPage.tsx (visual baseline)
- ~/.claude/CLAUDE.md (frontend conventions section)
</read_first>
<acceptance_criteria>
- `bun install` in `supervisor/tauri/ui/` succeeds
- `bunx vite build` produces a `supervisor/tauri/src-tauri/ui-dist/` directory with `index.html` + assets
- `npx tauri dev` (from `supervisor/tauri/`) launches the tray + opens the settings window with the placeholder UI; visual matches `SettingsPage.tsx` (same indigo accent, same card style, same density)
- No TS errors with `tsc --noEmit`
</acceptance_criteria>
</task>

<task id="T6">
<action>Add ignore entries to `.gitignore`. Append:
```
# Phase 06 — Tauri scaffold
supervisor/tauri/src-tauri/target/
supervisor/tauri/src-tauri/ui-dist/
supervisor/tauri/ui/node_modules/
supervisor/tauri/ui/dist/
```
Also create tray icon placeholders at `supervisor/tauri/src-tauri/icons/{icon.ico,idle.png,running.png,crashed.png}` — pick any reasonable simple glyph for v1 (a circle with a chat dot, indigo-tinted). 256×256 PNG + a multi-resolution `.ico`. These are placeholders; final art is at the executing agent's discretion (per `<scope_fence>` in CONTEXT.md).</action>
<read_first>
- .gitignore (current file — match style)
</read_first>
<acceptance_criteria>
- `git status` after running `cargo build` does not list `target/` or `ui-dist/`
- All four icon files exist and are valid PNG / ICO (verified by opening in an image viewer)
- The tray icon (T4) renders crisply at 16×16 (small Windows DPI) and 32×32 (high DPI)
</acceptance_criteria>
</task>

</tasks>

must_haves:
- Tauri 2 scaffold compiles, launches with NO console window, shows a tray icon, and opens a hidden settings window on left-click
- All four plugins (single-instance, autostart, updater, global-shortcut) are wired and the kill-switch logs an event
- React + Tailwind UI bundles into `ui-dist/` and is served via the `tauri://localhost` scheme — no localhost HTTP port, no firewall prompt
- `.gitignore` excludes Rust + Node build artifacts
- The exact Tauri 2.x minor used is documented in the PR body (so PLAN-006 installer config matches)
