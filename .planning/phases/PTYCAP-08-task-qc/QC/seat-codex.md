codex
1. **MAJOR — PATCH can convert a user task into the reserved system task.**  
   [hub/src/api/scheduled-tasks.ts:519](C:/Users/artic/GitHub/remo-code-ptycap08/hub/src/api/scheduled-tasks.ts:519), [hub/src/api/scheduled-tasks.ts:646](C:/Users/artic/GitHub/remo-code-ptycap08/hub/src/api/scheduled-tasks.ts:646)  
   Evidence: protection is selected from `existing.task_type`. A normal task may therefore be patched with `task_type: "task_qc"` through the generic branch, which persists `data.task_type`. It can simultaneously retain or receive arbitrary payload, target, post-run actions, `schedule_kind`, bounded `schedule_rules`, and a sub-hour cadence. If no seeded QC row exists, this row occupies the unique system-row slot; bounded/once scheduling can also reach the generic auto-disable logic before the dedicated QC branch. The API guard tests only cover mutations of an already-QC row, not a `dev → task_qc` transition.  
   Fix: reject any transition into `task_qc` unless performed by the seed path, preferably with a DAL-level system-type guard as defense in depth. Add PATCH tests for ordinary-to-QC conversion, including once and bounded schedule data.

2. **MAJOR — the advertised wall-clock bound is not a hard bound.**  
   [hub/src/task-qc/load.ts:66](C:/Users/artic/GitHub/remo-code-ptycap08/hub/src/task-qc/load.ts:66), [hub/src/task-qc/engine.ts:120](C:/Users/artic/GitHub/remo-code-ptycap08/hub/src/task-qc/engine.ts:120), [hub/src/task-qc/engine.ts:166](C:/Users/artic/GitHub/remo-code-ptycap08/hub/src/task-qc/engine.ts:166)  
   Evidence: the only `statement_timeout` applies to the initial read transaction, and the blocking advisory lock is acquired before that timeout is set. Resolver calls, sibling/session lookups, finding inserts, and fix transactions occur afterward without a database timeout. Sampling `clock()` before an `await` cannot stop a blocked query. The “wall clock” test at [hub/test/task-qc-bounds.test.ts:107](C:/Users/artic/GitHub/remo-code-ptycap08/hub/test/task-qc-bounds.test.ts:107) merely asserts that one read transaction set a timeout; it does not test the whole pass.  
   Fix: apply the remaining `statement_timeout` and `lock_timeout` to every QC transaction/query, set them before advisory-lock acquisition, and use database-level cancellation. Add blocking-lock and blocking-candidate-query tests.

3. **MAJOR — the shared-session in-flight check has a TOCTOU write path.**  
   [hub/src/task-qc/safe-fixes.ts:181](C:/Users/artic/GitHub/remo-code-ptycap08/hub/src/task-qc/safe-fixes.ts:181), [hub/src/task-qc/safe-fixes.ts:196](C:/Users/artic/GitHub/remo-code-ptycap08/hub/src/task-qc/safe-fixes.ts:196), [hub/src/task-qc/safe-fixes.ts:224](C:/Users/artic/GitHub/remo-code-ptycap08/hub/src/task-qc/safe-fixes.ts:224)  
   Evidence: `FOR UPDATE` locks only the audited task. The shared-session probe is an unlocked `SELECT`; a run for another task on that session can be inserted after the probe and before the QC update. Because that run references a different task row, the audited-row lock provides no serialization. The unit test only supplies an already-open run and does not exercise concurrent run insertion.  
   Fix: introduce a shared per-session transactional lock used by both run creation/claim and QC fixes, with a fixed lock order. Add a real-Postgres barrier test that races dispatch insertion against `applyFix`.

4. **MINOR — distinct long skip reasons collapse into a false `SKIP_FOREVER` finding.**  
   [hub/src/task-qc/detectors.ts:59](C:/Users/artic/GitHub/remo-code-ptycap08/hub/src/task-qc/detectors.ts:59), [hub/src/task-qc/types.ts:144](C:/Users/artic/GitHub/remo-code-ptycap08/hub/src/task-qc/types.ts:144)  
   Evidence: classification calls `safeText`, which truncates at 120 characters, before comparing signatures. Three different errors sharing their first 120 characters are treated as the same reason and produce a disable proposal. Sanitization intended for digest evidence is altering detector equality.  
   Fix: compare or hash the full canonicalized reason; use truncated `safeText` only for rendered evidence. Add a same-prefix/different-suffix fixture.

5. **MINOR — the emailed dead-session remediation can be a guaranteed no-op.**  
   [hub/src/task-qc/detectors.ts:277](C:/Users/artic/GitHub/remo-code-ptycap08/hub/src/task-qc/detectors.ts:277), [hub/src/task-qc/digest.ts:132](C:/Users/artic/GitHub/remo-code-ptycap08/hub/src/task-qc/digest.ts:132)  
   Evidence: `DEAD_SESSION` uses `target_id ?? session_id`, so a stale `target_id` with `session_id = NULL` is a valid finding. The generated SQL nevertheless guards only on `session_id IS NOT DISTINCT FROM stale`, which is false for that row. The test at [hub/test/task-qc-proposals.test.ts:143](C:/Users/artic/GitHub/remo-code-ptycap08/hub/test/task-qc-proposals.test.ts:143) pins this incomplete template rather than exercising the target-only case.  
   Fix: guard on the actual stale binding, or on `(target_id IS NOT DISTINCT FROM stale OR session_id IS NOT DISTINCT FROM stale)`, and test execution against a target-only stale row.

6. **MINOR — ignored runs consume the history bound before filtering.**  
   [hub/src/task-qc/load.ts:86](C:/Users/artic/GitHub/remo-code-ptycap08/hub/src/task-qc/load.ts:86), [hub/src/task-qc/detectors.ts:82](C:/Users/artic/GitHub/remo-code-ptycap08/hub/src/task-qc/detectors.ts:82)  
   Evidence: SQL selects the newest 50 runs of all statuses, and `countedWindow` slices before removing `cancelled` and non-terminal rows. With 48 recent cancelled rows followed by three failures, only two failures are loaded and `FAILING` misses what should be the newest three counted terminal runs. This contradicts the stated “cancelled/non-terminal ignored” semantics.  
   Fix: rank counted statuses before applying the per-task history limit, while separately loading an `any_run_exists` signal for `NEVER_FIRED`.

Test execution was attempted but the managed read-only environment denied Bun file reads with `EPERM`; the findings above are source-traced.

## FINAL VERDICT: CONTENT-BLOCK
312,774
1. **MAJOR — PATCH can convert a user task into the reserved system task.**  
   [hub/src/api/scheduled-tasks.ts:519](C:/Users/artic/GitHub/remo-code-ptycap08/hub/src/api/scheduled-tasks.ts:519), [hub/src/api/scheduled-tasks.ts:646](C:/Users/artic/GitHub/remo-code-ptycap08/hub/src/api/scheduled-tasks.ts:646)  
   Evidence: protection is selected from `existing.task_type`. A normal task may therefore be patched with `task_type: "task_qc"` through the generic branch, which persists `data.task_type`. It can simultaneously retain or receive arbitrary payload, target, post-run actions, `schedule_kind`, bounded `schedule_rules`, and a sub-hour cadence. If no seeded QC row exists, this row occupies the unique system-row slot; bounded/once scheduling can also reach the generic auto-disable logic before the dedicated QC branch. The API guard tests only cover mutations of an already-QC row, not a `dev → task_qc` transition.  
   Fix: reject any transition into `task_qc` unless performed by the seed path, preferably with a DAL-level system-type guard as defense in depth. Add PATCH tests for ordinary-to-QC conversion, including once and bounded schedule data.

2. **MAJOR — the advertised wall-clock bound is not a hard bound.**  
   [hub/src/task-qc/load.ts:66](C:/Users/artic/GitHub/remo-code-ptycap08/hub/src/task-qc/load.ts:66), [hub/src/task-qc/engine.ts:120](C:/Users/artic/GitHub/remo-code-ptycap08/hub/src/task-qc/engine.ts:120), [hub/src/task-qc/engine.ts:166](C:/Users/artic/GitHub/remo-code-ptycap08/hub/src/task-qc/engine.ts:166)  
   Evidence: the only `statement_timeout` applies to the initial read transaction, and the blocking advisory lock is acquired before that timeout is set. Resolver calls, sibling/session lookups, finding inserts, and fix transactions occur afterward without a database timeout. Sampling `clock()` before an `await` cannot stop a blocked query. The “wall clock” test at [hub/test/task-qc-bounds.test.ts:107](C:/Users/artic/GitHub/remo-code-ptycap08/hub/test/task-qc-bounds.test.ts:107) merely asserts that one read transaction set a timeout; it does not test the whole pass.  
   Fix: apply the remaining `statement_timeout` and `lock_timeout` to every QC transaction/query, set them before advisory-lock acquisition, and use database-level cancellation. Add blocking-lock and blocking-candidate-query tests.

3. **MAJOR — the shared-session in-flight check has a TOCTOU write path.**  
   [hub/src/task-qc/safe-fixes.ts:181](C:/Users/artic/GitHub/remo-code-ptycap08/hub/src/task-qc/safe-fixes.ts:181), [hub/src/task-qc/safe-fixes.ts:196](C:/Users/artic/GitHub/remo-code-ptycap08/hub/src/task-qc/safe-fixes.ts:196), [hub/src/task-qc/safe-fixes.ts:224](C:/Users/artic/GitHub/remo-code-ptycap08/hub/src/task-qc/safe-fixes.ts:224)  
   Evidence: `FOR UPDATE` locks only the audited task. The shared-session probe is an unlocked `SELECT`; a run for another task on that session can be inserted after the probe and before the QC update. Because that run references a different task row, the audited-row lock provides no serialization. The unit test only supplies an already-open run and does not exercise concurrent run insertion.  
   Fix: introduce a shared per-session transactional lock used by both run creation/claim and QC fixes, with a fixed lock order. Add a real-Postgres barrier test that races dispatch insertion against `applyFix`.

4. **MINOR — distinct long skip reasons collapse into a false `SKIP_FOREVER` finding.**  
   [hub/src/task-qc/detectors.ts:59](C:/Users/artic/GitHub/remo-code-ptycap08/hub/src/task-qc/detectors.ts:59), [hub/src/task-qc/types.ts:144](C:/Users/artic/GitHub/remo-code-ptycap08/hub/src/task-qc/types.ts:144)  
   Evidence: classification calls `safeText`, which truncates at 120 characters, before comparing signatures. Three different errors sharing their first 120 characters are treated as the same reason and produce a disable proposal. Sanitization intended for digest evidence is altering detector equality.  
   Fix: compare or hash the full canonicalized reason; use truncated `safeText` only for rendered evidence. Add a same-prefix/different-suffix fixture.

5. **MINOR — the emailed dead-session remediation can be a guaranteed no-op.**  
   [hub/src/task-qc/detectors.ts:277](C:/Users/artic/GitHub/remo-code-ptycap08/hub/src/task-qc/detectors.ts:277), [hub/src/task-qc/digest.ts:132](C:/Users/artic/GitHub/remo-code-ptycap08/hub/src/task-qc/digest.ts:132)  
   Evidence: `DEAD_SESSION` uses `target_id ?? session_id`, so a stale `target_id` with `session_id = NULL` is a valid finding. The generated SQL nevertheless guards only on `session_id IS NOT DISTINCT FROM stale`, which is false for that row. The test at [hub/test/task-qc-proposals.test.ts:143](C:/Users/artic/GitHub/remo-code-ptycap08/hub/test/task-qc-proposals.test.ts:143) pins this incomplete template rather than exercising the target-only case.  
   Fix: guard on the actual stale binding, or on `(target_id IS NOT DISTINCT FROM stale OR session_id IS NOT DISTINCT FROM stale)`, and test execution against a target-only stale row.

6. **MINOR — ignored runs consume the history bound before filtering.**  
   [hub/src/task-qc/load.ts:86](C:/Users/artic/GitHub/remo-code-ptycap08/hub/src/task-qc/load.ts:86), [hub/src/task-qc/detectors.ts:82](C:/Users/artic/GitHub/remo-code-ptycap08/hub/src/task-qc/detectors.ts:82)  
   Evidence: SQL selects the newest 50 runs of all statuses, and `countedWindow` slices before removing `cancelled` and non-terminal rows. With 48 recent cancelled rows followed by three failures, only two failures are loaded and `FAILING` misses what should be the newest three counted terminal runs. This contradicts the stated “cancelled/non-terminal ignored” semantics.  
   Fix: rank counted statuses before applying the per-task history limit, while separately loading an `any_run_exists` signal for `NEVER_FIRED`.

Test execution was attempted but the managed read-only environment denied Bun file reads with `EPERM`; the findings above are source-traced.

## FINAL VERDICT: CONTENT-BLOCK
