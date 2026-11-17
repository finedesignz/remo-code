---
phase: PTYCAP-08-task-qc
plan: 06
subsystem: task-qc-engine
tags: [task-qc, engine, bounds, report-only, no-llm-guard, tdd]
status: complete
requires: [PTYCAP-08-02, PTYCAP-08-03, PTYCAP-08-04]
provides:
  - hub/src/task-qc/load.ts bounded read-only read layer + sibling/live-session candidate loaders
  - full runTaskQcPass (six detectors, planFix, applyFix, proposals, deterministic bounds, halt re-check)
  - exported resolveAppUuid in senders/coolify.ts
  - closed per-file import allowlist guard (FORK-1, TQC-07 superseded structurally)
affects: [PTYCAP-08-07, PTYCAP-08-08]
requirements: [TQC-02, TQC-03, TQC-04, TQC-05, TQC-07, SC1, SC3, SC5, F1-A3, F1-A4, F2-B7]
plan_head_before: d8572b2610be6accabb59bea9fd58d87b2b4367a
actuals:
  tokens: 60000
  tasks: 3
  commits: 3
key-files:
  created:
    - hub/src/task-qc/load.ts
    - hub/test/task-qc-load.test.ts
    - hub/test/task-qc-engine.test.ts
    - hub/test/task-qc-bounds.test.ts
    - hub/test/task-qc-engine-scope.test.ts
    - hub/test/task-qc-no-llm-guard.test.ts
    - hub/test/fixtures/task-qc-engine-fixture.ts
  modified:
    - hub/src/task-qc/engine.ts
    - hub/src/task-qc/types.ts
    - hub/src/scheduler/senders/coolify.ts
    - hub/test/fixtures/task-qc-fake-sql.ts
    - hub/test/fixtures/task-qc-fire-harness.ts
key-decisions:
  - "Auto-fix without an injected halt check throws halt_check_required before any read or write; the halt check is consulted once, immediately before the first write, and a halted pass is read-only (every finding returned as a proposal, reason halted_read_only)"
  - "Bounds are enforced in the engine and loader: audited tasks (limit+1 detection), history rows (windowed statement), fixes per pass (attempts, overflow = fix_cap_reached proposals), rows written (fix = 2 rows, overflow flagged persisted:false), wall-clock deadline plus SET LOCAL statement_timeout; clampBounds only lowers"
  - "Scope reads exactly taskIds and detectors; ids are an id-in-list predicate next to user_id and a foreign row is also dropped in memory; unknown keys and unknown detector names are ignored"
---

# Phase PTYCAP-08 Plan 06: deterministic engine, bounds, scope seam, no-model guard Summary

runTaskQcPass now runs all six detectors over one bounded read-only transaction, plans each fix with the pure planner, applies only planned allowlisted fixes through the plan 04 writer (capped), and records every non-applied finding as one `proposed` row. With REMO_TASK_QC_AUTOFIX off (default) a pass over broken tasks issues zero UPDATE scheduled_tasks and each would-be fix carries `evidence.would_fix`. A 500-failure task is high severity, a propose_disable proposal, and stays enabled.

## Commits

- 834f173 feat(08-06): bounded read-only audit load layer and exported app-uuid resolver
- 5bb331e feat(08-06): full task_qc engine pass, report-only default, halt re-check
- 5e8bde6 test(08-06): deterministic bounds, narrowing-only scope, no-model import allowlist

## Verification (one process per file)

- task-qc-load 22/22, task-qc-engine 14/14, task-qc-bounds 9/9, task-qc-engine-scope 9/9, task-qc-no-llm-guard 8/8
- Unchanged and green: task-qc-tracer 7/7 (test file untouched), fire-branch 10, terminal 8, api-guards 32, detectors 59, safe-fixes 55, fix-planning 17, in-flight 6, never-disables 5, flags 13, findings 9, schema 6, enum-sync 8, fake-sql 8, purity 2, scheduler-log-check-uuid 4/4
- coolify.ts diff: exactly one changed line (the export keyword)
- tsc: no error in any file this plan touched; total error count 444 (pre-existing, all in other suites)
- Forbidden-import grep over hub/src/task-qc and the sender prints nothing

## Deviations from Plan

**1. [Rule 3 - Blocking] Advisory lock taken only when writes can follow**
The tracer test (must stay unchanged) asserts exactly one advisory-lock statement per fire (the run claim). Taking the lock in every detection read would make it two. loadAuditInputs takes the per-user lock only with `lock: true`, which the engine sets when auto-fix is on (the only case a write follows). Report-only reads write nothing and the claim already serialises task_qc runs.

**2. [Rule 3 - Blocking] Resolver imported lazily**
A static import of senders/coolify.ts from load.ts broke task-qc-terminal (it partially mocks db/dal.ts without getSession). The dispatcher itself loads that sender dynamically, so load.ts does the same, only when a log_check/log_pull task is audited and no resolver is injected. The allowlist names this one edge.

**3. [Rule 1 - Design conflict] proposals omit same-day conflicts**
The plan says "applied plus proposals covers every finding" and also that a second run still lists every finding, but the locked tracer test requires zero emails when the finding row already exists (plan 03: proposals = newly inserted). Resolved: `findings` always lists every finding; `proposals` holds every non-applied finding EXCEPT one whose same-day insert conflicted. On a first run applied + proposals == findings (tested). A-07 (digest re-lists open findings every run) therefore needs the sender/digest in plan 07 to source from findings, and the tracer expectation to be revisited there by its owner; not changed here.

**4. [Rule 3 - Test infra] Harness/fixture changes (additive)**
The fake sql accepts begin('read only', fn) and tx.unsafe (needed for SET LOCAL statement_timeout, which postgres.js cannot parameterise) and records beginModes. The fire harness gained an audit-session responder and relative fire dates (a fixed next_fire_at would trip NEVER_FIRED two days after authoring now that all six detectors run).

**5. [Process] Engine written before its test file**
The engine code preceded task-qc-engine.test.ts within the task (load.ts was RED-first). Tests were then written against the spec and all pass; no spec behavior was tuned to the code.

## Notes for plan 07

- The sender still calls `runTaskQcPass` without a halt check. With REMO_TASK_QC_AUTOFIX on that now throws `halt_check_required` by design; plan 07 must adapt `isAutomationHalted` into `deps.haltCheck`. AUTOFIX is default OFF, so nothing breaks until then.
- Proposals carry engine reasons in `proposal.params.reason` (in_flight, fix_cap_reached, halted_read_only, deadline, rows_budget_exhausted, changed) and `persisted:false` for rows not stored.

## Known Stubs

None.

## Threat Flags

None new. T-08-26..31 mitigations implemented and tested (scope narrowing, bounds, import allowlist, halt re-check, user_id predicates, three-layer audit-set check).

## Self-Check: PASSED

Files and commits verified present (834f173, 5bb331e, 5e8bde6).
