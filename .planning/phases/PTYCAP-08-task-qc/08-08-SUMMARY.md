---
phase: PTYCAP-08-task-qc
plan: 08
subsystem: scheduler
tags: [task-qc, seed, boot-order, flag-off, kill-switch, tdd]
status: complete
requires: [PTYCAP-08-03]
provides:
  - hub/src/task-qc/seed.ts (seedTaskQcTasks: idempotent per-user boot seed, flag-OFF zero DB calls)
  - boot-order wiring in hub/src/index.ts (seed before schedRegistry.loadAll and schedCatchup.runOnce)
  - registry/catchup exclusion of task_qc when the flag is OFF
  - pinned kill-switch scope behavior for the anchorless auditor
affects: [PTYCAP-08-09, PTYCAP-08-10]
requirements: [TQC-01, TQC-08, SC5, F2-B2, F2-B3, F2-B6]
plan_head_before: 202c808a796e30739a665388ba8144a80eea18d3
actuals:
  tokens: 14000
  tasks: 3
  commits: 3
key-files:
  created:
    - hub/src/task-qc/seed.ts
    - hub/test/task-qc-seed.test.ts
    - hub/test/task-qc-boot-order.test.ts
    - hub/test/task-qc-flag-off.test.ts
    - hub/test/task-qc-halt-scope.test.ts
  modified:
    - hub/src/index.ts
    - hub/src/scheduler/registry.ts
    - hub/src/scheduler/catchup.ts
    - hub/test/fixtures/task-qc-fire-harness.ts
    - hub/test/task-qc-no-llm-guard.test.ts
key-decisions:
  - "Anchor decision (F2-B2): scheduled_tasks.session_id is nullable (schema.sql DROP NOT NULL), so the seeded row binds no deletable session; deleting a session cannot cascade-delete the auditor, and a session-scoped kill-switch row never matches it"
  - "Seed is a per-user loop (SELECT eligible users, then INSERT ... ON CONFLICT (user_id) WHERE task_type = 'task_qc' DO NOTHING RETURNING id), so one user's failure is logged with its id and the rest are still attempted; no UPDATE or DELETE is ever issued"
  - "Seed lives in code at boot, not schema.sql and not an inline backfill: schema.sql is untouched"
  - "A row inserted with the flag ON and left behind after a restart with the flag OFF is inert: registerInternal returns early (covers loadAll, register and replace) and catchup continues past it"
---

# Phase PTYCAP-08 Plan 08: Boot seed, flag-OFF exclusion, halt scope Summary

The auditor is now wired into the process lifecycle. With REMO_TASK_QC_ENABLED on, boot seeds one anchorless, report-only-by-default task_qc row per user that has at least one auditable task, before the scheduler loads so the normal loader arms it. With the flag off (default) the seed makes zero database calls and a left-behind row is never armed or caught up. Which kill-switch scopes stop the auditor is now a tested fact.

## Commits
- 7b2b07f feat: idempotent task_qc boot seed ordered before registry load and catchup (Task 1)
- dd31aad feat: flag OFF excludes task_qc from registry arming and catchup (Task 2)
- ad18521 test: pin kill-switch scope behavior for the anchorless auditor (Task 3)

## Verification (each file in its own process)
- New: task-qc-seed 11 pass, task-qc-boot-order 4 pass, task-qc-flag-off 11 pass, task-qc-halt-scope 7 pass (0 fail each)
- Existing, unmodified, green: automation-boot-order 7, scheduler 49, once-due-sweep 4, scheduler-halt 12, kill-switch-coverage 10, scheduler-dispatch 11, mount-order 22
- Every other test/task-qc-*.test.ts file re-run after the harness and allowlist edits: all pass, 0 fail
- `git diff 202c808..HEAD -- hub/src/db/schema.sql` prints nothing
- registry.ts + catchup.ts changed lines: 4 total (limit 6)

## Deviations from Plan
- [Rule 3 - blocking, test-support] `hub/test/fixtures/task-qc-fire-harness.ts` gained a `listEnabledTasks` export backed by `h.enabledTasks` (reset to `[]`); the flag-off suite needs the real registry and catchup, which import it. Additive only, no existing suite changed behavior.
- [Rule 3 - blocking, test-support] `hub/test/task-qc-no-llm-guard.test.ts` closed import allowlist gained one entry for the new `task-qc/seed.ts` (`../db/postgres.ts`, `../scheduler/cron.ts`, sibling `flags`). Deliberate narrow addition required by that guard's both-directions contract.
- [Interpretation] The flag-off suite loads the real registry and catchup by cache-busted import (`?flag-off-real`) because the shared harness mocks `scheduler/registry.ts` for the dispatcher.
- Task 3 required no src change: every pinned halt behavior held against plan 03's branch as written.
- Pre-commit branch allow-list in the executor protocol expects an `agent-*` branch in a worktree; the orchestrator assigned `phase-ptycap-08-task-qc` explicitly (as for prior plans). HEAD was never on a protected branch.
- STATE.md / ROADMAP.md not touched (shared planning state is owned by the orchestrator in this wave).

## Contract notes for later plans
- Seed result is `{ seeded }`; name constant `TASK_QC_TASK_NAME = 'Task quality audit'` (does not start with `__internal_`).
- Plan 09 should prove on real Postgres: the ON CONFLICT target `(user_id) WHERE task_type = 'task_qc'` matches `idx_scheduled_tasks_task_qc_unique`, session_id NULL survives, and the eligibility SELECT's `starts_with` predicate runs. This plan only proves SQL shape against the strict fake.
- Seeding runs once per boot, so a user who gains their first auditable task after boot is seeded on the next boot.

## Known Stubs
None.

## Threat Flags
None new. T-08-38 (flag-off zero DB calls, registry/catchup exclusion, end-to-end suite), T-08-39 (ON CONFLICT DO NOTHING, idempotency test), T-08-40 (session_id NULL asserted), T-08-41 (per-user catch, boot continues), T-08-42 (halt-scope suite) mitigated and tested.

## Self-Check: PASSED
- Files exist: seed.ts, the four new suites, this summary
- Commits found: 7b2b07f, dd31aad, ad18521
