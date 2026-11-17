---
phase: PTYCAP-08-task-qc
plan: 04
subsystem: scheduler
tags: [task-qc, safe-fixes, allowlist, transactions, tdd]
status: complete
requires: [PTYCAP-08-01, PTYCAP-08-02]
provides:
  - hub/src/task-qc/safe-fixes.ts (SAFE_FIXES, applyFix, sqlLiteral, buildRollbackSql, SafeFix/ApplyResult types)
  - hub/src/task-qc/fix-plans.ts (pure planFix, PlanContext, PlanResult)
  - TQC-04 static guard over every UPDATE scheduled_tasks literal under hub/src/task-qc
affects: [PTYCAP-08-06, PTYCAP-08-07, PTYCAP-08-09]
requirements: [TQC-03, TQC-04, TQC-06, SC2, SC3, F2-B7]
plan_head_before: 0f29933ea2a3bad8cfc36051b562b5e99de9eaa8
actuals:
  tokens: 14000
  tasks: 3
  commits: 3
key-files:
  created:
    - hub/src/task-qc/safe-fixes.ts
    - hub/src/task-qc/fix-plans.ts
    - hub/test/task-qc-safe-fixes.test.ts
    - hub/test/task-qc-never-disables.test.ts
    - hub/test/task-qc-in-flight.test.ts
    - hub/test/task-qc-fix-planning.test.ts
  modified: []
key-decisions:
  - "SAFE_FIXES is a closure-backed read-only structure, not a frozen Set: a frozen Set still accepts add() and Set.prototype.add.call(), this has no internal slot to reach"
  - "recompute_next_run_at is not on the allowlist (08-04/08-10 authoritative): three kinds, each writing an input column the dispatcher reads at fire time"
  - "Applied-fix audit row uses a per-apply nonce signature so the (user,task,detector,sig,day) unique key can never swallow it; a non-inserted audit row throws and rolls the fix back"
  - "skipped_in_flight rows use a disposition-qualified signature so they cannot collide with the engine's proposed row"
  - "Fix argument validation (timezone validity, non-empty ids/uuid) runs before the transaction opens: zero statements on bad input"
---

# Phase PTYCAP-08 Plan 04: Auditing safe-fix writer Summary

A literal three-kind safe-fix writer (normalize_timezone, backfill_payload_from_sibling, rebind_dead_session) that applies each fix in one transaction (FOR UPDATE row lock, write-time audit-set re-check, precondition re-check, own-run and shared-session in-flight refusal, fixed UPDATE, same-transaction audit row with before/after and a guarded rollback), plus a pure planner that returns a fix only when exactly one safe candidate exists. Nothing calls the writer yet; plan 06 wires the engine.

## Commits
- 9e2313e allowlist, unlisted-kind guard, sqlLiteral, buildRollbackSql, TQC-04 static guard (Task 1)
- 28d9916 one-transaction apply, in-flight refusal, same-tx audit row (Task 2)
- e5da224 pure planFix (Task 3)

## Verification (each file in its own process, from hub/)
- `bun test test/task-qc-safe-fixes.test.ts` 55 pass / 0 fail
- `bun test test/task-qc-never-disables.test.ts` 5 pass / 0 fail
- `bun test test/task-qc-in-flight.test.ts` 6 pass / 0 fail
- `bun test test/task-qc-fix-planning.test.ts` 17 pass / 0 fail
- `bunx tsc --noEmit -p tsconfig.json`: 427 errors, equal to the 427 recorded at plan 01/02; none in task-qc files
- No skipped tests added. No e2e: real-database row-lock serialisation is plan 09 (stated in the test headers).

## Deviations from Plan
- [Process] Task 1 and Task 2 implementation was written before their tests in one pass (no separate RED run), as in plan 01; tests assert real behaviour and were run green. Task 3 same.
- [Rule 2] Argument validation before `begin` (invalid timezone, blank uuid, identical session ids throw `invalid fix arguments`, zero statements). Not in the plan; prevents writing an invalid timezone as the "fix".
- [Rule 2] An audit insert that does not insert (unique-key conflict) throws, aborting the transaction, so an unaudited write is impossible. Applied rows use a nonce signature for this reason.
- [Rule 1 design] "Two applyFix calls do not interleave" is tested as sequential calls with contiguous per-transaction statements (one begin each). True overlap serialisation is the FOR UPDATE lock and cannot be modelled by the fake; no in-process mutex was added (smallest diff). Proven in plan 09.
- The static guard also asserts the SET column lists are exactly {timezone}, {payload}, {session_id,target_id} (updated_at excluded), that only safe-fixes.ts holds an UPDATE scheduled_tasks literal, and that safe-fixes.ts imports only cron, detectors, findings, types and node:crypto.
- types.ts unchanged: `SafeFix` and `ApplyResult` live in safe-fixes.ts; fix-plans.ts imports them type-only.

## Contract notes for later plans
- `applyFix(db, fix, { userId, taskId, day, finding })` where `db` is the sql tag (needs `.begin`). Results: `applied` (rowsWritten 2), `skipped_in_flight` (rowsWritten 1, carries the in_flight proposal), `refused_not_auditable`, `noop_changed` (both 0 rows). Errors propagate.
- `planFix(finding, ctx)` needs the engine to supply: `autofix`, `taskTimezone`, `userTimezone`, `siblingApplicationUuids` (user's other log_check/log_pull tasks, same session or repo_key), `liveSessionIds` (same non-NULL repo_key, deleted_at NULL, status online/thinking) and `deadSessionRepoKey`. The old session id is read from `finding.evidence.sessionId`.
- The writer bumps `updated_at` on the three UPDATEs.

## Known Stubs
None.

## Threat Flags
None. No endpoints. T-08-15..21 mitigations covered: hostile-kind loop with zero statements (22 kinds), static template guard proven non-vacuous, FOR UPDATE plus in-flight inside one transaction, exactly-one-candidate planner, guarded rollback from fixed templates via one quoter.

## Self-Check: PASSED
