---
phase_id: 06-supervisor-tray-app
phase_number: 06
status: pending
owner: jsmithfd@gmail.com
created: 2026-05-25
requirements: [R-06-01, R-06-02, R-06-03, R-06-04, R-06-05, R-06-06, R-06-07, R-06-08, R-06-09, R-06-10, R-06-11, R-06-12]
depends_on: [Phase 02]
---

# Phase 06 — Supervisor Tray App

<domain>
Convert the existing `supervisor/` package (currently a CLI Bun process whose only Windows install path is NSSM with a logged-on console window) into a polished, GUI-first Windows tray app. The user-visible artifact is a tiny tray icon in the notification area + a small native-feeling Settings window — no terminal, ever. The Settings UI surfaces all the security/sandbox controls the supervisor protocol already implies but currently exposes only through hand-edited JSON: allowed folders, `--dangerously-skip-permissions` hard cap, max concurrent sessions, audit log toggle, restrict-to-git toggle, kill-switch hotkey. The Bun supervisor runtime stays — it is wrapped, not rewritten. The legacy `nssm-installer.ts` install path remains supported for headless server installs (see Phase 04 coolify-dev-supervisor). The WS protocol (`hub/src/ws/supervisor-protocol.ts`) is touched only additively (new capability flags on `supervisor.hello`).
</domain>

<decisions>

**Stack (locked, architect-confirmed):**
- **Tauri 2** (Rust shell + WebView2 + React/Tailwind UI). Picked over Electron (binary size, no Node runtime in shell, better Windows tray integration), pkg/exe-of-Bun (no tray API, no WebView), and a pure WinForms/WPF shell (would force throwing away the existing React/Tailwind design system).
- **Bun supervisor runs as Tauri sidecar** spawned with `CREATE_NO_WINDOW` (Win32 `0x08000000` flag) — guarantees no console window. Tauri's `tauri::api::process::Command` is used with `creation_flags(0x08000000)` on Windows.
- **Settings UI = React 19 + Tailwind 4 + Vite**, matching the existing `web/` aesthetic (`web/src/components/SettingsPage.tsx` is the canonical visual reference). Tauri serves it via the `tauri://localhost` custom scheme — NOT a localhost HTTP port — so the Windows firewall never prompts.
- **Single-instance enforcement is DOUBLE-LAYERED:** `tauri-plugin-single-instance` for the shell (named mutex), AND the Bun sidecar binds `127.0.0.1:9106` at startup. If either lock fails the new instance exits immediately. The tray app additionally refuses to start a sidecar if `Get-Service RemoCodeSupervisor` reports the NSSM service as `Running`.
- **Autostart** via `tauri-plugin-autostart` (HKCU Run key). ON by default after first install. Toggleable from Settings.
- **Updater** via `tauri-plugin-updater` consuming a signed manifest hosted alongside GitHub Releases. v1 ships unsigned `.msi` — SmartScreen prompt is acknowledged as a known v1 wart. EV code-signing cert procurement is deferred.
- **Global hotkey** via `tauri-plugin-global-shortcut`. Binding `Ctrl+Shift+Alt+K` is the kill-switch — terminates ALL child processes immediately (calls into `ProcessManager.stopAll('kill_switch')`).

**Layout & file ownership:**
- New directory `supervisor/tauri/` holds the Rust shell + UI. Tree:
  ```
  supervisor/tauri/
    src-tauri/           # Rust crate (Cargo.toml, src/main.rs, src/sidecar.rs, src/ipc.rs, src/tray.rs, tauri.conf.json)
    ui/                  # React + Vite settings UI
      package.json
      vite.config.ts
      src/
        App.tsx
        components/{SettingsPage,OnboardingFlow,SidecarStatusBadge,FolderList,...}.tsx
        lib/{ipc.ts}
  ```
- Existing `supervisor/src/` (the Bun runtime) **stays put** — same files, same `package.json`, same `bin: remo-code-supervisor`. The Tauri shell spawns it via sidecar; the npm CLI install path (NSSM) keeps working.
- Existing `nssm-installer.ts` is untouched. NSSM remains the path for headless server installs (coolify-dev-supervisor, Phase 04).

**Config persistence:**
- ONE source of truth: the existing JSON at `%APPDATA%\remo-code\supervisor.json` per `supervisor/src/config.ts:21-22`. The Tauri UI reads/writes the SAME file. No second config file. Extend the schema additively:
  ```
  allow_dangerous_skip_permissions: boolean   // NEW — default FALSE; HARD CAP, not "default"
  restrict_to_git: boolean                    // NEW — default TRUE
  audit_log_enabled: boolean                  // NEW — default TRUE
  audit_log_path: string                      // NEW — defaults to %LOCALAPPDATA%\remo-code-supervisor\audit.jsonl
  autostart: boolean                          // NEW — default TRUE (mirrored to Tauri autostart plugin)
  ```
- File-watch: the Bun supervisor uses `fs.watch` (or polling fallback) on `supervisor.json` and reloads its in-memory config within 2 seconds of a write. Validation errors are sent back over IPC to the Tauri UI.

**Security model (locked, architect-corrected):**
- **`--dangerously-skip-permissions` is a HARD CAP, not a default.** When `allow_dangerous_skip_permissions: false` in supervisor config (the default), `process-manager.ts` STRIPS the flag from any `run.start` payload regardless of what the hub requests. The web UI's per-session toggle becomes a no-op when the cap is off. Trust direction: the local machine is the security boundary, not the hub. The cap state is surfaced to the hub via `supervisor.hello.capabilities` so the web UI can grey-out the per-session toggle.
- **Sandbox-escape gate (NEW critical fix):** `process-manager.ts` does NOT currently validate `spec.repoPath` against `cfg.roots` before spawning — that is the real sandbox vulnerability and it is fixed in Phase 06 regardless of whether the UI exposes the toggle. The gate uses `fs.realpathSync(spec.repoPath)` then `startsWith(realpath(root))` for every root. Reject with `{ error: 'sandbox_escape', repo_path, allowed_roots }` structured error.
- **Git-only gate:** if `restrict_to_git: true`, refuse `run.start` unless `<repoPath>/.git` exists.
- **Max-concurrent enforcement (NEW):** `config.maxConcurrent` is in `supervisor/src/config.ts:9` but currently NOT enforced in `process-manager.ts`. Wire it up in PLAN-005 — when `runs.size >= maxConcurrent`, reject with `{ error: 'concurrency_cap', limit }`.
- **Audit log:** append-only JSONL at `%LOCALAPPDATA%\remo-code-supervisor\audit.jsonl`. One line per `run.start` with `{ ts, run_id, repo_path, branch, prompt_hash, flags, allowed: bool, reason?: string }`. Prompt is hashed (SHA-256), never stored raw.
- **User-profile / Desktop advisory:** adding `C:\Users\<me>` or `C:\Users\<me>\Desktop` as a root triggers an advisory warning dialog in the UI ("This grants Claude write access to all your personal files. Continue?"). Not a hard block; the user can override.

**Sidecar lifecycle:**
- Spawn on Tauri shell launch (after config is loaded + sidecar bind-port check passes).
- Status events: `starting | running | stopped | crashed` → tray icon color: indigo (running), gray (stopped/idle), amber (starting), red (crashed). Crash → right-click menu shows **Restart supervisor**.
- Auto-restart on crash with exponential backoff (1s/2s/4s/8s/16s/30s — match existing `BACKOFF_SCHEDULE` in `process-manager.ts:19`). Circuit-break after 5 crashes in 10 min.
- **Daily 4am heartbeat-restart** of the sidecar (Tauri schedules via `tauri::async_runtime::spawn` with an interval) — belt-and-suspenders against long-running Bun memory growth.
- **WS listener leak fix:** `supervisor/src/hub-client.ts:21-80` currently reassigns `this.ws = new WebSocket(...)` without `removeEventListener` on the old socket. Phase 06 adds explicit listener cleanup before reassigning.
- **Stderr buffer bound:** `process-manager.ts`'s `stderrTail` array already does `slice(-200)` in `consumeStderr` but the policy is reaffirmed and codified — never more than 200 lines retained per run.

**IPC bridge (Tauri ↔ Bun sidecar ↔ UI):**
- Tauri Commands (Rust → React, invoked from UI): `get_config`, `save_config`, `get_status`, `start_supervisor`, `stop_supervisor`, `restart_supervisor`, `pick_folder`, `open_audit_log`, `open_config_file`, `check_nssm_service`, `migrate_from_nssm`.
- Tauri Events (Rust → React, pushed): `supervisor:status`, `supervisor:log`, `supervisor:crash`, `config:validation_error`, `kill_switch:activated`.
- The Bun sidecar communicates with the Rust shell over its stdout (JSONL) — same pattern the existing Bun supervisor uses for hub-bound logs. The Rust shell parses and re-emits as Tauri events to the UI.
- No new TCP/IPC mechanism between Rust and Bun — stdio is sufficient.

**Installer / distribution:**
- TWO distribution channels:
  1. **`Remo Supervisor Setup.exe`** — Tauri MSI bundle, GUI/desktop default. Ships the Bun sidecar binary inside the bundle.
  2. **`npx remo-code-supervisor install`** — existing NSSM path, unchanged. Headless server default.
- First-launch detection: if `Get-Service RemoCodeSupervisor` reports `Running`, the tray app offers a one-click "Switch to tray mode" that calls `npx remo-code-supervisor uninstall`, enables Tauri autostart, imports `supervisor.json` (same path), and starts the sidecar. Users who do nothing keep NSSM.
- README documents both channels and when to pick which.

**Styling (locked):**
- Match `web/src/components/SettingsPage.tsx`. CSS custom properties (`--bg-primary`, `--text-primary`, etc.) from `web/src/index.css` are duplicated into `supervisor/tauri/ui/src/index.css` so the Tauri UI looks identical (same theme tokens, same dark mode). NOT shared via build-time symlink — the two apps are separately bundled; we accept the small duplication.
- Cards: `bg-[var(--bg-secondary)]/60`, `rounded-xl`, `p-5`. No heavy borders. Indigo accent (`bg-indigo-600 hover:bg-indigo-500`). Per global frontend conventions in `~/.claude/CLAUDE.md`.

</decisions>

<canonical_refs>
- `CLAUDE.md` (project)
- `~/.claude/CLAUDE.md` (user global — frontend/CSS conventions, port map, Coolify, secrets)
- `supervisor/src/index.ts` (the existing CLI entry — preserved verbatim; tray app wraps it as sidecar)
- `supervisor/src/config.ts` (config path `%APPDATA%\remo-code\supervisor.json`, schema, `loadConfig` / `saveConfig`)
- `supervisor/src/nssm-installer.ts` (legacy install path — coexistence target)
- `supervisor/src/process-manager.ts` (where the sandbox-escape gate, concurrency cap, and `--dangerously-skip-permissions` hard cap land)
- `supervisor/src/hub-client.ts` (WS listener leak fix lands here)
- `supervisor/src/repo-scanner.ts` (existing `.git` detection — reused for the git-only gate)
- `supervisor/src/commands-scanner.ts` (existing — no changes)
- `hub/src/ws/supervisor-protocol.ts` (additive change only: new optional capability flags on `supervisor.hello`)
- `web/src/components/SettingsPage.tsx` (visual baseline)
- `web/src/index.css` (CSS custom properties — copy into supervisor/tauri/ui)
- `README.md` (project)
- `docs/scheduled-tasks.md` (queue & dispatcher model — unchanged but referenced)
- `.planning/codebase/ARCHITECTURE.md`, `STACK.md`, `CONVENTIONS.md`
- Port map in `~/.claude/CLAUDE.md` — 9106 is `onetimeseo.com`. **CONFLICT — the architect's `127.0.0.1:9106` bind is for an in-process loopback mutex only, not an external listener. Reuse is acceptable because the supervisor sidecar's bind is `127.0.0.1`-only and is opportunistic (bind succeeds only if `onetimeseo.com` isn't running locally on the same machine). PLAN-002 must verify and switch to `127.0.0.1:9197` if the conflict is real on the user's box.**
</canonical_refs>

<specifics>

**New files (created):**
- `supervisor/tauri/src-tauri/Cargo.toml`
- `supervisor/tauri/src-tauri/tauri.conf.json`
- `supervisor/tauri/src-tauri/build.rs`
- `supervisor/tauri/src-tauri/src/main.rs` — `tauri::Builder` wiring, plugin registration
- `supervisor/tauri/src-tauri/src/sidecar.rs` — sidecar spawn + lifecycle (CREATE_NO_WINDOW, stdout JSONL parse, restart-on-crash, daily 4am restart)
- `supervisor/tauri/src-tauri/src/ipc.rs` — Tauri commands (get_config, save_config, etc.)
- `supervisor/tauri/src-tauri/src/tray.rs` — tray icon, menu, state mapping
- `supervisor/tauri/src-tauri/src/nssm.rs` — Get-Service / migrate-from-nssm
- `supervisor/tauri/src-tauri/src/audit.rs` — JSONL writer (kept simple; Bun owns most audit writes — Rust only writes shell-level events)
- `supervisor/tauri/src-tauri/icons/*.png` (tray icon set, multiple states: idle / running / crashed)
- `supervisor/tauri/ui/package.json`
- `supervisor/tauri/ui/vite.config.ts`
- `supervisor/tauri/ui/index.html`
- `supervisor/tauri/ui/tailwind.config.ts`
- `supervisor/tauri/ui/postcss.config.js`
- `supervisor/tauri/ui/src/main.tsx`
- `supervisor/tauri/ui/src/App.tsx`
- `supervisor/tauri/ui/src/index.css` (CSS custom properties copied from `web/src/index.css`)
- `supervisor/tauri/ui/src/components/SettingsPage.tsx`
- `supervisor/tauri/ui/src/components/OnboardingFlow.tsx`
- `supervisor/tauri/ui/src/components/FolderList.tsx`
- `supervisor/tauri/ui/src/components/SidecarStatusBadge.tsx`
- `supervisor/tauri/ui/src/components/NssmMigrateCard.tsx`
- `supervisor/tauri/ui/src/lib/ipc.ts` (wrap `@tauri-apps/api` `invoke` / `listen`)
- `docs/supervisor-tray.md`

**Existing files modified (touched):**
- `supervisor/src/config.ts` — extend schema with new fields (`allow_dangerous_skip_permissions`, `restrict_to_git`, `audit_log_enabled`, `audit_log_path`, `autostart`), keep backward-compat (default values when absent), add a public `watchConfig(cb)` helper
- `supervisor/src/process-manager.ts` — sandbox-escape gate, git-only gate, max-concurrent enforcement, `--dangerously-skip-permissions` hard-strip, audit log writer
- `supervisor/src/hub-client.ts` — WS listener cleanup before reassigning `this.ws`; advertise capability flags via `supervisor.hello`
- `supervisor/src/index.ts` — keep all existing commands; add `run --sidecar` flag that signals "this process is being run as a Tauri sidecar" (changes log behavior to stdout-JSONL only, no file rotation since Tauri handles surfacing)
- `supervisor/package.json` — bump version to 0.3.0
- `hub/src/ws/supervisor-protocol.ts` — extend `SupervisorHello` schema with optional capability fields: `allow_dangerous_skip_permissions?: boolean`, `restrict_to_git?: boolean`, `max_concurrent?: number`, `audit_log_enabled?: boolean`. ADDITIVE only — old supervisors that don't send these fields still validate.
- `README.md` — add "Tray app vs NSSM service" section + screenshot placeholder
- `CLAUDE.md` (project) — document the new entrypoint, the security toggles, the IPC model, the two distribution channels

**Distribution artifacts:**
- `Remo Supervisor Setup.exe` (Tauri MSI, signed manifest published to GitHub Releases)
- `remo-code-supervisor` on npm (unchanged, NSSM path)

**Env vars (NONE added.)** All configuration lives in `supervisor.json`. The supervisor's own env vars (`REMO_HUB_URL`, etc.) keep working as before for the NSSM path.

</specifics>

<deferred>
The following are explicitly out of scope for Phase 06 and will be queued as separate phase candidates:
- macOS / Linux tray builds (Windows-only for Phase 06)
- In-app log viewer (the Settings UI provides an "Open folder" button that launches Explorer on `%LOCALAPPDATA%\remo-code-supervisor\`)
- Per-repo permission profiles (allow `--dangerously-skip-permissions` for repo A only, etc.)
- Code-signing certificate procurement for tauri updater (EV cert — v1 ships unsigned, accepts SmartScreen prompt)
- Supabase JWT-based pairing flow (keep manual `olx_` API key paste for v1)
- Telemetry / usage analytics
- Auto-import of WSL `~/.config/remo-code` config on first launch
- Replacing the legacy v0 scheduler interaction (supervisor surface to the scheduler is unchanged)
- GUI for repo-scanner output / a "browse my repos" panel (the supervisor's `scanAll` output remains hub-facing only)
- Per-session resource limits (CPU/RAM quotas) — Phase 04 (coolify-dev-supervisor) covers host-level budget; per-session limits is a separate later phase
- A "view session activity" surface inside the tray app — that lives in the web UI
- Removal of the legacy v0 scheduler (`hub/src/scheduler/index.ts`) — tracked separately
</deferred>

<scope_fence>
**In scope:**
- The 12 requirements R-06-01..R-06-12.
- The 7 plans listed in Phase 06 of `ROADMAP.md`.
- New Rust crate under `supervisor/tauri/src-tauri/`. New React/Vite app under `supervisor/tauri/ui/`. New doc `docs/supervisor-tray.md`.
- Modifications to `supervisor/src/{config,process-manager,hub-client,index}.ts`, `supervisor/package.json`, `README.md`, `CLAUDE.md`, and `hub/src/ws/supervisor-protocol.ts` (additive only).
- Tauri plugin deps: `tauri-plugin-single-instance`, `tauri-plugin-autostart`, `tauri-plugin-updater`, `tauri-plugin-global-shortcut`. UI deps: React 19, Tailwind 4, Vite 6, `@tauri-apps/api`.

**Out of scope (will reject during execution):**
- ANY change to `hub/src/scheduler/*`, `agent/`, `channel/`, or any web/ component outside `web/src/components/SettingsPage.tsx` (read-only reference, not modified).
- Changing the WS supervisor protocol non-additively. New optional fields only; never remove or rename existing fields.
- Adding a new TCP/IPC port between Tauri shell and Bun sidecar (stdio JSONL is sufficient).
- Replacing the NSSM install path. It MUST keep working unchanged.
- Adding any non-Tauri shell (no Electron, no Neutralino, no Wails, no WPF).
- Adding telemetry, crash reporting (Sentry, etc.), or any third-party network call.

**Claude's discretion (explicit license, no need to ask):**
- Exact tray icon artwork (color, glyph) — design within the indigo / gray / amber / red state palette.
- Exact onboarding flow copy and step layout.
- Exact MSI installer copy / branding.
- Whether the kill-switch hotkey is user-configurable in v1 or read-only (v1 default: read-only, displayed in Settings).
- Whether the audit log includes the prompt hash or the full prompt — locked default is HASH (SHA-256), but Claude may add a Settings toggle if it doesn't bloat scope.
- The exact `127.0.0.1:<port>` chosen for the sidecar bind mutex (default 9106; switch if conflict with `onetimeseo.com`).
- Whether the daily heartbeat-restart is at 4am local time or 4am UTC — locked default is local time.
</scope_fence>
