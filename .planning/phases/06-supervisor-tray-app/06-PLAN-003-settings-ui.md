---
plan_id: 06-PLAN-003-settings-ui
wave: 2
depends_on: [06-PLAN-001-tauri-scaffold]
files_modified:
  - supervisor/tauri/ui/src/App.tsx
  - supervisor/tauri/ui/src/components/SettingsPage.tsx
  - supervisor/tauri/ui/src/components/OnboardingFlow.tsx
  - supervisor/tauri/ui/src/components/FolderList.tsx
  - supervisor/tauri/ui/src/components/SidecarStatusBadge.tsx
  - supervisor/tauri/ui/src/components/NssmMigrateCard.tsx
  - supervisor/tauri/ui/src/components/SecurityToggles.tsx
  - supervisor/tauri/ui/src/components/HotkeyDisplay.tsx
  - supervisor/tauri/ui/src/lib/ipc.ts
autonomous: true
requirements: [R-06-02, R-06-03, R-06-08, R-06-11]
---

# Plan 06-003 — Settings UI (React + Tailwind)

<tasks>

<task id="T1">
<action>Build the IPC wrapper at `supervisor/tauri/ui/src/lib/ipc.ts`. Re-export typed helpers around `@tauri-apps/api/core::invoke` and `@tauri-apps/api/event::listen`. Define a `SupervisorConfig` TypeScript interface that mirrors the extended Bun `SupervisorConfig` from `supervisor/src/config.ts` (after PLAN-004 extends it): `hub_url`, `api_key`, `roots: string[]`, `max_concurrent`, `allow_dangerous_skip_permissions`, `restrict_to_git`, `audit_log_enabled`, `audit_log_path`, `autostart`. Typed `invoke` calls: `getConfig()`, `saveConfig(cfg)`, `getStatus()`, `startSupervisor()`, `stopSupervisor()`, `restartSupervisor()`, `pickFolder()`, `openAuditLog()`, `openConfigFile()`, `checkNssmService()`, `migrateFromNssm()`. Typed events: `onStatusChange(cb)`, `onSidecarLog(cb)`, `onConfigValidationError(cb)`, `onKillSwitchActivated(cb)`. All Tauri command names match what PLAN-004 will register on the Rust side.</action>
<read_first>
- web/src/lib/auth.ts (style — typed thin wrapper around fetch)
- supervisor/src/config.ts (current `SupervisorConfig` interface — for the field names)
- https://v2.tauri.app/reference/javascript/api/namespacecore/ (invoke signature)
</read_first>
<acceptance_criteria>
- `tsc --noEmit` is green
- Every IPC function has an explicit return type
- All event subscribers return an `() => void` unsubscribe function
</acceptance_criteria>
</task>

<task id="T2">
<action>Build `supervisor/tauri/ui/src/components/SettingsPage.tsx`. Layout: a top-bar with the title "Remo Supervisor", a `<SidecarStatusBadge>` on the right (live state pill), and a vertical stack of cards below. Cards in order: (1) **Connection** — read-only display of `hub_url`, masked `api_key`, **Edit** button revealing inline inputs, (2) **Allowed folders** — uses `<FolderList>`, (3) **Security** — uses `<SecurityToggles>`, (4) **Kill switch** — uses `<HotkeyDisplay>` showing `Ctrl+Shift+Alt+K` as read-only + a "Stop all sessions" panic button that calls `stopSupervisor()`, (5) **Audit log** — toggle + an "Open log folder" link calling `openAuditLog()`, (6) **NSSM service** — only rendered if `checkNssmService()` returns `running: true`, uses `<NssmMigrateCard>`, (7) **About** — version, "Check for updates" button (no-op stub for v1, real wiring deferred to PLAN-006). Styling: cards `bg-[var(--bg-secondary)]/60 rounded-xl p-5`, indigo accent, no borders. Match `web/src/components/SettingsPage.tsx` density.</action>
<read_first>
- web/src/components/SettingsPage.tsx (visual baseline)
- ~/.claude/CLAUDE.md (frontend conventions section — card density, indigo, no heavy borders)
</read_first>
<acceptance_criteria>
- Opening the settings window (left-click tray) renders all 6 always-shown cards + the NSSM card when applicable
- Save in any card writes the merged config via `saveConfig(cfg)` then refetches via `getConfig()` to confirm
- Visual side-by-side comparison with `web/src/components/SettingsPage.tsx` shows the same card density, same indigo accent, same hover behavior
- The page does not exceed 720px wide at default zoom and does not require horizontal scroll
</acceptance_criteria>
</task>

<task id="T3">
<action>Build `supervisor/tauri/ui/src/components/FolderList.tsx`. Renders a list of `roots` with a per-row remove button (×). An **Add folder** button at the bottom calls `pickFolder()` (Tauri opens the native folder picker via `@tauri-apps/plugin-dialog`). After picking, validate locally: if the picked path is `C:\Users\<currentUser>` or `<homedir>\Desktop` or a parent of either, show an inline confirm dialog ("This grants Claude write access to all your personal files. Continue?"). On confirm, append. On cancel, do not append. Persist via `saveConfig({ ...current, roots: newRoots })`. Always normalize Windows path slashes: store as forward-slash form to match `repo-scanner.ts` output (`path.replace(/\\/g, '/')`).</action>
<read_first>
- supervisor/src/repo-scanner.ts (path normalization — forward slashes)
- https://v2.tauri.app/plugin/dialog/ (folder picker API)
</read_first>
<acceptance_criteria>
- Picking `C:\Users\artic` triggers the warning dialog; picking `C:\Users\artic\GitHub` does not
- Picking `C:\Users\artic\Desktop` triggers the warning dialog
- Removed folders are persisted immediately
- All paths in the saved config use forward slashes
</acceptance_criteria>
</task>

<task id="T4">
<action>Build `supervisor/tauri/ui/src/components/SecurityToggles.tsx`. Renders four toggle rows (`<label>` + custom switch in indigo style — match the toggle pattern used in `web/src/components/SettingsPage.tsx` if one exists; otherwise build a small indigo-accent switch component inline): (1) **Allow `--dangerously-skip-permissions`** — explanation text "OFF (recommended): supervisor strips this flag from any session launch, regardless of the hub's request. The local machine is the security boundary.", (2) **Restrict to git repositories** — explanation "When ON, supervisor refuses to launch sessions in directories without a `.git` folder.", (3) **Audit log enabled** — explanation "Append-only JSONL of every session launch. Stored at `%LOCALAPPDATA%\remo-code-supervisor\audit.jsonl`.", (4) **Max concurrent sessions** — this is a slider 1–8 with the current value shown. Defaults match CONTEXT.md: dangerous=FALSE, git=TRUE, audit=TRUE, max=1.</action>
<read_first>
- web/src/components/SettingsPage.tsx (toggle component pattern, if present)
- .planning/phases/06-supervisor-tray-app/06-CONTEXT.md (defaults)
</read_first>
<acceptance_criteria>
- All four controls write to config on change (debounced for the slider, immediate for the toggles)
- The dangerous-flag explanation text is verbatim what's in this task's `<action>` block
- The component renders correctly in both light and dark themes
</acceptance_criteria>
</task>

<task id="T5">
<action>Build `supervisor/tauri/ui/src/components/SidecarStatusBadge.tsx`. Reads `getStatus()` on mount + subscribes to `onStatusChange`. Renders a small pill with a dot + text: idle (gray), starting (amber pulse), running (indigo, solid), crashed (red, with the last-exit reason tooltip), nssm_conflict (slate "NSSM conflict"). On click while `crashed`, calls `restartSupervisor()`. Includes a tiny "last activity" timestamp underneath ("running since 09:14" / "crashed at 09:11 — restart").</action>
<read_first>
- ~/.claude/CLAUDE.md (Status colors section: emerald/amber/red/gray)
- supervisor/src/process-manager.ts (`ProcState` enum)
</read_first>
<acceptance_criteria>
- Pill color tracks state per the mapping
- Crashed state click triggers a restart and the pill transitions to `starting` within 100ms
- Tooltip on hover (crashed) shows the last-exit `reason` and `code`
</acceptance_criteria>
</task>

<task id="T6">
<action>Build `supervisor/tauri/ui/src/components/NssmMigrateCard.tsx`. Renders only when `checkNssmService()` returns `{ running: true }`. Content: an amber callout explaining "An older NSSM-based Remo Supervisor service is running. The tray app will stay paused until you migrate." + a **Migrate now** button calling `migrateFromNssm()` (which on the Rust side runs `npx remo-code-supervisor uninstall`, then enables Tauri autostart, then starts the sidecar). Show a loading spinner during migration. On success, refetch `checkNssmService()` and `getStatus()`. On failure, show the error inline + a "Try again" affordance.</action>
<read_first>
- supervisor/src/nssm-installer.ts (uninstall command)
- supervisor/tauri/src-tauri/src/nssm.rs (PLAN-002 NSSM detection)
</read_first>
<acceptance_criteria>
- Card only renders when NSSM is running
- Migrate button uninstalls the service, enables Tauri autostart, and starts the sidecar — verified end-to-end
- Failure path shows the error message inline (not a console crash)
</acceptance_criteria>
</task>

<task id="T7">
<action>Build `supervisor/tauri/ui/src/components/OnboardingFlow.tsx`. Renders ONLY when `getConfig()` returns `null` (first-run; no `supervisor.json` yet) — `App.tsx` decides which surface to show. Three steps with a small progress dot indicator: (1) Hub URL (default `https://app.remo-code.com`, editable), (2) API key (`olx_...` text input with paste-from-clipboard helper), (3) Allowed folder picker (one folder required to proceed — uses the same picker as `<FolderList>`). After Step 3, a **Finish** button calls `saveConfig({ ... })` then triggers `startSupervisor()`. Show a "starting…" surface for ≤ 5 seconds; if the supervisor's status reaches `running`, transition to `<SettingsPage>` automatically. If still `starting` or `crashed`, show an inline error with a "Try again" button.</action>
<read_first>
- web/src/components/SettingsPage.tsx (input + button styling)
- ~/.claude/CLAUDE.md (onboarding aesthetic — minimal, indigo, no shadows)
</read_first>
<acceptance_criteria>
- First launch with no config shows the onboarding (not the settings page)
- Stepping through saves the config exactly once at the end (not per-step)
- After success, the tray icon goes green and the settings page is shown
</acceptance_criteria>
</task>

<task id="T8">
<action>Build `supervisor/tauri/ui/src/components/HotkeyDisplay.tsx`. Shows `Ctrl+Shift+Alt+K` as a styled key-cap pill row (read-only in v1 per CONTEXT.md decisions). Below the key-cap row: a primary indigo button **Stop all sessions now** that calls `stopSupervisor()` (acts as the on-screen panic button companion to the global hotkey). Below that, a small caption: "Triggers ProcessManager.stopAll('kill_switch') — terminates all child agent processes within 10 seconds."</action>
<read_first>
- supervisor/src/process-manager.ts (`stopAll` signature)
</read_first>
<acceptance_criteria>
- Key-caps render with the indigo border and `font-mono` per Tailwind conventions
- Clicking **Stop all sessions now** calls `stopSupervisor()` and the status badge transitions to `idle` within 10 seconds
</acceptance_criteria>
</task>

<task id="T9">
<action>Wire `App.tsx` to choose between `<OnboardingFlow>` and `<SettingsPage>` based on `getConfig()` returning `null` vs a valid config. Subscribe to `onConfigValidationError` at app root and surface errors as a non-blocking toast at the top of the page. Also subscribe to `onKillSwitchActivated` and flash a brief amber banner ("Kill switch activated — all sessions stopped") for 3 seconds.</action>
<read_first>
- supervisor/tauri/ui/src/App.tsx (PLAN-001 scaffold version)
</read_first>
<acceptance_criteria>
- First launch (no config) shows onboarding; subsequent launches show settings
- Validation errors from saves render as a dismissable toast
- Kill switch activation flashes the banner for 3 seconds then auto-dismisses
</acceptance_criteria>
</task>

</tasks>

must_haves:
- All 6 surfaced security toggles match R-06-03 exactly: allowed folders, dangerous-permissions cap, max concurrent, audit log, restrict-to-git, kill-switch (display + panic button)
- First-run onboarding ships and writes a valid `supervisor.json` end-to-end (R-06-11)
- NSSM migrate-from card surfaces only when applicable and works end-to-end (R-06-05)
- Status badge accurately reflects sidecar state (R-06-08)
- All styling matches `web/src/components/SettingsPage.tsx` and global frontend conventions in `~/.claude/CLAUDE.md`
