---
phase: PTYCAP-08-task-qc
plan: 09
subsystem: task-qc-real-postgres-proof
tags: [task-qc, e2e, postgres, helper, rollback, row-lock, report-only]
status: complete
requires: [PTYCAP-08-06, PTYCAP-08-07, PTYCAP-08-08]
provides:
  - hub/test/e2e/task-qc-checks.ts runTaskQcSchemaChecks and runTaskQcEngineChecks (real-Postgres helpers, no test() calls)
affects: [PTYCAP-08-10]
requirements: [TQC-01, TQC-03, TQC-04, TQC-06, SC2, F2-B2, F2-B4]
plan_head_before: 0d1cc8504269c2454c7e76925b1f469f08cb4100
actuals:
  tokens: 28000
  tasks: 3
  commits: 2
key-files:
  created:
    - hub/test/e2e/task-qc-checks.ts
  modified:
    - hub/test/e2e/schema-double-apply.e2e.test.ts
    - hub/test/e2e/orchestrator-tokencap.e2e.test.ts
key-decisions:
  - "Engine checks run on a scratch user the helper creates, not the harness user: the harness user can carry unrelated audited tasks from sibling tests, which would perturb the row-for-row report-only snapshot and the unique per-user task_qc row"
  - "Report-only proof is a md5(whole row) snapshot of every scratch scheduled_tasks row before and after an AUTOFIX-off pass (any UPDATE, including updated_at, changes the hash)"
  - "Rollback SQL is executed by the helper only; first run must report count 1, second count 0"
---

# Phase PTYCAP-08 Plan 09: real-Postgres task_qc proof Summary

One helper file holds the real-engine assertions the DB-free fakes cannot make, and two one-statement call sites run it from existing REMO_E2E_DB_URL-gated tests. Zero new test() calls, zero new skips.

## Commits

- 70b287f test(08-09): real-Postgres task_qc DDL, engine, rollback and concurrency helper (tasks 1 and 2, same file, written together)
- e0de526 test(08-09): call task_qc real-Postgres helpers from existing gated e2e bodies (task 3)

## What the helper asserts (executes in Woodpecker only)

runTaskQcSchemaChecks (host: schema-double-apply "scheduled_tasks converges..." test, passes applySchemaStrict):
- task_type CHECK accepts task_qc, rejects an unknown type (23514), still does after two further full schema applies with the task_qc row present
- per-user partial unique index: second task_qc for the same user is 23505 on idx_scheduled_tasks_task_qc_unique, the other user's insert succeeds
- NULL anchor: session_id NULL row survives deleting every scratch session; a scheduled_task_runs row with session_id NULL inserts
- task_qc_findings: bad detector, disposition and severity each 23514 (raw SQL, the DAL pre-validates); valid insert true, same-day repeat inserted:false via ON CONFLICT DO NOTHING; ENGINE claim true, false (same UTC day), true (next day); user delete cascades findings

runTaskQcEngineChecks (host: tokencap "UNDER cap" control test, after the PTYCAP-04 helper):
- seeds invalid-timezone, unresolvable log_check with exactly one sibling uuid, soft-deleted session with exactly one live same-repo candidate, a 50-failed-run task, an old never-run task, an internal-prefixed disabled anchor, a task_qc row and an orchestrator row (the last three each carry a defect that would be flagged if audited)
- AUTOFIX off: findings for the five audited defects with evidence.would_fix on the three fixable ones, none for the excluded rows, zero applied, row snapshot identical before and after, zero auto_fixed rows
- AUTOFIX on: exactly the three fixes applied (timezone to UTC, uuid backfilled, session and target rebound), failing task still enabled, other rows byte-identical, three auto_fixed audit rows with before, after and rollback SQL; stored rollback SQL executed restores originals (count 1) and is a no-op the second time (count 0)
- row lock: two overlapping applyFix on one row give exactly applied + noop_changed
- in-flight: an open pending run makes applyFix return skipped_in_flight, row hash unchanged, one skipped_in_flight audit row
- run claim: two overlapping claimTaskQcRun calls yield exactly one open run; a third sequential claim returns null
- AUTOFIX, ENABLED and FAIL_STREAK env restored in finally; cleanup deletes only users with the scratch email prefix (cascades to sessions, tasks, runs, findings)

## Verification (local, one process per file)

- tsc error count 448 at PLAN_BASE and 448 after; no error names task-qc-checks.ts or the two call-site edits (one pre-existing TS2740 at tokencap L96 is unchanged)
- task-qc-schema 6/6 pass; schema-double-apply.e2e 10 skip (no REMO_E2E_DB_URL); orchestrator-tokencap.e2e 5 skip
- `git grep` for test(, it(, describe( in task-qc-checks.ts prints nothing
- call-site diff: only removed line is the timeout literal 45_000 (raised to 120_000 on the schema test; the tokencap test was already 120_000); no added test( or it(
- check-baseline: skip=259 actual vs 259 baseline (unchanged)

## Woodpecker pickup

.woodpecker/qc.yaml pr-gate step sets REMO_E2E_DB_URL against postgres:16 and runs `bun run check-baseline` and `bun run orchestrator:e2e` (`bun test hub/test/e2e/*.e2e.test.ts`). Both host files match that glob, so the helpers execute there. task-qc-checks.ts does not match `*.e2e.test.ts`, so it is never collected on its own. The yaml was not edited. The real-Postgres execution has NOT been run locally (no Postgres on the dev host) and must be green in the PR's qc pipeline before merge.

## Deviations from Plan

**1. [Rule 3 - Isolation] Scratch user instead of the harness user/session**
The plan names `{ sql, userId, sessionId }`; the helper takes only `{ sql }` and creates its own user and sessions. A shared harness user can hold unrelated audited tasks, which would break the exact-three-fixes and snapshot assertions, and a pre-existing task_qc row would hit the per-user unique index.

**2. [Process] Tasks 1 and 2 committed together**
Both edit only task-qc-checks.ts and were written as one coherent file; one commit instead of two.

## Deferred / Unrelated

- `bun run check-baseline` reports fail=1 (baseline fail_max 0): hub/test/workflows-fanout.test.ts "dev workflow fan-out smoke" fails with ECONNREFUSED 127.0.0.1:5432 (needs a local Postgres). That file and its code are untouched by this plan; it is an environmental failure on this host, not caused by these commits. It passes in CI where Postgres exists.

## Known Stubs

None.

## Threat Flags

None.

## Self-Check: PASSED

task-qc-checks.ts exists; commits 70b287f and e0de526 present; SUMMARY written.
