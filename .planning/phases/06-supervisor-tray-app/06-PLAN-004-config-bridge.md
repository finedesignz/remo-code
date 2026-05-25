---
plan_id: 06-PLAN-004-config-bridge
wave: 2
depends_on: [06-PLAN-001-tauri-scaffold, 06-PLAN-002-sidecar-and-process-control]
files_modified:
  - supervisor/src/config.ts
  - supervisor/src/index.ts
  - supervisor/tauri/src-tauri/Cargo.toml
  - supervisor/tauri/src-tauri/src/main.rs
  - supervisor/tauri/src-tauri/src/ipc.rs
autonomous: true
requirements: [R-06-04]
---

# Plan 06-004 — Config bridge (Tauri IPC ↔ supervisor.json ↔ Bun live reload)

<tasks>

<task id="T1">
<action>Extend `supervisor/src/config.ts`. Add to `SupervisorConfig` the new fields with defaults:
- `allowDangerousSkipPermissions: boolean` (default `false`)
- `restrictToGit: boolean` (default `true`)
- `auditLogEnabled: boolean` (default `true`)
- `auditLogPath: string` (default `%LOCALAPPDATA%\remo-code-supervisor\audit.jsonl` on Windows, `~/.local/share/remo-code-supervisor/audit.jsonl` elsewhere — compute lazily, do not store the resolved path in the JSON)
- `autostart: boolean` (default `true`)

JSON file uses snake_case (per existing convention — `api_key`, `hub_url`, `max_concurrent`): `allow_dangerous_skip_permissions`, `restrict_to_git`, `audit_log_enabled`, `audit_log_path`, `autostart`. `loadConfig()` MUST default any missing field to the safe default (back-compat with existing configs). `saveConfig()` MUST round-trip all known fields plus preserve any unknown keys (don't drop forward-compat fields).

Also add a new exported helper `watchConfig(cb: (cfg: SupervisorConfig) => void): { dispose: () => void }`. Uses `fs.watch` on `CONFIG_PATH` (polling fallback if `fs.watch` is unreliable on Windows — debounce 200ms). On change, re-`loadConfig()` and invoke `cb`. Errors during reload should call `cb` with the LAST-KNOWN-GOOD config and emit a `console.error` line tagged `[config:reload]` — never throw.</action>
<read_first>
- supervisor/src/config.ts (whole file)
- supervisor/src/index.ts (where to insert the watch + reload wire-up)
</read_first>
<acceptance_criteria>
- Loading an existing `supervisor.json` from a pre-Phase-06 install does NOT throw — all new fields default
- A `saveConfig` round-trip preserves any extra keys not in the typed interface
- `fs.watch` notifies within 500ms on Windows (verified with a small test script)
- Malformed JSON in the file does NOT crash the supervisor — the watcher logs the error and keeps the previous config
</acceptance_criteria>
</task>

<task id="T2">
<action>Wire `watchConfig` into `supervisor/src/index.ts`'s `run` command (both with and without `--sidecar`). On every change, push the new config to `SupervisorClient` (which holds the `cfg` reference) and to `ProcessManager` (PLAN-005 will add a `pm.updateConfig(cfg)` method — for now, just call a no-op stub). Emit a JSONL log line `{ source: 'bun', level: 'info', msg: 'config reloaded', changed_keys: [...] }` so the Tauri shell can surface it as a toast.</action>
<read_first>
- supervisor/src/index.ts (the `run` command body)
- supervisor/src/hub-client.ts (where the cfg reference is held)
</read_first>
<acceptance_criteria>
- Editing `supervisor.json` directly (e.g. via Notepad) triggers a reload log within 2s
- Changed-keys array is accurate (compare old vs new shallow keys)
- `SupervisorClient` and `ProcessManager` both see the new config
</acceptance_criteria>
</task>

<task id="T3">
<action>Implement the Tauri commands in `supervisor/tauri/src-tauri/src/ipc.rs`. Functions (all `#[tauri::command] async fn ...`):
- `get_config() -> Result<Option<SupervisorConfig>, String>` — reads `%APPDATA%\remo-code\supervisor.json`; returns `None` if absent (drives onboarding)
- `save_config(cfg: SupervisorConfig) -> Result<(), String>` — validates server-side (api_key matches `^olx_[A-Za-z0-9_\-]{20,}$`, hub_url is `https://...` or `http://localhost...`, `max_concurrent` in 1..=16, `roots` non-empty AND each path exists), writes the file atomically (write to `supervisor.json.tmp` then rename), emits `config:validation_error` event on failure
- `get_status() -> Result<SidecarStatusDto, String>`
- `start_supervisor()`, `stop_supervisor()`, `restart_supervisor()` — proxy to the `Sidecar` from PLAN-002
- `pick_folder() -> Result<Option<String>, String>` — wraps `tauri-plugin-dialog` `FileDialogBuilder::pick_folder`
- `open_audit_log()` / `open_config_file()` — open Explorer to the containing folder via `Command::new("explorer.exe").arg("/select,").arg(<path>)`
- `check_nssm_service()` — delegates to `nssm::is_nssm_running`
- `migrate_from_nssm()` — runs `npx remo-code-supervisor uninstall` then enables Tauri autostart then `start_supervisor()`

Register all 10 in the `.invoke_handler(tauri::generate_handler![...])` macro in `main.rs`.</action>
<read_first>
- https://v2.tauri.app/develop/calling-rust/ (command macro)
- https://v2.tauri.app/plugin/dialog/ (folder picker)
- supervisor/src/config.ts (CONFIG_PATH derivation — must match exactly)
</read_first>
<acceptance_criteria>
- `cargo build --release` is green
- Every command has explicit success + error JSON shapes
- `save_config` rejects invalid input with an actionable error string (e.g. `"api_key must match olx_..."`)
- `save_config` writes atomically — interrupting the write mid-flight (kill -9) leaves the previous file intact (no half-written JSON)
- `open_audit_log` opens Explorer to the right folder
</acceptance_criteria>
</task>

<task id="T4">
<action>Add `serde`-derived structs in `ipc.rs` that mirror the Bun TypeScript `SupervisorConfig` shape (snake_case via `#[serde(rename_all = "snake_case")]`). Include `#[serde(default)]` on every new field so older configs round-trip cleanly.</action>
<read_first>
- supervisor/src/config.ts (after T1 extends it — for the canonical field list)
</read_first>
<acceptance_criteria>
- `serde_json::from_str::<SupervisorConfig>(...)` succeeds on a pre-Phase-06 config (no extra fields) AND on a Phase-06 config (with extras)
- Round-trip (`from_str` → `to_string`) preserves field order and indentation (use `serde_json::to_string_pretty`)
</acceptance_criteria>
</task>

<task id="T5">
<action>Add a small Rust integration test at `supervisor/tauri/src-tauri/tests/config_roundtrip.rs`. Cases: (a) round-trip an empty (`{}`) JSON — all fields take their defaults; (b) round-trip a Phase-06 config — all fields preserved; (c) atomic write — write a config, then SIGKILL between tmp-write and rename, assert the original is intact; (d) validation rejects bad api_key, bad hub_url, empty roots, out-of-range max_concurrent.</action>
<read_first>
- https://doc.rust-lang.org/cargo/commands/cargo-test.html
</read_first>
<acceptance_criteria>
- `cargo test --manifest-path supervisor/tauri/src-tauri/Cargo.toml` is green
- All 4 cases assert with explicit messages
</acceptance_criteria>
</task>

</tasks>

must_haves:
- `supervisor.json` is the SINGLE config source of truth — same file the Bun runtime and the Tauri UI read/write
- Live reload works within 2s of an external write (R-06-04)
- `save_config` validates server-side and writes atomically
- All 10 Tauri commands registered and tested at least via the Rust unit test
- New config fields are backward-compatible (old configs load with safe defaults)
