codex
One new MAJOR remains; no new CRITICAL defects found.

## Round-2 MAJOR dispositions

1. **FIXED — ordinary task conversion to `task_qc`.**  
   PATCH rejects the transition before mutation at [scheduled-tasks.ts:516](C:/Users/artic/GitHub/remo-code-ptycap08/hub/src/api/scheduled-tasks.ts:516).

2. **FIXED — engine-pass wall-clock deadline.**  
   Pool acquisition is bounded and late callbacks issue no statements at [findings.ts:166](C:/Users/artic/GitHub/remo-code-ptycap08/hub/src/task-qc/findings.ts:166). `haltCheck` is raced at [engine.ts:176](C:/Users/artic/GitHub/remo-code-ptycap08/hub/src/task-qc/engine.ts:176), and fix transactions re-arm the remaining timeout before every lock, probe, update, and audit insert at [safe-fixes.ts:182](C:/Users/artic/GitHub/remo-code-ptycap08/hub/src/task-qc/safe-fixes.ts:182).

3. **FIXED — shared-session insertion race.**  
   The writer locks the effective session row before probing open runs at [safe-fixes.ts:205](C:/Users/artic/GitHub/remo-code-ptycap08/hub/src/task-qc/safe-fixes.ts:205). A concurrent session-bound run’s FK key-share must therefore precede the probe or wait until the fix commits.

4. **FIXED — flag-OFF ordinary inserts were affected by the trigger.**  
   The trigger and function are removed idempotently at [schema.sql:1704](C:/Users/artic/GitHub/remo-code-ptycap08/hub/src/db/schema.sql:1704), while `insertRunV2` remains a single unchanged INSERT at [scheduled-tasks-dal.ts:516](C:/Users/artic/GitHub/remo-code-ptycap08/hub/src/db/scheduled-tasks-dal.ts:516).

5. **FIXED — null-session own-run race.**  
   The task row is locked `FOR UPDATE` before the own-run probe at [safe-fixes.ts:191](C:/Users/artic/GitHub/remo-code-ptycap08/hub/src/task-qc/safe-fixes.ts:191). Every run still references `scheduled_tasks(task_id)` at [schema.sql:455](C:/Users/artic/GitHub/remo-code-ptycap08/hub/src/db/schema.sql:455), so this also serializes NULL-session inserts.

6. **FIXED — truncated digest marked unseen findings delivered.**  
   The renderer returns the exact finding objects actually shown at [digest.ts:246](C:/Users/artic/GitHub/remo-code-ptycap08/hub/src/task-qc/digest.ts:246), and the sender maps only those objects to recorded IDs at [task-qc.ts:148](C:/Users/artic/GitHub/remo-code-ptycap08/hub/src/scheduler/senders/task-qc.ts:148).

## New CRITICAL/MAJOR defects

1. **MAJOR — the newly claimed whole-run deadline is not hard.**  
   [task-qc.ts:71](C:/Users/artic/GitHub/remo-code-ptycap08/hub/src/scheduler/senders/task-qc.ts:71), [task-qc.ts:91](C:/Users/artic/GitHub/remo-code-ptycap08/hub/src/scheduler/senders/task-qc.ts:91)

   The deadline is created only after the recipient query and lifetime reservation, so those waits are outside the bound. More importantly, `markDelivered` calculates `left` before calling `sql.begin`; pool acquisition is unbounded and the callback neither recomputes nor checks the deadline. After acquiring a connection late, it can still arm the stale positive timeout and update findings after the deadline.

   Consequently the sender can remain open indefinitely after sending its email, delaying finalization and suppressing later QC claims through the existing open run. Use deadline-aware transaction acquisition and recompute the remaining time inside the acquired callback.

No additional CRITICAL/MAJOR flag-off, lock-ordering, deadlock, digest, or DDL-idempotency defect was found.

## FINAL VERDICT: CONTENT-BLOCK
150,118
One new MAJOR remains; no new CRITICAL defects found.

## Round-2 MAJOR dispositions

1. **FIXED — ordinary task conversion to `task_qc`.**  
   PATCH rejects the transition before mutation at [scheduled-tasks.ts:516](C:/Users/artic/GitHub/remo-code-ptycap08/hub/src/api/scheduled-tasks.ts:516).

2. **FIXED — engine-pass wall-clock deadline.**  
   Pool acquisition is bounded and late callbacks issue no statements at [findings.ts:166](C:/Users/artic/GitHub/remo-code-ptycap08/hub/src/task-qc/findings.ts:166). `haltCheck` is raced at [engine.ts:176](C:/Users/artic/GitHub/remo-code-ptycap08/hub/src/task-qc/engine.ts:176), and fix transactions re-arm the remaining timeout before every lock, probe, update, and audit insert at [safe-fixes.ts:182](C:/Users/artic/GitHub/remo-code-ptycap08/hub/src/task-qc/safe-fixes.ts:182).

3. **FIXED — shared-session insertion race.**  
   The writer locks the effective session row before probing open runs at [safe-fixes.ts:205](C:/Users/artic/GitHub/remo-code-ptycap08/hub/src/task-qc/safe-fixes.ts:205). A concurrent session-bound run’s FK key-share must therefore precede the probe or wait until the fix commits.

4. **FIXED — flag-OFF ordinary inserts were affected by the trigger.**  
   The trigger and function are removed idempotently at [schema.sql:1704](C:/Users/artic/GitHub/remo-code-ptycap08/hub/src/db/schema.sql:1704), while `insertRunV2` remains a single unchanged INSERT at [scheduled-tasks-dal.ts:516](C:/Users/artic/GitHub/remo-code-ptycap08/hub/src/db/scheduled-tasks-dal.ts:516).

5. **FIXED — null-session own-run race.**  
   The task row is locked `FOR UPDATE` before the own-run probe at [safe-fixes.ts:191](C:/Users/artic/GitHub/remo-code-ptycap08/hub/src/task-qc/safe-fixes.ts:191). Every run still references `scheduled_tasks(task_id)` at [schema.sql:455](C:/Users/artic/GitHub/remo-code-ptycap08/hub/src/db/schema.sql:455), so this also serializes NULL-session inserts.

6. **FIXED — truncated digest marked unseen findings delivered.**  
   The renderer returns the exact finding objects actually shown at [digest.ts:246](C:/Users/artic/GitHub/remo-code-ptycap08/hub/src/task-qc/digest.ts:246), and the sender maps only those objects to recorded IDs at [task-qc.ts:148](C:/Users/artic/GitHub/remo-code-ptycap08/hub/src/scheduler/senders/task-qc.ts:148).

## New CRITICAL/MAJOR defects

1. **MAJOR — the newly claimed whole-run deadline is not hard.**  
   [task-qc.ts:71](C:/Users/artic/GitHub/remo-code-ptycap08/hub/src/scheduler/senders/task-qc.ts:71), [task-qc.ts:91](C:/Users/artic/GitHub/remo-code-ptycap08/hub/src/scheduler/senders/task-qc.ts:91)

   The deadline is created only after the recipient query and lifetime reservation, so those waits are outside the bound. More importantly, `markDelivered` calculates `left` before calling `sql.begin`; pool acquisition is unbounded and the callback neither recomputes nor checks the deadline. After acquiring a connection late, it can still arm the stale positive timeout and update findings after the deadline.

   Consequently the sender can remain open indefinitely after sending its email, delaying finalization and suppressing later QC claims through the existing open run. Use deadline-aware transaction acquisition and recompute the remaining time inside the acquired callback.

No additional CRITICAL/MAJOR flag-off, lock-ordering, deadlock, digest, or DDL-idempotency defect was found.

## FINAL VERDICT: CONTENT-BLOCK
