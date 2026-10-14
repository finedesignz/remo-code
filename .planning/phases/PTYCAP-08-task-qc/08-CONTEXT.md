# Phase 8: Periodic Task QC + Optimization - Context

**Gathered:** 2026-10-13
**Status:** Ready for planning (two architecture forks recorded in `08-FORKS.md`; recommendations are adopted here as locked unless the panel overturns them - D-01 and D-02 are marked [FORK-1] / [FORK-2])
**Primary input:** `08-SPEC.md` (TQC-01..08). Where the SPEC contradicts the real schema or code, this file wins and says so (section "SPEC drift").
**Stacked on:** Phase 4 (PR #506, kill switch + lifetime counter), Phase 3 (PR #505).

<domain>
## Phase Boundary

Phase 8 delivers a recurring, bounded, config-only auditor of `scheduled_tasks`: six pure detectors over real columns, a frozen safe-fix allowlist behind an auditing writer, one digest email for everything else, all flag-gated OFF. It diagnoses CONFIG. It never plans, builds, opens a PR, disables a task, edits a prompt, changes a cadence, or touches a cap.

**In scope:** `task_type='task_qc'` enum value; `task_qc_findings` table; `hub/src/task-qc/{detectors,safe-fixes,engine,digest,flags,seed}.ts`; scheduler sender wiring; per-user task seeding when the flag is ON; Phase-4 counter key + kill-switch participation; guard tests; docs (`docs/scheduled-tasks.md`, CLAUDE.md env section); OpenAPI/docs:sync only if a route is added (none planned).

**Out of scope (SPEC section 8 stands, plus):** any UI; any LLM/PTY session turn (FORK-1); re-registering/starting a stopped task in the live cron registry; Phase 9's trigger, `CapHitEvent`, `REMO_CAP_QC_*` knobs; Milestone GOV items (Telegram/UI kill switch, receipts page); prod env or flag flips (owner-only cutover; this run changes none).

**Phase 9 reuse contract (build the seam, not the trigger):** Phase 9 re-targets this engine at one cause. So `engine.ts` exports `runTaskQcPass({ userId, scope?: { taskIds?: string[] }, origin })` returning `{ findings, applied, proposals }`; the digest is a separate function. Scope narrowing is the only Phase-9 hook shipped; `origin` is a plain parameter the Phase-9 trigger sets. Nothing else of Phase 9 is built.
</domain>

<decisions>
## Implementation Decisions

### Execution model and trust boundary
- **D-01 [FORK-1] Deterministic hub code, NOT an LLM session turn.** The `task_qc` sender is a hub-side function (`senders/task-qc.ts`, routed from a new `case 'task_qc'` in `routeToSender`, dispatcher.ts ~694-734). Detectors, writer and digest are code. No `dispatch()`, no `deps.send`, no PTY, no `injectOrchestratorPrompt`, no `task-macros.ts` import. SC3 "never opens a dev loop" becomes structural: the module cannot spend model tokens. Consequence: `REMO_TASK_QC_TOKEN_CAP` / TQC-07's token-ceiling acceptance are NOT shipped (no tokens to cap); replaced by a static guard (module graph imports none of `dispatch/pipeline`, `orchestrator/inject`, `task-macros`, `senders/agent`) and a test that a QC run writes zero `token_usage` rows. Phase 9 SPEC inherited-knob table must drop `REMO_TASK_QC_TOKEN_CAP` (record as spec drift; 09 is not edited here). Reversibility: costly (08-FORKS.md).
- **D-02 [FORK-2] The audit is an ordinary `scheduled_tasks` row (`task_type='task_qc'`), run through the existing cron registry + `fireTask`.** This gives the cron cadence, run history, the Phase-4 kill-switch pre-gate (dispatcher.ts 236-248, before any task_type branch), the stale-run reaper and the run-history UI for free. Per-user at-most-one row via partial unique index `idx_scheduled_tasks_task_qc_unique ON scheduled_tasks(user_id) WHERE task_type='task_qc'` (precedent: `idx_scheduled_tasks_orchestrator_unique`, schema.sql ~292). Seeded `target_kind='session'`, `session_id NULL` (column nullable, schema.sql 277), `prompt=''`, `payload='{}'`, `email_summary=false` (D-17), `catchup_policy='skip'`, cron from `REMO_TASK_QC_CADENCE_CRON`, `timezone` = user's profile tz.
- **D-03 Self-exclusion.** The audit set is `enabled=true AND task_type <> 'task_qc' AND task_type <> 'orchestrator' AND name NOT LIKE '\_\_internal\_%' AND schedule_kind='cron'`. `__internal_*` rows are `enabled=false` BY DESIGN (db/dal.ts:1614-1650; never-firing cron `0 0 31 2 *`) and must never be flagged MISCONFIGURED or NEVER_FIRED or "fixed". `orchestrator` rows are owned by the controller due-tick (`orchestrator_due_tick_owned`, dispatcher.ts ~694) and excluded. `once` tasks are excluded (they self-finalize).
- **D-04 Trigger gating order inside the sender:** (1) flag `REMO_TASK_QC_ENABLED` call-time read, OFF => finalize `skipped` `task_qc_disabled`, zero DB reads from the QC module; (2) kill switch already enforced upstream by `fireTask`, plus `haltBeforeMachineSend` re-check immediately before the first write (Phase 4 D-09c linearization); (3) one-open-run guard (D-14); (4) Phase-4 lifetime reserve (D-09). Any DB error => finalize `failed`, no partial writes (writes are one transaction per fix).

### Flags and knobs (all read at call time, never cached)
- **D-05 Flag name `REMO_TASK_QC_ENABLED`, default OFF** (`1|true|yes|on` after trim+lowercase; anything else OFF). OFF is a true no-op: no seeding at boot, no row created, no scan, no email, scheduler registration of any pre-existing `task_qc` row finalizes `skipped` (a row left behind after turning the flag off is inert). `REMO_TASK_QC_AUTOFIX` default OFF => report-only: zero `UPDATE scheduled_tasks`, every would-be fix is a proposal (disposition `proposed`, `evidence.would_fix=<kind>`). `REMO_TASK_QC_FAIL_STREAK` default 3, non-positive/non-finite/garbage => 3 (never 0). `REMO_TASK_QC_CADENCE_CRON` default `0 9 * * *`, validated by `scheduler/cron.ts validate()`; invalid or faster than hourly (two consecutive fires < 60 min apart via `nextRuns`) => default (a one-minute QC cadence is the 2026-07-11 tick-loop shape). The `REMO_TASK_QC_TOKEN_CAP` env var is NOT introduced (D-01).
- **D-06 AUTOFIX requires ENABLED.** `AUTOFIX=1` with `ENABLED=0` is OFF-no-op. Boot logs one line when ENABLED=1 and AUTOFIX=0 ("report-only soak"). No boot-refuse for these flags (they default to no-op; the refuse-to-boot pattern is for ceilings only, Phase 4 D-04).

### Detectors (`hub/src/task-qc/detectors.ts`, pure: `(inputs) => Finding[]`, no `sql` import)
- **D-07 Column mapping (the SPEC names columns that do not exist or are stale):** next fire = `next_fire_at` (authoritative; `last_run_at/next_run_at` are written alongside by `setTaskFireTimestamps`, scheduled-tasks-dal.ts:478-490, and are legacy mirrors - read `next_fire_at`/`last_fire_at`); cron = `COALESCE(cron_expr, cron_expression)`; tz = `timezone`; run finish = `finished_at` (`completed_at` is the legacy column; there is NO `ended_at`); run outcome reason = `scheduled_task_runs.error` (there is NO reason column); open run = `status IN ('running','pending','in_flight') AND finished_at IS NULL AND completed_at IS NULL`. `scheduled_task_runs.cost_usd` is written by `finalizeRun` when a run accrued model usage (dispatcher.ts, fix/run-cost-attribution); the QC engine spends no model usage, so it reads, ranks and attributes no cost (and never joins cost by timestamp). Detector inputs are plain row objects loaded by one query layer (`engine.ts`), so detectors stay pure and unit-testable without a DB.
- **D-08 FAILING:** last N (`FAIL_STREAK`) runs ordered by `started_at DESC` that have reached a terminal status are ALL `failed`. `running/pending/in_flight` are ignored (not terminal); `cancelled` is ignored; a `success` or any `skipped*` ends the streak. Evidence: run ids, distinct `error` signatures with counts, first/last `started_at`. Severity `warn`; `high` at 10x streak. Disposition always `proposed` (TQC-04: no disable fix exists).
- **D-09 SKIP_FOREVER:** last N terminal runs ALL in `{skipped, skipped_quota}` AND all carrying the SAME `error` string, AND that string is not on the frozen benign set: `no_errors_detected` (clean log_check no-op BY DESIGN; project_logcheck_classifier_401_falsepos), `automation_halted:*` (owner deliberately engaged the kill switch), `orchestrator_due_tick_owned`, `orchestrator_disabled`, `replayed_on_reconnect`. `no_application_uuid` is NOT benign (a `skipped` forever on it is the real misconfiguration; since PR #322 the sender finalizes it `skipped`, coolify.ts:69). De-dup rule: if MISCONFIGURED fires for the same task the SKIP_FOREVER finding is suppressed (one finding per root cause; MISCONFIGURED carries the skip evidence). SPEC's "and >=0 success in the window" is vacuous and dropped.
- **D-10 NEVER_FIRED:** over the D-03 audit set, fires when any of: (a) cron unparseable (`validate(cron).ok === false` or `isValidTimezone(timezone) === false`); (b) no `scheduled_task_runs` row has ever existed AND `created_at` older than 2 intervals; (c) `next_fire_at IS NULL` OR older than now minus 2 intervals, while `enabled`. Interval = gap between the next two fires from `nextRuns(expr, tz, 2)`; unparseable cron skips (b)/(c) (reported once under (a)). Last activity = `GREATEST(last_fire_at, MAX(runs.started_at))`.
- **D-11 MISCONFIGURED (per-`task_type` payload schema):** `log_check`/`log_pull` fires when the app uuid is UNRESOLVABLE by the exact resolver the sender uses (`resolveAppUuid`, senders/coolify.ts:32-50: `payload.application_uuid || payload.app_uuid`, else session -> `repo_key` -> `coolify_app_repo`). The SPEC fixture "payload without `application_uuid`" is WRONG as a bare predicate: repo-bound tasks legitimately omit it and resolve via `repo_key` (coolify.ts comment 23-31). The detector input therefore carries `resolvedAppUuid: string|null` computed by the engine through an EXPORTED `resolveAppUuid` (export it; do not re-implement). Fixture required: a payload-less log_check on a session WITH a mapped repo_key must NOT fire; one with an unmapped/NULL repo_key MUST fire. `teab` fires without `teab_repo_ident`; `work` is excluded (one-time). Other types: no payload check in v1 (only types with a real observed failure mode get one; add on evidence).
- **D-12 DEAD_SESSION:** applies only to `target_kind='session'` (effective session = `COALESCE(target_id, session_id)`); supervisor/fan-out kinds skip. Fires when the session row has `deleted_at IS NOT NULL`, or the session does not exist (hard delete cascades the task away via `ON DELETE CASCADE`, schema.sql:158, so "missing" is only reachable from stale `target_id` - which has no FK), or `status='offline'` AND `COALESCE(last_activity, created_at) < now() - interval '7 days'`. The SPEC's extra clause "no supervisor that could host it" is DROPPED [auto-default]: supervisor liveness is in-memory (`getSupervisor`, targets.ts) and a DB-only pure detector cannot see it; `last_activity` age is the durable proxy.
- **D-13 OPTIMIZE (proposal-only, never auto-fixed):** (a) cadence too hot: effective interval (D-10) <= 15 min AND >= 20 terminal runs in the window AND >= 90% of them are `skipped` with a benign reason (D-09 set) or `success` with empty `output_snippet`; (b) prompt cost: `length(prompt)` (or `payload.prompt`) in the top decile of the user's audited tasks, only when the user has >= 10 audited tasks and the length is above a 4000-char floor; (c) duplicate: two enabled audited tasks with identical `(task_type, target_kind, COALESCE(target_id,session_id), md5(prompt), payload)`. No cost figures anywhere in evidence.

### Safe-fix allowlist and writer (`hub/src/task-qc/safe-fixes.ts`)
- **D-14 One-open-run guard and write serialization.** The sender takes `pg_advisory_xact_lock(hashtext('taskqc:'||userId))` for the detection read; if another `task_qc` run for the same task is non-terminal (other than this run) it finalizes `skipped` `task_qc_already_running` and logs (TQC-01). Each fix is its own transaction: `SELECT ... FROM scheduled_tasks WHERE id=$1 FOR UPDATE`, then the in-flight check (D-16), then the UPDATE. Single-replica assumption noted (same as `spawn-on-error.ts`).
- **D-15 THE LITERAL ALLOWLIST (frozen, enumerated; anything else throws `unlisted_fix_kind` before any SQL):**
  ```
  // SUPERSEDED at plan time (2026-10-13): three kinds. recompute_next_run_at is a PROPOSAL, not a fix
  // (see Planner decisions). Shipped as a closure-backed read-only structure, not a bare Set.
  export const SAFE_FIXES = Object.freeze(new Set([
    'normalize_timezone',
    'backfill_payload_from_sibling',
    'rebind_dead_session',
  ] as const))
  ```
  - (SUPERSEDED, not shipped as a fix) `recompute_next_run_at`: only for a NEVER_FIRED finding (b/c) with a valid cron+tz. Computes next fire from `nextRuns(expr, tz, 1)` and writes `next_fire_at` + `next_run_at` (the pair `setTaskFireTimestamps` writes) and nothing else. It does NOT touch the live croner registry (`registry.replace`) and does NOT touch `enabled`: re-registering a never-fired task would start spend, which is a cadence/spend change (out of scope, section 8). Honest limitation, documented: the registry rewrites these columns on its next (re)register, so this fix is a DB-truth repair, not a scheduler repair; unregistered-job cases surface as a proposal ("restart/replace the job") instead.
  - `normalize_timezone`: only when `isValidTimezone(timezone)` is false; sets `timezone` to `users.timezone` (gates.ts:72) when that is valid, else `'UTC'`. NOT NULL/default `'UTC'` means the SPEC's "when NULL" case is unreachable.
  - `backfill_payload_from_sibling`: only for MISCONFIGURED log_check/log_pull with an unresolvable uuid, only when EXACTLY ONE distinct non-empty `application_uuid` exists across the user's other enabled log_check/log_pull tasks on the SAME `session_id` (or same non-NULL `sessions.repo_key`). Zero or >=2 distinct candidates => PROPOSAL, zero writes. Writes `payload = payload || jsonb_build_object('application_uuid', $v)` only.
  - `rebind_dead_session`: only for DEAD_SESSION; candidate = the user's sessions with the SAME non-NULL `repo_key` as the dead session, live defined as `deleted_at IS NULL AND status IN ('online','thinking')`; EXACTLY ONE candidate, else PROPOSAL. Rewrites `session_id` (and `target_id` iff `target_id = old session id`) in one UPDATE. Never touches `enabled`, `prompt`, `cron*`.
  - Explicitly NOT on the list and un-addable by construction: `disable_task`, `enable_task`, `edit_prompt`, `change_cadence`, `delete_task`, `create_task`, `raise_cap`, `set_env`, `set_enabled`. The writer's only SQL is four fixed `UPDATE scheduled_tasks SET <fixed column list>` templates (no string-built column names). The TQC-04 static guard greps `hub/src/task-qc/` for `enabled` inside any `UPDATE scheduled_tasks` and for the identifiers `registry.`, `dispatch(`, `injectOrchestratorPrompt`.
- **D-16 In-flight refusal (TQC-06):** before each write, inside the FOR UPDATE tx: any open run (D-07 definition) for that `task_id`, OR any open `scheduled_task_runs` row whose `session_id` equals the task's effective session (another task live on the same session), => no write, disposition `skipped_in_flight`, a proposal with reason `in_flight`. The live in-memory `inFlightByRun` map is deliberately not consulted (DB truth only; the writer module must stay importable without the dispatcher).
- **D-17 Audit trail + rollback.** Every applied fix inserts a `task_qc_findings` row IN THE SAME TRANSACTION as the UPDATE (`disposition='auto_fixed'`, `fix_kind`, `before_json`, `after_json` over exactly the changed columns, `rollback_sql`). `rollback_sql` is stored text a human can run: `UPDATE scheduled_tasks SET <col> = <literal> ... WHERE id = '<id>' AND <col> IS NOT DISTINCT FROM <after-literal>` (guarded so it no-ops if the row changed since); literals produced by one tested `sqlLiteral()` helper (single-quote doubling, `NULL`, `::jsonb` casts); the hub never executes it. Proposals and in-flight skips also get rows (`disposition` `proposed` / `skipped_in_flight`).
- **D-18 Idempotent findings.** A re-run must not multiply rows for an unchanged condition: unique natural key `(user_id, task_id, detector, evidence_sig, day)` via `evidence_sig = sha256(detector + stable evidence)` and `INSERT ... ON CONFLICT DO NOTHING` per user-tz day. The digest is built from the run's in-memory result, not by re-reading the table.

### Digest email
- **D-19 One digest per run, only when findings exist.** Path: `hub/src/lib/email.ts sendEmail` (E4A; the send field there is `from_inbox_id`, line 22 - NOT `inbox_id`) to `users.email`. Same direct-sendEmail precedent as the Phase-4 token-cap alarm (04-CONTEXT D-13). `email_summary=false` on the seeded task (the default per-run email in `buildDefaultEmailActions`, post-run/dispatcher.ts:80-90, would otherwise mail "success" daily and violate TQC-05 zero-findings-zero-email). Body: ASCII-only (global 7b), one block per finding (detector, task name+id, evidence, disposition, proposed fix, exact SQL/command to apply), plus an "Applied automatically" section listing each auto-fix with its rollback SQL. `sendEmail` returns false without throwing on missing E4A env/non-2xx: the run finalizes `success` with `output_snippet` carrying `digest_delivered=false` and a WARN log; no retry loop (event-driven, no polling).
- **D-20 QC-engine failure is not silent.** Because `email_summary=false` also suppresses the generic failure email, the sender itself sends ONE plain failure email per (user, UTC day) when the engine throws (claim row in `task_qc_findings` with `detector='ENGINE'`, `disposition='proposed'`, unique per day). Failure of the auditor must not be invisible.

### Phase-4 counter and kill switch
- **D-21 Kill switch:** inherited from `fireTask` (dispatcher.ts 236-248) for the cron fire; the engine re-checks `isAutomationHalted({userId})` immediately before its first write (D-04) and a halted state yields a read-only/report-only run: detection may complete, ZERO writes, digest still sent. The QC sender never calls `reserve` on the human path (no human path exists).
- **D-22 Counter key policy for QC (resolves the Phase-4 deferral):** counter key `taskqc:<userId>` (plain TEXT; ledger has no FK). One `reserveInject({ userId, sessionId: key, token: <run id>, counterKey: key, actor: 'task-qc' })` per run, taken after the kill-switch check and before any write; fail closed (`!ok` => finalize `skipped` with the returned reason, e.g. `lifetime_inject_exhausted:<n>>=<cap>`, no detection writes). Cap = the shared `REMO_AUTOMATION_LIFETIME_INJECT_CAP` (1000, ~2.7 years at daily cadence; no new knob). Rationale: a deterministic run injects nothing into a session, but the ledger is the only durable per-key budget and the incident class is "an unattended timer that never stops"; bounding RUNS bounds a mis-set cadence and the digest volume. Owner reset = existing `POST /api/automation/lifetime/reset {counter_key}`. `releaseInject` is called if the run fails before any detection (a crashed start does not burn budget). The reserve happens in the SENDER, not in `dispatch()` (QC does not use the pipeline); the Phase-4 session-start/sender pin tests classify `senders/task-qc.ts` as a machine sender with an explicit exemption line (no `session.start`).
- **D-23 Kill-switch/counter blocks are BENIGN to SKIP_FOREVER** (`automation_halted:*` already benign; add `lifetime_inject_exhausted:*` as benign for the QC task's own rows - moot because D-03 excludes `task_qc`).

### Schema (idempotent, additive; `tools/schema-sql-lint.ts` fence applies)
- **D-24 DDL:** (1) add `'task_qc'` to the EXISTING `scheduled_tasks_task_type_check` list in place (schema.sql ~205-228; it is already a `DROP CONSTRAINT IF EXISTS` + `ADD CONSTRAINT`, so editing the IN-list is the established idempotent form - no second constraint, no new UPDATE). (2) `CREATE UNIQUE INDEX IF NOT EXISTS idx_scheduled_tasks_task_qc_unique`. (3) `CREATE TABLE IF NOT EXISTS task_qc_findings` per SPEC section 5, with `user_id UUID REFERENCES users ON DELETE CASCADE` kept, plus `evidence_sig TEXT NOT NULL`, `day DATE NOT NULL`, unique index `(user_id, task_id, detector, evidence_sig, day)`, and a CHECK on `detector` incl. `ENGINE` and on `disposition`. No INSERT/UPDATE/DELETE in schema.sql. The seed row is created by `seed.ts` at boot (flag ON) and lazily, never by DDL.
- **D-25 TS enum sync:** the task_type literal union is duplicated in `db/scheduled-tasks-dal.ts:17-26`, `api/scheduled-tasks.ts:53` (zod), `scheduler/auto-name.ts:20`; all three gain `'task_qc'`. The API create path must REJECT user-created `task_qc` (it is machine-seeded only) and must reject user edits of its `payload`/`prompt`; cron edits re-validated against D-05's floor. `db/scheduled-tasks-dal.ts` list queries used by the UI keep returning the row (visible, owner may disable it - disabling the QC task is the owner's call and is honoured).

### Tests (names from SPEC section 6 stand; additions)
- **D-26** Add: `task-qc-sender-wiring.test.ts` (flag OFF => `skipped task_qc_disabled`, zero QC-module `sql` calls; routed from `routeToSender`), `task-qc-counter.test.ts` (reserve per run, exhausted => skipped, release on early failure, kill-switch => zero writes), `task-qc-no-llm-guard.test.ts` (module-graph + zero `token_usage` rows). E2E `hub/test/e2e/task-qc.test.ts` MUST run on real postgres:16 (Woodpecker); memory `reference_pglite_vs_postgres_e2e_divergence`: local PGlite is lax about NOT NULL/search_path/constraint re-apply - the CHECK rewrite and partial unique index get an explicit real-PG assertion. No new skipped tests (skip baseline 259 vs `skip_max` 260).

### Auto-defaults (cheap, reversible, chosen without a panel)
- **A-01** `evidence_sig` + per-day idempotency (D-18). **A-02** `rollback_sql` guarded form + `sqlLiteral()` (D-17). **A-03** DEAD_SESSION 7-day proxy via `last_activity` (D-12). **A-04** OPTIMIZE thresholds: <=15 min, >=20 runs, >=90%, top decile only with >=10 tasks and 4000-char floor (D-13). **A-05** Cadence floor 60 min and invalid-cron => default (D-05). **A-06** ENGINE failure email once per user-day (D-20). **A-07** Digest lists every open finding every run (SPEC-literal); suppression of unchanged proposals is deferred. **A-08** Seeding: boot hook `seedTaskQcTasks()` runs only when ENABLED=1, creates the row for each user with >= 1 audited task, idempotent via the unique index (`ON CONFLICT DO NOTHING`), plus lazy create on first flag-on fire attempt is NOT done (boot only; a user created later is picked up on next boot - acceptable for a single-owner deployment, revisit on evidence). **A-09** Findings severity is informational metadata only; nothing branches on it except the digest ordering (high first). **A-10** `severity` set `info|warn|high`.
</decisions>

<spec_drift>
## SPEC drift (the SPEC is wrong or stale here; this file supersedes)

| SPEC says | Reality (file:line) | Resolution |
|---|---|---|
| `last_run_at`/`next_run_at` drive NEVER_FIRED | `next_fire_at`/`last_fire_at` are authoritative; legacy pair is mirrored (scheduled-tasks-dal.ts:478-490, schema.sql 239-240) | D-07/D-10 |
| open run = `ended_at IS NULL` | no `ended_at`; `finished_at` + legacy `completed_at`; statuses `running,pending,in_flight` (schema.sql 446-456, 973-976) | D-07/D-16 |
| skip "reason" | no reason column; reason is `scheduled_task_runs.error` | D-07/D-09 |
| MISCONFIGURED: log_check payload without `application_uuid` | repo-bound tasks omit it and resolve via `sessions.repo_key` -> `coolify_app_repo` (senders/coolify.ts:32-50); bare check = false positive | D-11 |
| `normalize_timezone` "when NULL" | `timezone TEXT NOT NULL DEFAULT 'UTC'` (schema.sql 235): only invalid IANA names are reachable | D-15 |
| DEAD_SESSION "deleted session" | hard delete cascades the task (`session_id ... ON DELETE CASCADE`); soft delete is `sessions.deleted_at`; `target_id` has no FK | D-12 |
| "no supervisor could host it" | supervisor liveness is in-memory only | dropped, D-12 |
| `REMO_TASK_QC_TOKEN_CAP` / TQC-07 token ceiling | deterministic engine spends zero tokens | D-01 (FORK-1); 09-SPEC inherited table rewritten in plan 08-10 |
| extend `task_type` CHECK "like Phase-11" | the CHECK is already drop+add in place with one IN-list (schema.sql 205-228) | edit the list (D-24) |
| existing `task_type='qc'` | UNRELATED auto-dev QC workflow root (`qc_review/qc_fix/qc_verify`, workflows.ts:32); new value is `task_qc` | name kept distinct; never reuse `qc` |
</spec_drift>

<code_map>
## Existing Code Map

| Concern | Location |
|---|---|
| Scheduled task + run schema | `hub/src/db/schema.sql:156-169` (base), `176-228` (task_type CHECK drop/add), `230-343` (additive cols, nullable session_id 277, orchestrator unique idx ~292), `446-486` (runs), `973-976` (status CHECK), `70` / `983` (sessions.deleted_at / repo_key) |
| Phase-4 tables | `schema.sql:1600-1642` (`automation_inject_ledger`, `automation_kill_switch`) |
| Fire path / kill-switch pre-gate | `hub/src/scheduler/dispatcher.ts:236-248` (halt), `283-328` (quota/cost skips), `636-648` (at_capacity skip), `664-669` (`updateFireTimestamps`), `694-734` (`routeToSender` switch: add `case 'task_qc'`), `finalizeRun` ~744+ |
| Sender precedents | `hub/src/scheduler/senders/coolify.ts:32-50` (`resolveAppUuid`, export it), `:69` (`no_application_uuid` skip); `senders/triage.ts`, `senders/work.ts` (non-session senders) |
| Registry / cron | `scheduler/registry.ts:36-130,187` (`nextRunFor`, `setTaskFireTimestamps` callers), `scheduler/cron.ts:23` (`validate`), `:38` (`nextRuns`), `:106` (`isValidTimezone`) |
| Run reaper | `scheduler/run-reaper.ts` (pending > `REMO_RUN_MAX_MS` => `run_timeout`; QC runs finish in-process so never reach it) |
| Post-run default email (suppressed via `email_summary=false`) | `scheduler/post-run/dispatcher.ts:80-90` |
| Direct email | `hub/src/lib/email.ts:12-37` (`from_inbox_id`, returns false, never throws) |
| User tz | `hub/src/dispatch/gates.ts:72-77` (`userTimezone`, module-private; reimplement as a one-line query in `task-qc`, do not export gates internals) |
| Counter / kill switch API | `hub/src/dispatch/automation-controls.ts:132` (`isAutomationHalted`), `:171` (`haltBeforeMachineSend`), `:363` (`reserveInject`), `:427` (`releaseInject`), `:499` (`resetLifetimeCounter`), `:56` (`lifetimeInjectCap`); heal key precedent `api/sessions.ts:403-416` (`heal:<userId>:<repo>`) |
| Internal anchor rows | `hub/src/db/dal.ts:1614-1650` (`__internal_*`, enabled=false) |
| Task DAL + type union | `hub/src/db/scheduled-tasks-dal.ts:17-26,257-317 (createTaskV2),478` |
| API zod enum | `hub/src/api/scheduled-tasks.ts:53` |
| Gate coverage scans | `hub/test/token-cap-coverage.test.ts` (scans `gates: [`; QC adds none - assert in guard test), `tools/schema-sql-lint.ts` |
| Docs to update in the same commit | `docs/scheduled-tasks.md`, `CLAUDE.md` env section (4 knobs), `docs/usage-cost.md` (counter key `taskqc:`) |
</code_map>

<traceability>
## SC1-5 Traceability

| Roadmap SC | Delivered by | Proof |
|---|---|---|
| SC1 six detectors, real rows, no writes | D-07..D-13 | `task-qc-detectors.test.ts` (fixture fire + no-fire per detector; real unresolvable-uuid log_check; mapped-repo_key log_check does NOT fire; `__internal_*` ignored; `sql` spy = 0 writes) |
| SC2 literal allowlist, unlisted impossible | D-15 | `task-qc-safe-fixes.test.ts` (`applyFix({kind:'disable_task'|'edit_prompt'|'raise_cap'|'set_env'})` throws `unlisted_fix_kind`, zero SQL; 2 siblings => proposal) + frozen-set assertion |
| SC3 never auto-disables / never mutates in-flight / never a dev loop, own small ceiling | D-14, D-16, D-01, D-22 | `task-qc-never-disables.test.ts` (grep guard + 500-failure fixture stays enabled), `task-qc-in-flight.test.ts`, `task-qc-no-llm-guard.test.ts`; "own ceiling" is satisfied structurally (zero tokens) + bounded runs via the lifetime counter - the literal 500K knob is superseded (FORK-1) |
| SC4 digest email with proposal per finding | D-19, D-20 | `task-qc-proposals.test.ts` (one email, zero `UPDATE`s; zero findings => zero emails; body names every finding and applied fix) |
| SC5 flag-gated OFF, empty allowlist => report-only | D-05, D-06 | `task-qc-flag-off.test.ts` (OFF: zero reads/emails/registration), AUTOFIX=0 e2e: zero `UPDATE scheduled_tasks` |
</traceability>

<deferred>
## Deferred Ideas

- Suppressing unchanged proposals in the digest (repeat-count / weekly cadence for stale findings) - revisit after the report-only soak.
- An LLM-written OPTIMIZE narrative or smarter prompt-cost analysis - would reopen FORK-1 and re-introduce a token ceiling; only on evidence.
- Growing the allowlist (cadence, prompt) - from a month of digests, via a new phase.
- Re-registering a never-fired job in the live croner registry (needs a spend-aware decision) - proposal text only for now.
- Per-user lazy seeding for users created after boot - boot-only seeding is enough for a single-owner deployment.
- Telegram/UI delivery of the digest, receipts page, kill-switch UI - Milestone GOV.
- Phase 9 trigger wiring, `CapHitEvent`, `REMO_CAP_QC_*` - Phase 9 (consumes `runTaskQcPass`'s `scope`; its SPEC must drop the QC token-cap row).
- Fixing `09-SPEC.md` inherited-knob table and `08-SPEC.md` TQC-07 text - doc follow-up in the Phase 8 closeout commit, not here.

## Risks carried into planning

1. FORK-1/FORK-2 overturned by the panel => D-01/D-02 and the sender/seed design change; costly to reverse after code lands (enum + table).
2. RESOLVED (plan time, see Planner decisions): `recompute_next_run_at` is a DB-truth repair only (registry rewrites it) - low value; dropped to a proposal if the planner confirms no path where a registered job leaves a stale column (planner re-verify, registry.ts:115-130,187).
3. CHECK rewrite + partial unique index behave differently on PGlite vs postgres:16 (memory). Real-PG e2e is mandatory.
4. `email_summary=false` hides a QC row failure unless D-20 lands - keep D-20 in the plan, not optional.
5. `reserveInject` counts a non-inject as an inject; ledger/`countRateUnion` semantics for a key that is not a session id - planner confirms `sessionId: key` does not pollute the per-session rate union (heal key precedent uses the same shape).
</deferred>

*Phase: 8-periodic-task-qc*
*Context gathered: 2026-10-13*

## Planner decisions (2026-10-13)

Recorded by plan 08-10 from the plan 01-09 SUMMARY files, so a later reader does not re-open them.

- **`recompute_next_run_at` is a proposal, not a fix.** Evidence: `next_fire_at` mirrors the live in-memory registry (registry.ts register path writes it; dispatcher `updateFireTimestamps` rewrites it after every fire). A stale or NULL value on an enabled valid-cron task therefore means the job is not armed; rewriting the column in the database would hide that signal and the condition would re-fire every cycle. NEVER_FIRED (b)/(c) carry the `reregister_job` proposal (PATCH `{enabled:true}` re-arms through the route). The allowlist is three kinds.
- **Digit-collapse in the SKIP_FOREVER reason signature.** A `skipped_quota` reason with a changing figure still groups as one reason.
- **NEVER_FIRED age gate.** The NULL/stale `next_fire_at` arm only applies once the task is older than two fire intervals, so a freshly created task is not flagged.
- **Flag-OFF early return sits ahead of the kill-switch block** at the top of `fireTask`. It performs no automation, so it cannot weaken the kill switch, and OFF stays a true no-op even when the system is halted.
- **Injected halt check on the engine.** Auto-fix without a halt check throws `halt_check_required`; the check is consulted once immediately before the first write, and a halted pass is read-only (findings returned as proposals, reason `halted_read_only`).
- **Pass bounds are constants, not env knobs.** `TASK_QC_BOUNDS` is frozen; `clampBounds` can only lower values. There is no token-cap knob (verdict F1-A1).
- **Release-on-throw simplification of D-22.** The sender reserves one `taskqc:<userId>` slot per run and releases it if the engine throws, rather than only when the run fails before detection.
- **session_id nullability (F2-B2).** Verified `scheduled_tasks.session_id` is nullable (schema.sql DROP NOT NULL); the seeded row binds no session, so deleting a session cannot cascade-delete the auditor and a session-scoped kill-switch row never matches it.
- **Digest content.** The digest mails applied fixes plus newly recorded findings (not every open finding), so an already-recorded same-day finding re-sends nothing.
- **Cost statement (F1-A6).** `finalizeRun` writes run cost when a run accrued model usage; QC reads no cost because it spends none.
