---
plan_id: 06-PLAN-002-sidecar-and-process-control
wave: 1
depends_on: []
files_modified:
  - supervisor/tauri/src-tauri/Cargo.toml
  - supervisor/tauri/src-tauri/tauri.conf.json
  - supervisor/tauri/src-tauri/src/main.rs
  - supervisor/tauri/src-tauri/src/sidecar.rs
  - supervisor/tauri/src-tauri/src/tray.rs
  - supervisor/tauri/src-tauri/src/nssm.rs
  - supervisor/src/index.ts
  - supervisor/src/hub-client.ts
  - supervisor/src/process-manager.ts
autonomous: true
requirements: [R-06-01, R-06-07, R-06-08]
---

# Plan 06-002 — Bun sidecar + process lifecycle, listener-leak fix, port-mutex, NSSM check

<tasks>

<task id="T1">
<action>Extend `supervisor/src/index.ts` to support a `--sidecar` flag on the existing `run` command. When `--sidecar` is set: (a) DISABLE the file-rotation logger in `setupFileLogging` (Tauri shell captures stdout and surfaces it; no need to also write to disk in sidecar mode), (b) emit a structured JSONL line on stdout for every state change and log line (shape `{ ts, level, source: 'bun', msg, ... }`), (c) on graceful shutdown (SIGINT/SIGTERM from Tauri), call `pm.stopAll('shell_shutdown')` and exit 0 within 10s. Without the flag, behavior is unchanged (NSSM path keeps working). Document the flag in `printHelp()`.</action>
<read_first>
- supervisor/src/index.ts (whole file)
</read_first>
<acceptance_criteria>
- `bun supervisor/src/index.ts run --sidecar` (with a valid config) emits JSONL on stdout, no file in `%LOCALAPPDATA%\remo-code-supervisor\supervisor.log`
- `bun supervisor/src/index.ts run` (no flag) emits human logs to stdout AND writes the rotating file as before
- `npx remo-code-supervisor install` (NSSM path) still works end-to-end on a fresh machine — verified by smoke
</acceptance_criteria>
</task>

<task id="T2">
<action>Fix the WS listener leak in `supervisor/src/hub-client.ts`. The bug: `connect()` reassigns `this.ws = new WebSocket(...)` on reconnect without removing handlers from the previous socket. Add private fields `private wsOnOpen`, `wsOnMessage`, `wsOnClose`, `wsOnError` that hold the bound listener references. At the top of `connect()`, if `this.ws` exists, call `this.ws.removeEventListener('open', this.wsOnOpen)` etc. for all four handlers, then `try { this.ws.close() } catch {}` and `this.ws = null` before constructing the new socket. Then assign the new handlers via the same field references so they can be cleaned up on the next reconnect. Add a `dispose()` method that does the same cleanup + clears `reconnectTimer`.</action>
<read_first>
- supervisor/src/hub-client.ts (whole file, focus lines 21–80)
</read_first>
<acceptance_criteria>
- A 60-cycle reconnect stress test (force-close + reconnect 60 times) shows the Bun process's listener count for `WebSocket` stays bounded (verify with `process._getActiveHandles()` or a simple counter on add/remove)
- `dispose()` is called from `main()` on SIGINT/SIGTERM; the process exits within 2s of receiving the signal with no orphaned WS connections
- All four event listeners are removed exactly once per reconnect cycle
</acceptance_criteria>
</task>

<task id="T3">
<action>Also in `supervisor/src/hub-client.ts`, advertise NEW capability flags via the `supervisor.hello` payload. Read from `cfg`: `allow_dangerous_skip_permissions`, `restrict_to_git`, `max_concurrent`, `audit_log_enabled`. Add these fields to the existing `supervisor.hello` message construction. The `OutboundMsg` type union in this file already includes `supervisor.hello`; extend its inline shape additively. The hub-side schema change is owned by PLAN-007 (it's a docs/test pass at the end).</action>
<read_first>
- supervisor/src/hub-client.ts (existing `supervisor.hello` send-site, lines 118–125)
- hub/src/ws/supervisor-protocol.ts (existing `SupervisorHello` schema for reference — DO NOT modify here)
- supervisor/src/config.ts (current `SupervisorConfig` interface — depends on PLAN-004 if extended fields aren't yet present; default the new fields to safe values if absent)
</read_first>
<acceptance_criteria>
- Connecting against a stock hub still works — extra fields are ignored by old hubs (additive change, no schema rejection)
- The 4 new fields appear in the JSON sent on `supervisor.hello` (verified by sniffing the WS or logging it on the hub side)
</acceptance_criteria>
</task>

<task id="T4">
<action>Add a port-mutex bind in `supervisor/src/index.ts` (only when `--sidecar` is set). At the top of the `run` handler, attempt `Bun.listen({ hostname: '127.0.0.1', port: 9106, ... })`. If the bind fails with `EADDRINUSE`, log `[sidecar] port 9106 already bound — another supervisor sidecar is running; exiting` and `process.exit(2)`. Keep the listener handle alive for the process lifetime (it is a mutex, not a real server). If port 9106 conflicts with `onetimeseo.com` on the user's box, fall back to 9197 (try the fallback only if the primary fails for any reason other than `EADDRINUSE` — then a second `EADDRINUSE` on 9197 is fatal). Document the chosen port in the PR body.</action>
<read_first>
- ~/.claude/CLAUDE.md (port map — 9106 conflict with onetimeseo.com noted in CONTEXT.md)
- supervisor/src/index.ts (where to insert the mutex)
</read_first>
<acceptance_criteria>
- Launching two `... run --sidecar` instances against the same config: the second exits with code 2 within 1s
- When 9106 is held by another process, the supervisor falls back to 9197 and proceeds
- Without `--sidecar`, no port is bound (NSSM path unaffected)
</acceptance_criteria>
</task>

<task id="T5">
<action>Create `supervisor/tauri/src-tauri/src/sidecar.rs`. Exports: `pub struct Sidecar { ... }`, `pub fn spawn(app: &AppHandle, cfg_path: PathBuf) -> Result<Sidecar, anyhow::Error>`, `impl Sidecar { pub fn start(&self), pub fn stop(&self), pub fn restart(&self), pub fn status(&self) -> SidecarStatus }`. Internals: use `tauri::api::process::Command::sidecar("remo-code-supervisor")` (Tauri's sidecar binary lookup — the bundled Bun build of `supervisor/src/index.ts` is shipped inside the MSI). On Windows, set `creation_flags(0x08000000)` (`CREATE_NO_WINDOW`). Args: `["run", "--sidecar"]`. Pipe stdout, parse each line as JSONL, re-emit as a Tauri event named `supervisor:log`. On exit, emit `supervisor:crash` if exit code != 0 and the shutdown wasn't user-initiated; auto-restart with the same backoff schedule as `process-manager.ts`'s `BACKOFF_SCHEDULE` (1s/2s/4s/8s/16s/30s). Circuit-break at 5 crashes in 10 min.</action>
<read_first>
- https://v2.tauri.app/develop/sidecar/ (Tauri sidecar API)
- supervisor/src/process-manager.ts (BACKOFF_SCHEDULE constant, CIRCUIT_WINDOW_MS, CIRCUIT_THRESHOLD — mirror these exact values)
</read_first>
<acceptance_criteria>
- Killing the Bun sidecar from Task Manager triggers a `supervisor:crash` Tauri event and the sidecar restarts within 1s of the first attempt
- Five forced kills in <10 min trigger the circuit breaker — sidecar stops trying and tray icon shows `crashed`; **Restart supervisor** menu item resets the breaker
- The Bun sidecar process is spawned with `CREATE_NO_WINDOW` — verified by `Process Explorer` showing no `conhost.exe` parent
</acceptance_criteria>
</task>

<task id="T6">
<action>Add the daily 4am heartbeat-restart inside `sidecar.rs`. Use `tauri::async_runtime::spawn` to run a background task that computes "next 4am local time" and `tokio::time::sleep` until then, then calls `self.restart()`. Re-arm for the next 24h. Document the cadence in a code comment.</action>
<read_first>
- https://docs.rs/tokio/latest/tokio/time/fn.sleep_until.html
- supervisor/src/process-manager.ts (existing restart machinery, for similarity)
</read_first>
<acceptance_criteria>
- At 4:00:00 local time, the sidecar restarts cleanly (no crash event, no user notification) — verified by manipulating the system clock OR by setting the target time to "in 30s" via a `#[cfg(debug_assertions)]` override for testing
- The next-restart timer re-arms after each fire
</acceptance_criteria>
</task>

<task id="T7">
<action>Create `supervisor/tauri/src-tauri/src/nssm.rs`. Function `pub async fn is_nssm_running() -> Result<bool, anyhow::Error>` — shells out to PowerShell `Get-Service RemoCodeSupervisor -ErrorAction SilentlyContinue` and parses the `Status` field, returns `true` only on `Running`. Function `pub async fn detect_legacy_install() -> Option<NssmInfo>` — returns the service status + the bin path (`Get-CimInstance Win32_Service -Filter "Name='RemoCodeSupervisor'"` for the `PathName` property). Wire into `sidecar::spawn` — if `is_nssm_running().await?` is `true`, REFUSE to spawn the sidecar; emit a `supervisor:nssm_conflict` Tauri event with the bin path and return without spawning. The Settings UI (PLAN-003) will surface the migrate-from-NSSM prompt.</action>
<read_first>
- https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.management/get-service
- supervisor/src/nssm-installer.ts (existing NSSM CLI patterns — match the SERVICE_NAME constant)
</read_first>
<acceptance_criteria>
- With `RemoCodeSupervisor` NSSM service installed and running, the Tauri sidecar does NOT spawn — tray shows `idle` with an inline `NSSM conflict` indicator
- With the service stopped or absent, the sidecar spawns normally
- `Get-CimInstance` runs without throwing on a clean machine (PowerShell 5.1 + 7.x both supported)
</acceptance_criteria>
</task>

<task id="T8">
<action>Wire the sidecar into the existing tray menu (PLAN-001 stubbed Start/Stop/Restart). In `main.rs`, the setup closure now: (1) spawns the sidecar (unless NSSM conflict), (2) listens for `supervisor:log`, `supervisor:status`, `supervisor:crash`, `supervisor:nssm_conflict` Tauri events and updates the tray icon + tooltip + "Status:" menu item text. State→icon mapping: `idle` → gray, `running` → indigo, `starting` → amber, `crashed` → red. Wire the **Restart supervisor** menu item to `sidecar.restart()`. Wire the kill-switch global-shortcut handler to a real action: emit a `kill_switch:activated` event AND call `sidecar.send_stdin("KILL_ALL\n")` — PLAN-005 wires the Bun side to receive this and call `pm.stopAll('kill_switch')`.</action>
<read_first>
- supervisor/tauri/src-tauri/src/tray.rs (the stub menu from PLAN-001)
- supervisor/tauri/src-tauri/src/main.rs (the setup closure from PLAN-001)
</read_first>
<acceptance_criteria>
- Tray icon color updates within 500ms of a sidecar state change
- **Restart supervisor** menu item triggers a clean restart (no crash event)
- Pressing the kill-switch hotkey logs `kill_switch:activated` AND sends `KILL_ALL` over stdin to the Bun sidecar (verified by adding a debug log on the Bun side)
- With NSSM service running, tray icon stays gray AND the menu shows an inline "NSSM conflict — open Settings to resolve" line (the migrate-from card lives in PLAN-003)
</acceptance_criteria>
</task>

</tasks>

must_haves:
- Bun supervisor runs as a Tauri sidecar with `CREATE_NO_WINDOW` — no console window ever
- WS listener leak fixed; reconnect cycles are bounded
- Sidecar advertises 4 new capability flags on `supervisor.hello` (additive, back-compat)
- Tauri shell and Bun sidecar each hold their own mutex (named-mutex in Rust, 127.0.0.1 port bind in Bun)
- NSSM-service-running detected on startup; sidecar refuses to spawn while NSSM is running
- Crash → tray icon turns red → **Restart supervisor** works
- Daily 4am sidecar restart scheduled
- Kill-switch hotkey routes from Tauri to the Bun sidecar (Bun-side handling lands in PLAN-005)
