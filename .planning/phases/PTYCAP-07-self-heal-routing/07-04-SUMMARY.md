---
phase: PTYCAP-07-self-heal-routing
plan: 04
subsystem: hub-dispatch
tags: [self-heal, governed-launch, run-leak, liveness, AM-F1-1, AM-F1-2, AM-F1-3, AM-F1-4]
requires: []
provides:
  - hub/src/dispatch/governed-launch.ts (governedLaunch: shared governed autospawn chain, legacy + heal policies)
  - hub/src/sessions/liveness.ts (isSessionLive, moved verbatim from inject.ts)
  - launchSessionForUser closes its reserved run on every non-launch exit
affects: [07-05..07-10 (heal path reuses governedLaunch with a preLaunch governor)]
key-files:
  created: [hub/src/dispatch/governed-launch.ts, hub/src/sessions/liveness.ts, hub/test/launch-run-leak.test.ts, hub/test/governed-launch.test.ts, hub/test/liveness.test.ts]
  modified: [hub/src/telegram/launch.ts, hub/src/orchestrator/inject.ts, hub/test/launch-callers-guard.test.ts]
status: complete
plan_head_before: d7a847ccb0b9f5290c8e607f2385666b280bc612
commits: 3
actuals:
  tokens: 14000
  tasks: 3
  commits: 3
---

# Phase PTYCAP-07 Plan 04: governed launch adapter Summary

governedLaunch extracts the post-flag BSA autospawn chain behind one function with two policies: legacy (orchestrator, byte-identical order/strings/best-effort ledger) and heal (a preLaunch governor runs the full gate list and atomic reservation BEFORE the spawn, writes the ledger row before the spawn and refuses fail-closed on ledger failure, releases the reservation on every refusal and failed launch). launchSessionForUser no longer leaks a supervisor slot on send_failed or a post-reservation throw.

## Commits
- 7166ce4 fix(hub/launch): close reserved run on every non-launch exit (Task 1)
- 6916d8a feat(hub/dispatch): governed launch adapter (Task 2)
- b67f683 refactor(hub/orchestrator): inject onto adapter + liveness moved (Task 3)

## Verification
- launch-run-leak 6/6, launch-machine-guard 6/6, governed-launch 18/18, liveness 6/6.
- Orchestrator suites unchanged and green: autospawn-inject 14, autospawn-gate 4, autospawn-allowlist 5, inject-counterkey 10, inject-rate-gate 8, tick-reinject 9, no-automerge guard 6; e2e orchestrator-autospawn skips locally (no REMO_E2E_DB_URL, expected).
- Guards green: launch-callers, counter-key-assignment, session-start-senders, token-cap-coverage; heal-flag-off green (combined run 107 pass / 0 fail).
- No edits to gates.ts, pipeline.ts, any orchestrator test or e2e file. Adapter has no counterKey / session.start / isOrchestratorEnabled literal.

## Deviations from Plan
1. [Rule 3 - Blocking] hub/test/launch-callers-guard.test.ts: after the refactor orchestrator/inject.ts no longer contains a launchSessionForUser call site, so the guard's self-check ("scanner finds all known call sites") failed for it. Removed inject.ts from the MACHINE set (comment explains); governed-launch.ts is the machine call site and is pinned (machine: true) by a new explicit assertion. Same guard file the plan already listed as modified.
2. TDD order: Task 2 adapter implementation was written before its test file (tests then passed first run, no RED recorded for Task 2). Tasks 1 and 3 had a genuine RED first.
3. Adapter result for armed=false is refused 'disabled' per the plan behaviour; inject early-returns no_session for missing/non-build autospawn context and for the orchestrator-enabled/autospawn-enabled miss, so legacy no_session is preserved without mapping.

## Notes
- Pre-existing tsc errors (TS2352 listSupervisorsForUser cast) at inject.ts:131 and telegram/launch.ts:64 are untouched lines; not in scope.
- Heal ledger row is written before the launch, so a launch that then fails leaves a conservative over-count in the launch-cap ledger (AM-F1-3 trade, intentional).
- The legacy `tz` local in maybeAutospawnOffline is now passed into the adapter; no behaviour change.

## Known Stubs
None.

## Self-Check: PASSED
