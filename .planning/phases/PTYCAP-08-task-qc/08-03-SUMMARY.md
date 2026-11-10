---
phase: PTYCAP-08-task-qc
plan: 03
subsystem: scheduler
tags: [task-qc, tracer, dispatcher, post-run, tdd]
status: complete
requires: [PTYCAP-08-01, PTYCAP-08-02]
provides:
  - hub/src/task-qc/run-claim.ts (claimTaskQcRun: advisory-locked single open run)
  - hub/src/task-qc/engine.ts (runTaskQcPass final signature, FAILING wired via WIRED_DETECTORS)
  - hub/src/task-qc/digest.ts (buildTaskQcDigest, describeProposal)
  - hub/src/scheduler/senders/task-qc.ts (sendTaskQcTask)
  - dedicated fireTask task_qc branch, flag-off early return, runNow anti-chain sink, routeToSender misroute case
  - terminal-lifecycle guards in post-run afterRun / fireWithContext and executeChain
  - hub/test/fixtures/task-qc-fire-harness.ts (shared mock set for the fire-path suites)
affects: [PTYCAP-08-04, PTYCAP-08-06, PTYCAP-08-07, PTYCAP-08-08]
requirements: [TQC-01, TQC-02, TQC-05, TQC-08, F1-A2, F2-B1]
plan_head_before: 4f48f7721ebf0f2c8fcb4e45f2ea685928a1d98d
actuals:
  tokens: 12000
  tasks: 3
  commits: 3
key-files:
  created:
    - hub/src/task-qc/run-claim.ts
    - hub/src/task-qc/engine.ts
    - hub/src/task-qc/digest.ts
    - hub/src/scheduler/senders/task-qc.ts
    - hub/test/task-qc-tracer.test.ts
    - hub/test/task-qc-fire-branch.test.ts
    - hub/test/task-qc-terminal.test.ts
    - hub/test/fixtures/task-qc-fire-harness.ts
  modified:
    - hub/src/scheduler/dispatcher.ts
    - hub/src/scheduler/post-run/dispatcher.ts
    - hub/src/scheduler/post-run/chain.ts
key-decisions:
  - "Flag-off early return sits at the very top of fireTask (before the kill switch): it performs no automation, so it cannot weaken the kill switch, and OFF stays a true no-op even when halted"
  - "Engine returns exactly { findings, applied, proposals, truncated }; proposals = findings newly inserted (idempotent conflict inserts nothing and therefore re-sends no email)"
  - "Run snippet is counts only: { findings, proposals, digest_delivered }"
  - "Overlapping-fire drop inserts a skipped task_qc_already_running run via insertRunV2 and still stamps fire timestamps on the cron path"
  - "executeChain looks the child up through the DAL before runNow (one extra read per chain edge, all task types)"
---

# Phase PTYCAP-08 Plan 03: Tracer, fire path ordering and terminal lifecycle Summary

A flag-on cron fire of a task_qc row now runs the whole deterministic spine in production code: kill-switch check, atomic one-open-run claim (per-user advisory lock), a pass over the FAILING detector, an idempotent `proposed` finding row, one direct-email digest, a counts-only success finalize and fire-timestamp stamping, with zero model tokens and zero writes by the auditor to scheduled_tasks. Flag OFF is invisible, ordering precedes quota/cost/target resolution, and no generic post-run or chain mechanism can ever act on a task_qc run.

## Commits
- efa297b feat: tracer - one finding, one digest, nothing else (Task 1)
- 37794e1 feat: flag-off no-op, anti-chain sink, misroute guard (Task 2)
- e50ac86 feat: task_qc terminal in post-run and chain (Task 3)

## Verification (each file in its own process)
- `bun test test/task-qc-tracer.test.ts` 7 pass / 0 fail
- `bun test test/task-qc-fire-branch.test.ts` 10 pass / 0 fail
- `bun test test/task-qc-terminal.test.ts` 8 pass / 0 fail
- Existing, unmodified, green: scheduler-halt 12, kill-switch-coverage 10, scheduler-dispatch 11, post-run-default-email 19, dev-controller-routing 9, plus chained-blocked-notify 13, dispatcher-disabled-guard 3, once-tasks 5, orchestrator-scheduler-route 4, qc-routing 6, scheduler-bounds-autodisable 4, scheduler-log-check-uuid 4, scheduler 49, teab-e2e 2, teab-sender 5, triage-finding-forward 19
- `workflows-fanout.test.ts`: 3 pass / 1 fail, the failure is `ECONNREFUSED 127.0.0.1:5432` (needs local Postgres, environmental, unrelated to this plan)
- `git diff 4f48f77..HEAD --stat -- hub/test` shows only added files (no existing test edited)
- import-anchored `git grep` for pipeline / task-macros / orchestrator-inject / agent-sender imports under hub/src/task-qc and the sender prints nothing
- `bunx tsc --noEmit`: 427 errors before and after (unchanged, all pre-existing); no errors in new files

## Deviations from Plan
- [Interpretation] "zero UPDATE scheduled_tasks" is asserted against the fake sql (the auditor/engine/claim write nothing to scheduled_tasks). The cron path's fire-timestamp stamp goes through the existing `updateFireTimestamps` -> `setTaskFireTimestamps` DAL helper (mocked in these suites and asserted as exactly one call), as the plan's prohibition requires.
- [Scope add, test-only] `hub/test/fixtures/task-qc-fire-harness.ts` added to share the mock.module set across the three suites; the plan listed three test files.
- [Design] The overlapping-fire drop and the flag-on path call `updateFireTimestamps` like the other branches. The Task 2 tests run against the real claim SQL shape, not a real database (no local Postgres); lock ordering is asserted (lock statement first, inside one begin()).
- Pre-commit branch allow-list in the executor protocol expects an `agent-*` branch in a worktree; the orchestrator assigned `phase-ptycap-08-task-qc` explicitly (prior plans committed there), so the commits were made on it. HEAD was never on a protected branch.
- STATE.md / ROADMAP.md were not touched (shared planning state is owned by the orchestrator in this wave).

## Contract notes for later plans
- `runTaskQcPass({ userId, scope?, origin, deps? })` is final. Plan 06 widens `WIRED_DETECTORS` (engine.ts) and may extract the inline queries to a load module; it must keep the signature and result keys. Sessions are `{}` in the tracer (DEAD_SESSION needs a loader); `resolvedAppUuid` is not computed yet.
- Finding day uses the UTC day (`userDay('UTC')`), matching `claimEngineFailure`'s utcDay.
- Digest sends `result.proposals` (newly inserted). A failed send is recorded only as `digest_delivered:false` in the run snippet; same-day re-run will not re-send (plan 07 owns retry/escalation).
- The shared sender-side recipient lookup is `SELECT email FROM users WHERE id` via `sql`.

## Known Stubs
None.

## Threat Flags
None new. T-08-10..13 mitigations implemented and tested (afterRun/fireWithContext/executeChain guards, runNow sink, routeToSender misroute, flag-off early return, advisory-locked claim, import-graph grep for FORK-1). T-08-14 accepted as planned (branch precedes quota and cost gates).

## Self-Check: PASSED
- Files exist: run-claim.ts, engine.ts, digest.ts, senders/task-qc.ts, the three suites and the harness fixture
- Commits found: efa297b, 37794e1, e50ac86
