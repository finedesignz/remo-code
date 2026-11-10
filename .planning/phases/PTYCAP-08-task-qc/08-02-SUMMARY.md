---
phase: PTYCAP-08-task-qc
plan: 02
subsystem: scheduler
tags: [task-qc, detectors, pure-functions, tdd]
status: complete
requires: [PTYCAP-08-01]
provides:
  - hub/src/task-qc/types.ts (Finding, inputs, scope, origin, result types, safeText)
  - hub/src/task-qc/detectors.ts (isAuditable, six detect functions, runDetectors)
  - purity proof (zero recorded sql statements + static import allowlist)
affects: [PTYCAP-08-03, PTYCAP-08-04, PTYCAP-08-06, PTYCAP-08-07]
requirements: [TQC-02, SC1, F2-B7]
plan_head_before: 07a3ecab1c025c5a482d24930e9cc9a5009f7726
actuals:
  tokens: 14500
  tasks: 3
  commits: 3
key-files:
  created:
    - hub/src/task-qc/types.ts
    - hub/src/task-qc/detectors.ts
    - hub/test/task-qc-detectors.test.ts
    - hub/test/task-qc-detectors-purity.test.ts
  modified: []
key-decisions:
  - "Skip reason signature collapses digit runs so a skipped_quota reason with a changing figure still groups (auto-default refinement)"
  - "NEVER_FIRED (b)/(c) propose reregister_job {taskId, enabled:true}; no next_fire_at rewrite fixCandidate (registry owns next_fire_at; DB rewrite would hide an unarmed job)"
  - "undefined resolvedAppUuid (resolver not run) never fires MISCONFIGURED; only strict null does"
  - "MISCONFIGURED absorbs SKIP_FOREVER evidence as skipRuns/skipReason only when MISCONFIGURED is in scope"
---

# Phase PTYCAP-08 Plan 02: Pure task-quality detectors Summary

Six pure detectors (FAILING, SKIP_FOREVER, NEVER_FIRED, MISCONFIGURED, DEAD_SESSION, OPTIMIZE) over plain row objects on the real columns, an audit-set predicate that can never admit internal anchors, and the shared type contract plans 03-08 import. Zero sql, zero env reads, zero clock reads; `now` and config are arguments.

## Commits
- 2bc2bc3 types, isAuditable, FAILING, SKIP_FOREVER (Task 1)
- 8a9a7f4 NEVER_FIRED, MISCONFIGURED, DEAD_SESSION (Task 2)
- 98dd892 OPTIMIZE, runDetectors, purity test (Task 3)

## Verification
- `bun test test/task-qc-detectors.test.ts` 59 pass / 0 fail
- `bun test test/task-qc-detectors-purity.test.ts` 2 pass / 0 fail (0 recorded sql statements through the mocked postgres module; import allowlist: ./types.ts, ./detectors.ts, ../scheduler/cron.ts, node:*)
- `bunx tsc --noEmit` error count 427 before and after (unchanged); no errors in src/task-qc
- `git grep -e Date.now -e process.env -- hub/src/task-qc/detectors.ts` prints nothing
- No skipped tests added.

## Contract notes for later plans
- Per-task detectors: `detectFailing/detectSkipForever(task, runs, config)`, `detectNeverFired(task, runs, now)`, `detectMisconfigured(task, runs)`, `detectDeadSession(task, sessionsById, now)`; cross-task `detectOptimize(inputs, config)`; aggregator `runDetectors(inputs, config, scope?)`.
- `DetectorConfig = { failStreak, windowSize? }` (windowSize default 50 = frozen maxRunsPerTask). Inputs: `{ tasks, runsByTask, sessionsById, now }`; tasks carry `resolvedAppUuid` computed by the engine from the sender's exported resolver (plan 06 must export `resolveAppUuid`).
- FAILING severity high at streak >= 10*N or a streak filling the window; evidence uses parallel `errorSignatures`/`errorCounts` arrays.
- OPTIMIZE findings carry `evidence.arm` (cadence_hot | prompt_cost | duplicate); evidence_sig for idempotency should include it. OPTIMIZE (b)/(c) group per user.
- `TaskQcResult` shape (`findings`, `applied[{finding,fix}]`, `proposals`, `truncated`) is this plan's choice; no later plan constrained it.

## Deviations from Plan
- [Rule 2 - design detail] `detectNeverFired` also returns null for non-auditable tasks (internal anchors have a never-firing cron by design, highest false-positive risk), in addition to runDetectors filtering.
- Test-only fix: a prompt-length fixture used unpadded numeric suffixes, which broke the intended tie; padded to 2 digits. No source change.
- Ran each task's RED (module missing / export missing) before GREEN.

## Known Stubs
None.

## Threat Flags
None. No endpoints, no DB access. T-08-06..09 mitigations covered by fixtures (internal anchor exclusion, safeText on all free text, enumerated proposal kinds with no enable/disable write, benign list and de-dup).

## Self-Check: PASSED
