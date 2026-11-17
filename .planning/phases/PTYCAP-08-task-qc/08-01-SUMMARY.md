---
phase: PTYCAP-08-task-qc
plan: 01
subsystem: scheduler
tags: [postgres, schema, feature-flags, task-qc, tdd]
status: complete
requires: []
provides:
  - task_qc in the single task_type CHECK + per-user partial unique index
  - task_qc_findings audit table with idempotency unique key
  - task_type four-carrier enum sync pin test
  - hub/src/task-qc/flags.ts (call-time flags, cadence validator, frozen bounds)
  - hub/src/task-qc/findings.ts (evidenceSig, insertFinding, claimEngineFailure, userDay)
  - hub/test/fixtures/task-qc-fake-sql.ts (strict recording fake sql)
affects: [PTYCAP-08-02, PTYCAP-08-03, PTYCAP-08-04, PTYCAP-08-05]
plan_head_before: 2e44c43da090d05a8022cdd4aff58c8dc6b0f677
actuals:
  tokens: 10800
  tasks: 3
  commits: 3
key-files:
  created:
    - hub/src/task-qc/flags.ts
    - hub/src/task-qc/findings.ts
    - hub/test/fixtures/task-qc-fake-sql.ts
    - hub/test/task-qc-schema.test.ts
    - hub/test/task-qc-enum-sync.test.ts
    - hub/test/task-qc-fake-sql.test.ts
    - hub/test/task-qc-flags.test.ts
    - hub/test/task-qc-findings.test.ts
  modified:
    - hub/src/db/schema.sql
    - hub/src/db/scheduled-tasks-dal.ts
    - hub/src/api/scheduled-tasks.ts
    - hub/src/scheduler/auto-name.ts
key-decisions:
  - "No token-cap knob: bounds are frozen deterministic constants a caller can only lower (F1-A3)"
  - "Cadence floor checked over 10 sampled runs (not just 2) so a burst behind a long gap is rejected"
  - "claimEngineFailure uses a constant evidence_sig override so exactly one ENGINE row exists per task per UTC day"
---

# Phase PTYCAP-08 Plan 01: Task-QC foundation Summary

Additive idempotent DDL (task_qc in the existing CHECK, per-user partial unique index, task_qc_findings), a four-carrier task_type pin test, call-time default-OFF flags with frozen unraisable bounds, an idempotent findings DAL and a strict fake-sql fixture. Nothing changes runtime behavior while `REMO_TASK_QC_ENABLED` is unset.

## Commits
- fdab9a1 feat: DDL + enum sync (Task 1)
- 683128c test: fake sql fixture (Task 2)
- 1243209 feat: flags + findings DAL (Task 3)

## Verification
- `bun test test/task-qc-schema.test.ts` 6 pass / 0 fail
- `bun test test/task-qc-enum-sync.test.ts` 8 pass / 0 fail
- `bun test test/task-qc-fake-sql.test.ts` 8 pass / 0 fail
- `bun test test/task-qc-flags.test.ts` 13 pass / 0 fail
- `bun test test/task-qc-findings.test.ts` 9 pass / 0 fail
- `bun run schema-lint` exit 0 (5 pre-existing allowed pragmas, none added)
- `bunx tsc --noEmit` error count 427 at PLAN_BASE and after (unchanged)
- Adjacent: `teab-task-type.test.ts` 3 pass
- No skipped tests added.

## Enum drift recorded (exemption table, with reasons, frozen in task-qc-enum-sync.test.ts)
- DAL omits `orchestrator`; zod omits `work`; auto-name omits `work` and `orchestrator`. All pre-existing, now documented; new unexplained drift fails CI.

## Deviations from Plan
- None in scope/architecture. Note: Task 1 tests and implementation were written in the same pass (RED run skipped); tests assert real current state and were verified green against the edited sources, and the exemption table was derived from the real files.
- Plan text cites base `ec2237e`; the actual worktree base was `2e44c43` (recorded as plan_head_before). Schema facts re-verified at the actual base (session_id DROP NOT NULL at schema.sql L277, runs.session_id nullable ON DELETE SET NULL).
- `actuals.commits: 3` is the measured code-commit count at SUMMARY write; the docs commit follows.

## Known Stubs
None.

## Threat Flags
None. No new endpoints; DDL is additive and lint-clean (T-08-01..05 mitigations tested).

## Self-Check: PASSED
