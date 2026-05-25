---
plan_id: 06-PLAN-007-docs-and-tests
wave: 4
depends_on: [06-PLAN-001-tauri-scaffold, 06-PLAN-002-sidecar-and-process-control, 06-PLAN-003-settings-ui, 06-PLAN-004-config-bridge, 06-PLAN-005-protocol-enforcement, 06-PLAN-006-installer-and-autostart]
files_modified:
  - README.md
  - CLAUDE.md
  - docs/supervisor-tray.md
  - supervisor/test/process-manager.sandbox.test.ts
  - supervisor/tauri/src-tauri/tests/config_roundtrip.rs
  - .planning/ROADMAP.md
autonomous: true
requirements: [R-06-01, R-06-02, R-06-03, R-06-04, R-06-05, R-06-06, R-06-07, R-06-08, R-06-09, R-06-10, R-06-11, R-06-12]
---

# Plan 06-007 — Docs, README, CLAUDE.md, smoke checklist, final test sweep

<tasks>

<task id="T1">
<action>Create `docs/supervisor-tray.md`. Sections:
1. **Overview** — what the tray app is, why it exists (the "no visible console" requirement), who should use it (desktop) vs the NSSM path (headless server)
2. **Architecture** — Tauri shell (Rust + WebView2) + Bun sidecar with `CREATE_NO_WINDOW`, stdio JSONL bridge, shared `supervisor.json`
3. **Security model** — sandbox-escape gate, `--dangerously-skip-permissions` hard cap, restrict-to-git, max concurrent, audit JSONL, kill-switch hotkey. Cross-link to `hub/src/ws/supervisor-protocol.ts` for the additive capability flags
4. **Installation** — link to the GitHub release MSI; document the SmartScreen prompt and how to bypass it
5. **First-run flow** — onboarding (hub URL, API key, allowed folder)
6. **Settings UI** — screenshot placeholder (`<!-- screenshot: docs/img/supervisor-tray-settings.png -->`), one-paragraph description of each card
7. **NSSM coexistence** — when both are installed, the tray app refuses to spawn its sidecar; the **Migrate now** button uninstalls NSSM
8. **Single-instance + port mutex** — explain `tauri-plugin-single-instance` + `127.0.0.1:9106` bind + the 9197 fallback
9. **Updates** — `tauri-plugin-updater`, manifest URL, v1 unsigned + SmartScreen note, deferred EV cert
10. **Uninstall** — what gets removed vs preserved
11. **Troubleshooting** — common issues: NSSM conflict, port-bind failure, autostart not firing (Group Policy), WebView2 not installed
12. **Deferred / not in v1** — copy the `<deferred>` block from CONTEXT.md verbatim

Mirror the structure of `docs/scheduled-tasks.md` for consistency.</action>
<read_first>
- docs/scheduled-tasks.md (style baseline)
- .planning/phases/06-supervisor-tray-app/06-CONTEXT.md (source of truth)
</read_first>
<acceptance_criteria>
- File at `docs/supervisor-tray.md`
- All 12 sections present
- Cross-links to `hub/src/ws/supervisor-protocol.ts` and `docs/scheduled-tasks.md` resolve
- Screenshot placeholder comment is present
</acceptance_criteria>
</task>

<task id="T2">
<action>Update project `CLAUDE.md`. Append a section "Supervisor (tray app + NSSM)" right after the "Architecture" section. Document:
- Two entrypoints: the Tauri tray app (desktop default) and the NSSM CLI install (headless servers)
- New file tree under `supervisor/tauri/{src-tauri,ui}/`
- Bun supervisor runs as a Tauri sidecar with `CREATE_NO_WINDOW` (no console window)
- Config file is shared: `%APPDATA%\remo-code\supervisor.json`
- Six security toggles surfaced in Settings UI + their defaults
- `--dangerously-skip-permissions` is a HARD CAP enforced by `supervisor/src/process-manager.ts`, not a default
- The sandbox-escape gate added in PLAN-005
- Audit JSONL at `%LOCALAPPDATA%\remo-code-supervisor\audit.jsonl`
- Kill-switch hotkey `Ctrl+Shift+Alt+K`
- Hub WS protocol change is additive-only (new optional capability flags on `supervisor.hello`)

Also update the "Environment Variables" section to note that the tray app does NOT introduce new env vars — all config lives in `supervisor.json`.</action>
<read_first>
- CLAUDE.md (whole file)
</read_first>
<acceptance_criteria>
- New "Supervisor" section is present and accurate
- Both entrypoints are documented
- `--dangerously-skip-permissions` hard-cap semantics are explicitly called out
- Cross-link to `docs/supervisor-tray.md` exists
</acceptance_criteria>
</task>

<task id="T3">
<action>Add the smoke checklist to `docs/supervisor-tray.md` as an appendix titled "Manual Windows smoke (release gate)". The checklist (executing agent runs this on a Windows machine and pastes results in the PR body):
1. Install the MSI on a clean user account — no SmartScreen bypass attempt required to start; just acknowledge the warning
2. Verify tray icon appears in notification area
3. Verify NO console window visible at any point
4. Left-click tray → settings window opens
5. First-run onboarding fires (hub URL, API key, allowed folder) and saves to `%APPDATA%\remo-code\supervisor.json`
6. After onboarding, tray icon goes indigo (running)
7. Verify Bun sidecar PID exists in Task Manager with no `conhost.exe` parent
8. Edit `supervisor.json` directly in Notepad, save — settings UI reflects the change within 2s
9. Toggle `allow_dangerous_skip_permissions` OFF in UI, request a session via the hub with the flag — verify `process-manager.ts` log says `flag stripped`
10. Try to launch a session in `C:\Windows\System32` via a manually crafted hub message — verify rejection with `sandbox_escape`
11. Press `Ctrl+Shift+Alt+K` — verify all active sessions terminate within 10s + audit JSONL has a `reason: 'kill_switch'` entry
12. Verify `127.0.0.1:9106` (or 9197 fallback) is bound by the Bun sidecar (`netstat -ano | findstr :9106`)
13. Launch a second instance of `Remo Supervisor.exe` — verify the existing settings window comes to focus and no new process spawns
14. Log out and log back in — verify the tray app launches automatically with NO console window
15. With NSSM service `RemoCodeSupervisor` running, launch the tray app — verify NSSM migrate card appears and the sidecar does NOT spawn until migration
16. Run the **Migrate now** button — NSSM uninstalls, autostart enables, sidecar starts
17. Uninstall via Programs & Features — verify autostart Run-key removed, binaries gone, `supervisor.json` preserved</action>
<read_first>
- .planning/phases/06-supervisor-tray-app/06-CONTEXT.md (decisions to verify)
- All R-06-* requirements
</read_first>
<acceptance_criteria>
- Appendix is present in `docs/supervisor-tray.md`
- All 17 checks pass on the executing agent's Windows box
- Each result is recorded as PASS / FAIL in the PR body with one-line evidence
</acceptance_criteria>
</task>

<task id="T4">
<action>Final test sweep:
1. `bun install` at repo root succeeds
2. `bun test supervisor/test/process-manager.sandbox.test.ts` is green (PLAN-005)
3. `cargo test --manifest-path supervisor/tauri/src-tauri/Cargo.toml` is green (PLAN-004, T5)
4. `bun install` in `supervisor/tauri/ui/` succeeds
5. `bunx tsc --noEmit` in `supervisor/tauri/ui/` is green
6. `npx tauri build` in `supervisor/tauri/` produces an MSI

Then update `.planning/ROADMAP.md`: Phase 06 status `Pending` → `Complete` with `Completed: <today>`.</action>
<read_first>
- .planning/ROADMAP.md (current Phase 06 entry)
</read_first>
<acceptance_criteria>
- All 6 build / test steps are green
- ROADMAP.md Phase 06 marked Complete with the completion date
</acceptance_criteria>
</task>

<task id="T5">
<action>Sanity-check the NSSM regression. On a Windows box where the tray app is NOT installed: run `npx remo-code-supervisor install --api-key olx_test --roots C:/Users/<me>/GitHub`. Verify the NSSM service installs, starts, and the supervisor connects to the hub as before. Document the result in the PR body. This is the R-06-05 acceptance gate.</action>
<read_first>
- supervisor/src/nssm-installer.ts (the install flow)
- supervisor/src/index.ts (the `install` command)
</read_first>
<acceptance_criteria>
- NSSM install succeeds on a machine with no tray app installed
- The supervisor connects to the hub and shows `online` in the web UI
- No Phase 06 code path interferes with the legacy install — the tray-app paths are entirely additive
</acceptance_criteria>
</task>

</tasks>

must_haves:
- `docs/supervisor-tray.md` is the single user-facing reference for the tray app
- `CLAUDE.md` documents the new entrypoint, security toggles, hard-cap semantics, and audit log location
- All unit + integration tests green: Bun sandbox tests, Rust config-roundtrip tests, TypeScript `tsc --noEmit`, MSI build
- Manual Windows smoke (17 checks) recorded in the PR body
- NSSM regression sanity-check recorded in the PR body
- ROADMAP.md Phase 06 marked Complete
