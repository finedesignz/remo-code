---
plan_id: 06-PLAN-005-protocol-enforcement
wave: 3
depends_on: [06-PLAN-004-config-bridge]
files_modified:
  - supervisor/src/process-manager.ts
  - supervisor/src/hub-client.ts
  - supervisor/src/audit.ts
  - supervisor/src/index.ts
  - supervisor/test/process-manager.sandbox.test.ts
  - hub/src/ws/supervisor-protocol.ts
autonomous: true
requirements: [R-06-03, R-06-09]
---

# Plan 06-005 — Protocol-level enforcement of security toggles (sandbox gate, dangerous-cap, concurrency, git-only, audit, kill-switch)

<tasks>

<task id="T1">
<action>**(Critical — fixes existing sandbox vulnerability.)** Add a sandbox-escape gate in `supervisor/src/process-manager.ts`. Before `spawn(run)` is called from `start(spec)`, the manager MUST validate that `spec.repoPath` is contained within at least ONE of `this.cfg.roots`. Algorithm:
1. `const realRepo = fs.realpathSync(spec.repoPath)` — resolves symlinks
2. For each `root` in `cfg.roots`: `const realRoot = fs.realpathSync(root)`; if `realRepo === realRoot || realRepo.startsWith(realRoot + sep)`, ALLOW
3. If no root matched, REJECT with `{ type: 'sandbox_escape', repo_path: spec.repoPath, real_path: realRepo, allowed_roots: cfg.roots }` via `cb.onLog('error', ...)` and call `cb.onStateChange('stopped', { runId: spec.runId, lastExit: { code: null, reason: 'sandbox_escape' } })`. Do NOT spawn.

`process-manager.ts` currently does NOT have a `cfg` field. Add one — pass `cfg: SupervisorConfig` to the constructor. The `SupervisorClient` in `hub-client.ts` constructs the manager — update it to pass `cfg`. Add a `pm.updateConfig(cfg: SupervisorConfig)` method that swaps the in-memory reference; the watcher from PLAN-004 calls this.</action>
<read_first>
- supervisor/src/process-manager.ts (whole file — current constructor, `start` method)
- supervisor/src/hub-client.ts (where the PM is constructed)
- supervisor/src/config.ts (after PLAN-004 extends it)
</read_first>
<acceptance_criteria>
- `pm.start({ repoPath: 'C:\\Windows\\System32', ... })` against `cfg.roots = ['C:/Users/artic/GitHub']` is REJECTED with `reason: 'sandbox_escape'`
- A symlink `C:\Tmp\link → C:\Windows\System32` is ALSO rejected (realpath check works)
- A legitimate path inside a configured root is allowed
- `pm.updateConfig(newCfg)` is reflected in the NEXT `start()` call (no need to restart in-flight runs)
</acceptance_criteria>
</task>

<task id="T2">
<action>Add a git-only gate. When `cfg.restrictToGit === true`, before spawn, check `fs.existsSync(join(spec.repoPath, '.git'))`. If absent, REJECT with `{ type: 'not_git_repo', repo_path: spec.repoPath }`. Mirror the existing `repo-scanner.ts` check exactly (it uses `existsSync(join(path, '.git'))`).</action>
<read_first>
- supervisor/src/repo-scanner.ts (the `.git` existence check pattern)
</read_first>
<acceptance_criteria>
- With `restrictToGit: true` and a non-git directory, the spawn is rejected with `reason: 'not_git_repo'`
- With `restrictToGit: false`, the same call succeeds (gate is opt-in)
- A bare-repo directory (no `.git` folder, just `.git` file pointing elsewhere) is allowed because `existsSync` is true on the file/symlink
</acceptance_criteria>
</task>

<task id="T3">
<action>Enforce `maxConcurrent`. Add a precheck at the top of `pm.start()`: count active runs (`Array.from(this.runs.values()).filter(r => r.state !== 'idle' && r.state !== 'stopped').length`). If `>= this.cfg.maxConcurrent`, REJECT with `{ type: 'concurrency_cap', limit: this.cfg.maxConcurrent }` and emit a log. The current `process-manager.ts` ignores this config field — wire it up.</action>
<read_first>
- supervisor/src/process-manager.ts (the `start` method)
- supervisor/src/config.ts (maxConcurrent field)
</read_first>
<acceptance_criteria>
- With `maxConcurrent: 1` and an in-flight run, a second `start()` call rejects with `reason: 'concurrency_cap'`
- After the first run exits, a new start succeeds
- The cap counts `running`, `starting`, and `crashed` (i.e. restart-pending) runs — not just `running`
</acceptance_criteria>
</task>

<task id="T4">
<action>Implement the `--dangerously-skip-permissions` hard cap. The current spawn command in `process-manager.ts:92-104` does NOT pass any `--dangerously-skip-permissions` flag. Per the architecture, the agent (`remo-code-agent`) is what receives that flag. Add: if the hub's `session.start` message includes a flag (extend `RunSpec` with `dangerouslySkipPermissions: boolean`), the supervisor's spawn command includes `--dangerously-skip-permissions` ONLY IF `cfg.allowDangerousSkipPermissions === true`. Otherwise, STRIP it silently and log a warning: `[security] hub requested --dangerously-skip-permissions but supervisor cap is OFF; flag stripped`. Capability flag `allow_dangerous_skip_permissions` is already advertised in `supervisor.hello` per PLAN-002 T3 — no further wire change.

Extend `hub-client.ts`'s `onSessionStart` handler to read the new optional field from the hub message and pass it through to `pm.start`. The hub-side schema change (adding the field to the `session.start` typed union in `hub/src/ws/supervisor-protocol.ts`) is part of this task — it's an additive optional field, no breaking change.</action>
<read_first>
- supervisor/src/process-manager.ts (spawn command, lines 92–104)
- supervisor/src/hub-client.ts (`onSessionStart`)
- hub/src/ws/supervisor-protocol.ts (the `session.start` type in `HubToSupervisor`)
</read_first>
<acceptance_criteria>
- With cap OFF and hub requesting the flag, the spawn command does NOT include the flag (verified by inspecting the spawned argv)
- With cap ON and hub requesting the flag, the spawn DOES include `--dangerously-skip-permissions`
- With cap ON and hub NOT requesting, the flag is absent (cap is permissive, not forcing)
- `hub/src/ws/supervisor-protocol.ts` change is additive only — old supervisors that don't read the field still work
</acceptance_criteria>
</task>

<task id="T5">
<action>Create `supervisor/src/audit.ts`. Exports `appendAudit(entry: AuditEntry, cfg: SupervisorConfig): Promise<void>`. `AuditEntry` shape: `{ ts: ISO8601, run_id, repo_path, branch, prompt_hash, flags: { dangerously_skip_permissions: boolean, ... }, allowed: boolean, reason?: string }`. Path: `cfg.auditLogPath` (default `%LOCALAPPDATA%\remo-code-supervisor\audit.jsonl`). Uses an append-only `fs.appendFile` call. Hash the prompt with `crypto.subtle.digest('SHA-256', ...)` — never store the raw prompt. Skip writing if `cfg.auditLogEnabled === false`. Rotation: when the file exceeds 50 MB, rename to `audit.jsonl.1` (overwriting any existing) and start fresh.

Wire from `process-manager.ts` — call `appendAudit(...)` at every `pm.start()` decision point (allowed AND rejected paths).</action>
<read_first>
- supervisor/src/index.ts (existing log-rotation pattern — lines 20–55 — for the 50MB rotation style)
- supervisor/src/process-manager.ts (where to insert audit calls)
</read_first>
<acceptance_criteria>
- Every `pm.start()` call (allowed or rejected) appends ONE line to the audit file
- Lines are valid JSON (one per line — JSONL)
- Prompt is hashed, never raw
- With `auditLogEnabled: false`, no file is written and no error is thrown
- 50 MB rotation works (verified by writing 50 MB of synthetic entries — out of scope to automate, but the logic is asserted in code review)
</acceptance_criteria>
</task>

<task id="T6">
<action>Wire the kill-switch stdin command. In `supervisor/src/index.ts`'s `run` handler (only when `--sidecar`), read `process.stdin` line-by-line. When a line equals `KILL_ALL`, call `client.pm.stopAll('kill_switch')`. PLAN-002 T8 already wired the Tauri shell to send `KILL_ALL` on hotkey activation. The `SupervisorClient` does not currently expose the `pm` — add a getter `get pm(): ProcessManager` for this purpose, or expose a dedicated `killAll()` method.</action>
<read_first>
- supervisor/src/hub-client.ts (where `pm` is held)
- supervisor/src/index.ts (the `run` handler)
- supervisor/src/process-manager.ts (`stopAll` signature)
</read_first>
<acceptance_criteria>
- Sending `KILL_ALL\n` to the Bun sidecar's stdin terminates all child processes within 10s
- The kill-switch path also writes an audit entry (`reason: 'kill_switch'`)
- Without `--sidecar`, stdin is not read (NSSM path unaffected)
</acceptance_criteria>
</task>

<task id="T7">
<action>Extend `hub/src/ws/supervisor-protocol.ts` ADDITIVELY. Add optional capability fields to the `SupervisorHello` schema: `.extend({ allow_dangerous_skip_permissions: z.boolean().optional(), restrict_to_git: z.boolean().optional(), max_concurrent: z.number().int().positive().optional(), audit_log_enabled: z.boolean().optional() })`. Add `dangerously_skip_permissions: z.boolean().optional()` to the `session.start` member of the `HubToSupervisor` type union. NO removals, NO renames. Existing supervisors that don't send / don't read these fields MUST keep working unchanged.

Also: the file currently has a duplicated `HostResourcesMessage` block (lines 71–80 and 92–106) — leave it alone, that's outside Phase 06 scope.</action>
<read_first>
- hub/src/ws/supervisor-protocol.ts (whole file)
</read_first>
<acceptance_criteria>
- The Zod schema validates a `supervisor.hello` WITHOUT the new fields (back-compat)
- It also validates a hello WITH the new fields
- The TypeScript `HubToSupervisor.session.start` type compiles with and without the new optional field
- No other schema is touched
</acceptance_criteria>
</task>

<task id="T8">
<action>Write `supervisor/test/process-manager.sandbox.test.ts` (Bun test). Cases:
1. `pm.start({ repoPath: 'C:\\Windows\\System32', ... })` against `cfg.roots = ['C:/Users/<me>/GitHub']` rejects with `sandbox_escape`
2. Symlink-escape: create a temp symlink pointing outside the roots, attempt start, assert rejection
3. `restrictToGit: true` + non-git dir → reject
4. `maxConcurrent: 1` + already-running run → second `start` rejects
5. `--dangerously-skip-permissions` cap OFF + hub request ON → spawn argv does NOT include the flag
6. Cap ON + hub request ON → spawn argv DOES include the flag

Mock `Bun.spawn` so no actual processes start. Inspect the would-be argv via a spawn-spy.</action>
<read_first>
- hub/test/scheduler.test.ts (Bun test idiom in this repo)
- supervisor/src/process-manager.ts (whole file)
</read_first>
<acceptance_criteria>
- `bun test supervisor/test/process-manager.sandbox.test.ts` is green
- All 6 cases assert with explicit names
- No real subprocess is spawned during the test (verified by spawn-spy count)
</acceptance_criteria>
</task>

</tasks>

must_haves:
- The sandbox-escape vulnerability in `process-manager.ts` is fixed and tested (this is the most important task in the entire phase)
- `--dangerously-skip-permissions` is a HARD CAP enforced by the supervisor; the hub cannot override
- `maxConcurrent` is enforced (it isn't today)
- `restrictToGit` gate works
- Audit JSONL writes on every `pm.start()` decision (allow + reject)
- Kill-switch stdin → stopAll wired
- Hub WS protocol change is ADDITIVE only (R-06-09)
