---
phase: PTYCAP-08-task-qc
plan: 05
subsystem: api
tags: [task-qc, scheduled-tasks-api, system-owned-row, tdd]
status: complete
requires: [PTYCAP-08-01]
provides:
  - task_qc guards on POST (400 task_qc_machine_seeded), DELETE (409 task_qc_system_task), PATCH (task_qc_field_immutable / task_qc_cadence_invalid)
affects: [PTYCAP-08-08]
requirements: [TQC-01, F2-B5]
plan_head_before: 1f6ad70c4964f8d4aa30b3c36808ca532a5f17cc
actuals:
  tokens: 6000
  tasks: 2
  commits: 2
key-files:
  created:
    - hub/test/task-qc-api-guards.test.ts
  modified:
    - hub/src/api/scheduled-tasks.ts
key-decisions:
  - "PATCH on a task_qc row branches before the generic merge and builds the update argument from enabled, cron_expr, timezone only; buildNameForUser is never called so the seeded name/prefix/suffix cannot be rewritten"
  - "Locked keys are compared to the stored row with a key-order-independent JSON compare (undefined == null); equal values are ignored, differing values reject with a fields array"
  - "Run Now handler untouched; test asserts it is not rejected for task_qc"
---

# Phase PTYCAP-08 Plan 05: task_qc system-owned row at the API boundary Summary

The seeded task_qc row is now machine-seeded only (POST 400), undeletable (DELETE 409, no unregister, no DAL delete) and PATCH-restricted to enabled plus a cadence/timezone that passes validateTaskQcCadence (valid, 60 minute floor); any differing locked key is 400 task_qc_field_immutable, and the registry replace path runs as for other rows.

## Commits

- 1e5dab9 feat(08-05): reject user-created and deleted task_qc rows
- a01bf49 feat(08-05): task_qc PATCH allows only enabled, a validated cadence and a timezone

## Verification

- `bun test test/task-qc-api-guards.test.ts`: 32 pass / 0 fail (each file run in its own process)
- scheduled-tasks-patch-target 3/3, scheduled-tasks-orchestrator-type 2/2, mount-order 22/22
- OpenAPI: `bun run docs:openapi` regenerated; no content change (only line-ending noise, reverted). docs:sync not needed, docs/api.md untouched. No route shape changed.

## Deviations from Plan

**1. [Rule 1 - Bug] Null re-sends on task_qc PATCH**
- **Found during:** Task 2 (test "equal values ignored")
- **Issue:** The generic PatchSchema rejects null for run_at and schedule_rules, so a UI re-sending the whole form (stored nulls) would 400 on invalid_body before the no-op rule could apply.
- **Fix:** for task_qc rows only, body keys that are null and whose stored value is null are dropped before schema parse. Non-task_qc behavior unchanged.
- **Files modified:** hub/src/api/scheduled-tasks.ts
- **Commit:** a01bf49

Otherwise none. Task 1 test file was committed with only the Task 1 describes; the PATCH describes were added in Task 2.

## Known Stubs

None.

## Threat Flags

None. T-08-22..25 mitigated as planned.

## Self-Check: PASSED

Files hub/src/api/scheduled-tasks.ts, hub/test/task-qc-api-guards.test.ts present; commits 1e5dab9, a01bf49 present.
