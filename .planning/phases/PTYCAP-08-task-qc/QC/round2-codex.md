codex
## Round-1 findings

1. **FIXED — MAJOR: ordinary task could be converted to `task_qc`.**  
   The PATCH path now rejects `task_type: "task_qc"` unless the existing row is already `task_qc`, before any update or registry operation: [scheduled-tasks.ts:516](C:/Users/artic/GitHub/remo-code-ptycap08/hub/src/api/scheduled-tasks.ts:516). Four transition cases are covered at [task-qc-api-guards.test.ts:300](C:/Users/artic/GitHub/remo-code-ptycap08/hub/test/task-qc-api-guards.test.ts:300).

2. **NOT-FIXED — MAJOR: the wall-clock deadline is still not hard.**  
   `SET LOCAL statement_timeout` is correctly transaction-scoped, so it does not leak when a pooled connection is returned. However:

   - `q.begin()` must first acquire a pooled connection before the callback can arm the timeout: [engine.ts:82](C:/Users/artic/GitHub/remo-code-ptycap08/hub/src/task-qc/engine.ts:82), [load.ts:76](C:/Users/artic/GitHub/remo-code-ptycap08/hub/src/task-qc/load.ts:76).
   - A fix transaction arms only once, then executes the row lock, advisory lock, probes, update, and finding insert under the same value: [safe-fixes.ts:182](C:/Users/artic/GitHub/remo-code-ptycap08/hub/src/task-qc/safe-fixes.ts:182). PostgreSQL applies `statement_timeout` separately to each statement, so several individually sub-timeout statements can cumulatively exceed the pass deadline. [PostgreSQL documentation](https://www.postgresql.org/docs/16/runtime-config-client.html)
   - `haltCheck()` remains an unbounded await: [engine.ts:158](C:/Users/artic/GitHub/remo-code-ptycap08/hub/src/task-qc/engine.ts:158).

   Fix: make connection acquisition deadline-aware, race/cancel `haltCheck`, and re-arm with the remaining time before every statement in `applyFix`. Do not use a bare `Promise.race` around a write transaction unless the losing transaction is actually cancelled.

3. **FIXED for the reported shared-session race — MAJOR.**  
   The writer acquires the per-session advisory lock before probing: [safe-fixes.ts:198](C:/Users/artic/GitHub/remo-code-ptycap08/hub/src/task-qc/safe-fixes.ts:198). Session-bound run inserts take the identical lock in a `BEFORE INSERT` trigger: [schema.sql:1712](C:/Users/artic/GitHub/remo-code-ptycap08/hub/src/db/schema.sql:1712). Under read-committed semantics, the insert either commits before the probe or waits until the fix transaction finishes. A separate newly introduced null-session hole is reported below.

4. **NOT-FIXED — MINOR: long skip reasons still collapse.**  
   Equality is still computed after `safeText` truncation: [detectors.ts:64](C:/Users/artic/GitHub/remo-code-ptycap08/hub/src/task-qc/detectors.ts:64).  
   Fix: canonicalize/hash the complete reason for comparison and truncate only rendered evidence.

5. **NOT-FIXED — MINOR: target-only dead-session rollback remains a no-op.**  
   The remediation still guards solely on `session_id`, although detection uses `target_id ?? session_id`: [digest.ts:132](C:/Users/artic/GitHub/remo-code-ptycap08/hub/src/task-qc/digest.ts:132).  
   Fix: guard both stale bindings, or generate the guard matching the column that contained the stale ID.

6. **NOT-FIXED — MINOR: ignored runs still consume the history bound.**  
   SQL ranks all statuses before applying the limit: [load.ts:101](C:/Users/artic/GitHub/remo-code-ptycap08/hub/src/task-qc/load.ts:101), while filtering happens only after the slice: [detectors.ts:87](C:/Users/artic/GitHub/remo-code-ptycap08/hub/src/task-qc/detectors.ts:87).  
   Fix: limit counted terminal statuses in SQL and load a separate existence signal for `NEVER_FIRED`.

## New defects

1. **MAJOR — the unconditional trigger violates flag-OFF true-no-op behavior.**  
   [schema.sql:1712](C:/Users/artic/GitHub/remo-code-ptycap08/hub/src/db/schema.sql:1712), [flags.ts:29](C:/Users/artic/GitHub/remo-code-ptycap08/hub/src/task-qc/flags.ts:29)

   Once the schema is applied, every session-bound `scheduled_task_runs` insert executes `pg_advisory_xact_lock`, regardless of `REMO_TASK_QC_ENABLED` or `REMO_TASK_QC_AUTOFIX`. Thus disabling Task QC does not restore pre-feature runtime behavior, and ordinary scheduler traffic can still block on Task-QC lock keys.

   Fix: remove the global trigger. Put lock acquisition and run insertion in a shared transactional insertion helper enabled only while autofix is active, and route every open-run creation path through it.

2. **MAJOR — weakening the row lock creates a new own-task race for null-session runs.**  
   [safe-fixes.ts:185](C:/Users/artic/GitHub/remo-code-ptycap08/hub/src/task-qc/safe-fixes.ts:185), [schema.sql:1714](C:/Users/artic/GitHub/remo-code-ptycap08/hub/src/db/schema.sql:1714), [dispatcher.ts:598](C:/Users/artic/GitHub/remo-code-ptycap08/hub/src/scheduler/dispatcher.ts:598)

   `FOR UPDATE` was changed to `FOR NO KEY UPDATE`, which no longer blocks the FK key-share taken by a concurrent run insert. The replacement trigger locks only when `NEW.session_id` is non-null. Supervisor/all-supervisor runs are inserted with `session_id = NULL`, so they take no matching trigger lock and can commit after the own-run probe but before the QC update. The writer can therefore mutate a task while its own run is open.

   Fix: serialize every open-run insert on a per-task key, including null-session runs, with a fixed order such as task key → optional session key → row lock/probes. Add a real-Postgres barrier test for both session-bound and null-session targets.

3. **MAJOR — digest truncation marks findings that were never shown as delivered.**  
   [task-qc.ts:117](C:/Users/artic/GitHub/remo-code-ptycap08/hub/src/scheduler/senders/task-qc.ts:117), [digest.ts:220](C:/Users/artic/GitHub/remo-code-ptycap08/hub/src/task-qc/digest.ts:220)

   The renderer can omit findings because of the 100,000-character limit or 200-finding cap, but after any successful email the sender marks every `recordedId` delivered. Omitted findings then stop being re-reported that day despite never appearing in the digest.

   Fix: have digest construction return the finding-row IDs actually rendered and mark only those. A simpler safe fallback is to mark none whenever the digest reports omitted findings.

## Requested implementation judgments

- **DDL idempotency:** acceptable on the repository’s PostgreSQL 16 target. `CREATE OR REPLACE TRIGGER` replaces rather than duplicates the trigger, and `ADD COLUMN IF NOT EXISTS` is convergent. [PostgreSQL `CREATE TRIGGER`](https://www.postgresql.org/docs/16/sql-createtrigger.html)
- **Deadlock risk:** the intended session-bound row/FK ordering does not itself form a cycle: `BEFORE INSERT` runs before constraints, and `FOR NO KEY UPDATE` is compatible with FK key-share. The blocking and null-session correctness problems above remain. [PostgreSQL trigger timing](https://www.postgresql.org/docs/16/sql-createtrigger.html), [row-lock modes](https://www.postgresql.org/docs/16/explicit-locking.html)
- **Pooled `statement_timeout`:** `SET LOCAL` is the correct non-leaking choice because it expires at transaction end, and the scoped transaction handle uses one reserved connection. The defects are unbounded pool acquisition and failure to re-arm multi-statement fix transactions—not session-setting leakage. [PostgreSQL `SET LOCAL`](https://www.postgresql.org/docs/16/sql-set.html), [Postgres.js transactions](https://github.com/porsager/postgres#transactions)

The focused seven-file Bun test run could not execute because the managed read-only environment returned `EPERM` while Bun opened the test files; `git diff --check` was clean and no files were modified.

## FINAL VERDICT: CONTENT-BLOCK
190,433
## Round-1 findings

1. **FIXED — MAJOR: ordinary task could be converted to `task_qc`.**  
   The PATCH path now rejects `task_type: "task_qc"` unless the existing row is already `task_qc`, before any update or registry operation: [scheduled-tasks.ts:516](C:/Users/artic/GitHub/remo-code-ptycap08/hub/src/api/scheduled-tasks.ts:516). Four transition cases are covered at [task-qc-api-guards.test.ts:300](C:/Users/artic/GitHub/remo-code-ptycap08/hub/test/task-qc-api-guards.test.ts:300).

2. **NOT-FIXED — MAJOR: the wall-clock deadline is still not hard.**  
   `SET LOCAL statement_timeout` is correctly transaction-scoped, so it does not leak when a pooled connection is returned. However:

   - `q.begin()` must first acquire a pooled connection before the callback can arm the timeout: [engine.ts:82](C:/Users/artic/GitHub/remo-code-ptycap08/hub/src/task-qc/engine.ts:82), [load.ts:76](C:/Users/artic/GitHub/remo-code-ptycap08/hub/src/task-qc/load.ts:76).
   - A fix transaction arms only once, then executes the row lock, advisory lock, probes, update, and finding insert under the same value: [safe-fixes.ts:182](C:/Users/artic/GitHub/remo-code-ptycap08/hub/src/task-qc/safe-fixes.ts:182). PostgreSQL applies `statement_timeout` separately to each statement, so several individually sub-timeout statements can cumulatively exceed the pass deadline. [PostgreSQL documentation](https://www.postgresql.org/docs/16/runtime-config-client.html)
   - `haltCheck()` remains an unbounded await: [engine.ts:158](C:/Users/artic/GitHub/remo-code-ptycap08/hub/src/task-qc/engine.ts:158).

   Fix: make connection acquisition deadline-aware, race/cancel `haltCheck`, and re-arm with the remaining time before every statement in `applyFix`. Do not use a bare `Promise.race` around a write transaction unless the losing transaction is actually cancelled.

3. **FIXED for the reported shared-session race — MAJOR.**  
   The writer acquires the per-session advisory lock before probing: [safe-fixes.ts:198](C:/Users/artic/GitHub/remo-code-ptycap08/hub/src/task-qc/safe-fixes.ts:198). Session-bound run inserts take the identical lock in a `BEFORE INSERT` trigger: [schema.sql:1712](C:/Users/artic/GitHub/remo-code-ptycap08/hub/src/db/schema.sql:1712). Under read-committed semantics, the insert either commits before the probe or waits until the fix transaction finishes. A separate newly introduced null-session hole is reported below.

4. **NOT-FIXED — MINOR: long skip reasons still collapse.**  
   Equality is still computed after `safeText` truncation: [detectors.ts:64](C:/Users/artic/GitHub/remo-code-ptycap08/hub/src/task-qc/detectors.ts:64).  
   Fix: canonicalize/hash the complete reason for comparison and truncate only rendered evidence.

5. **NOT-FIXED — MINOR: target-only dead-session rollback remains a no-op.**  
   The remediation still guards solely on `session_id`, although detection uses `target_id ?? session_id`: [digest.ts:132](C:/Users/artic/GitHub/remo-code-ptycap08/hub/src/task-qc/digest.ts:132).  
   Fix: guard both stale bindings, or generate the guard matching the column that contained the stale ID.

6. **NOT-FIXED — MINOR: ignored runs still consume the history bound.**  
   SQL ranks all statuses before applying the limit: [load.ts:101](C:/Users/artic/GitHub/remo-code-ptycap08/hub/src/task-qc/load.ts:101), while filtering happens only after the slice: [detectors.ts:87](C:/Users/artic/GitHub/remo-code-ptycap08/hub/src/task-qc/detectors.ts:87).  
   Fix: limit counted terminal statuses in SQL and load a separate existence signal for `NEVER_FIRED`.

## New defects

1. **MAJOR — the unconditional trigger violates flag-OFF true-no-op behavior.**  
   [schema.sql:1712](C:/Users/artic/GitHub/remo-code-ptycap08/hub/src/db/schema.sql:1712), [flags.ts:29](C:/Users/artic/GitHub/remo-code-ptycap08/hub/src/task-qc/flags.ts:29)

   Once the schema is applied, every session-bound `scheduled_task_runs` insert executes `pg_advisory_xact_lock`, regardless of `REMO_TASK_QC_ENABLED` or `REMO_TASK_QC_AUTOFIX`. Thus disabling Task QC does not restore pre-feature runtime behavior, and ordinary scheduler traffic can still block on Task-QC lock keys.

   Fix: remove the global trigger. Put lock acquisition and run insertion in a shared transactional insertion helper enabled only while autofix is active, and route every open-run creation path through it.

2. **MAJOR — weakening the row lock creates a new own-task race for null-session runs.**  
   [safe-fixes.ts:185](C:/Users/artic/GitHub/remo-code-ptycap08/hub/src/task-qc/safe-fixes.ts:185), [schema.sql:1714](C:/Users/artic/GitHub/remo-code-ptycap08/hub/src/db/schema.sql:1714), [dispatcher.ts:598](C:/Users/artic/GitHub/remo-code-ptycap08/hub/src/scheduler/dispatcher.ts:598)

   `FOR UPDATE` was changed to `FOR NO KEY UPDATE`, which no longer blocks the FK key-share taken by a concurrent run insert. The replacement trigger locks only when `NEW.session_id` is non-null. Supervisor/all-supervisor runs are inserted with `session_id = NULL`, so they take no matching trigger lock and can commit after the own-run probe but before the QC update. The writer can therefore mutate a task while its own run is open.

   Fix: serialize every open-run insert on a per-task key, including null-session runs, with a fixed order such as task key → optional session key → row lock/probes. Add a real-Postgres barrier test for both session-bound and null-session targets.

3. **MAJOR — digest truncation marks findings that were never shown as delivered.**  
   [task-qc.ts:117](C:/Users/artic/GitHub/remo-code-ptycap08/hub/src/scheduler/senders/task-qc.ts:117), [digest.ts:220](C:/Users/artic/GitHub/remo-code-ptycap08/hub/src/task-qc/digest.ts:220)

   The renderer can omit findings because of the 100,000-character limit or 200-finding cap, but after any successful email the sender marks every `recordedId` delivered. Omitted findings then stop being re-reported that day despite never appearing in the digest.

   Fix: have digest construction return the finding-row IDs actually rendered and mark only those. A simpler safe fallback is to mark none whenever the digest reports omitted findings.

## Requested implementation judgments

- **DDL idempotency:** acceptable on the repository’s PostgreSQL 16 target. `CREATE OR REPLACE TRIGGER` replaces rather than duplicates the trigger, and `ADD COLUMN IF NOT EXISTS` is convergent. [PostgreSQL `CREATE TRIGGER`](https://www.postgresql.org/docs/16/sql-createtrigger.html)
- **Deadlock risk:** the intended session-bound row/FK ordering does not itself form a cycle: `BEFORE INSERT` runs before constraints, and `FOR NO KEY UPDATE` is compatible with FK key-share. The blocking and null-session correctness problems above remain. [PostgreSQL trigger timing](https://www.postgresql.org/docs/16/sql-createtrigger.html), [row-lock modes](https://www.postgresql.org/docs/16/explicit-locking.html)
- **Pooled `statement_timeout`:** `SET LOCAL` is the correct non-leaking choice because it expires at transaction end, and the scoped transaction handle uses one reserved connection. The defects are unbounded pool acquisition and failure to re-arm multi-statement fix transactions—not session-setting leakage. [PostgreSQL `SET LOCAL`](https://www.postgresql.org/docs/16/sql-set.html), [Postgres.js transactions](https://github.com/porsager/postgres#transactions)

The focused seven-file Bun test run could not execute because the managed read-only environment returned `EPERM` while Bun opened the test files; `git diff --check` was clean and no files were modified.

## FINAL VERDICT: CONTENT-BLOCK
