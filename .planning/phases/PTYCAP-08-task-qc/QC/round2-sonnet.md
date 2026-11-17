# PTYCAP-08 QC round 2 - adversary + correctness (sonnet)

Method: static diff review of `f26f564..HEAD` plus per-file runs of task-qc-deadline (7), task-qc-in-flight (9), task-qc-api-guards (38), task-qc-schema (8): all pass, 0 fail. No live Postgres available.

## Round-1 CRITICAL/MAJOR status

| # | Finding | Status | Evidence |
|---|---------|--------|----------|
| 1 | PATCH converts a user task into task_qc (codex, correctness, adversary) | FIXED | bace778, `hub/src/api/scheduled-tasks.ts` returns 400 `task_qc_machine_seeded` before any write; 4 red-first cases in task-qc-api-guards.test.ts |
| 2 | Wall-clock bound not hard (codex MAJOR 2) | FIXED | `makeDeadlineArmer` (`hub/src/task-qc/findings.ts:145`) does `SET LOCAL statement_timeout` as the first statement of each QC tx; 57014/55P03 treated as truncation (`engine.ts` try/catch at each `inTx` / `applyFix`); task-qc-deadline.test.ts |
| 3 | Shared-session in-flight TOCTOU (codex MAJOR 3) | FIXED (static + fake only) | writer takes `pg_advisory_xact_lock(hashtext('taskqc-session:'||sid))` after the row lock and before the probe (`safe-fixes.ts` ~L204); BEFORE INSERT trigger on scheduled_task_runs takes the same key (`schema.sql` ~L1712). Tests assert order and the identical key, but only over the fake; the real-Postgres barrier test is owed (fixes.md says so). |

## Specific questions

1. Flag OFF "true no-op"? NO, strictly not. The trigger is unconditional schema DDL. Every `scheduled_task_runs` INSERT with a non-NULL `session_id` (`insertRunV2`, `scheduled-tasks-dal.ts:517`) now runs a plpgsql call and takes an advisory xact lock, regardless of the flag. Cost is microseconds and uncontended, so it is not a latency or correctness problem. Contention exists only while a QC fix tx holds the same session's lock, and the flag-OFF path never runs a fix. Behaviourally it is a no-op, but the "flag OFF = true no-op" wording is not literally true. Severity MINOR (doc/claim accuracy). Fix: say "no behavioural change when OFF; one uncontended advisory lock per session-bound run insert" in docs/scheduled-tasks.md. A flag-gated trigger would need a runtime check inside the function and would defeat the purpose.
2. DDL idempotent every boot? Yes. `CREATE OR REPLACE FUNCTION` and `CREATE OR REPLACE TRIGGER` (needs PG14+; CI uses postgres:16, ok). `splitSqlStatements` handles the `$$` body. `ADD COLUMN IF NOT EXISTS` for `digest_sent_at` is also fine. Note: `CREATE OR REPLACE TRIGGER` takes a SHARE ROW EXCLUSIVE lock on `scheduled_task_runs` for the statement each boot. That is brief (DDL only, no rewrite) and acceptable.
3. Deadlock? None found. All run inserts are single-statement autocommit (`insertRunV2`, `insertDeploymentRun` has NULL session so it skips the lock, `claimTaskQcRun` has NULL session). So no existing code holds other locks while the trigger waits. Only the QC fix tx holds the session lock plus a task row lock. `FOR NO KEY UPDATE` avoids conflict with the FK KEY SHARE taken by a concurrent run insert, so the order (insert: session lock then FK share on task; fix: task NO KEY lock then session lock) cannot cycle. The one-lock-per-tx design also rules out AB/BA between two fixes.
4. statement_timeout: `SET LOCAL` inside `q.begin` / `db.begin`, so it dies at commit or rollback and cannot leak onto the pooled connection. Remaining is floored to an integer and throws when <= 0, so it never becomes `0` (which would mean unlimited). Fine. The `.unsafe()` string is a numeric interpolation of a `Math.floor` result, so no injection surface.

## New findings

- MINOR: flag-OFF claim wording (see 1) - docs only.
- MINOR: `isDeadlineError` treats 55P03 as a deadline, but nothing in task-qc uses NOWAIT or lock_timeout, so that branch is dead (harmless).
- MINOR (carried): real-Postgres barrier test for the trigger and lock race still owed to CI; the fix is only fake-verified.

No new CRITICAL or MAJOR defects.

## Verdict: PASS
