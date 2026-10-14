---
phase: PTYCAP-05-throwaway-repo-due-to-pr-proof
plan: 06
subsystem: orchestrator
tags: [proof, evaluators, budget, inject-outcome, counter-key, fail-closed]
requires: [05-01, 05-02, 05-03, 05-05]
provides:
  - defaultProofEvaluators (locked order) / selectBudgetOutcome / frozenFromRun
  - mapInjectOutcome + observeInject terminal mapping (closed outcome sets only)
  - realProofHooks wired to the real evaluators
  - counter-key pin, multi-tick cycle scenarios, no-scrub scan
affects: [05-07, 05-08, 05-09]
key-files:
  created:
    - hub/src/orchestrator/proof-evaluators.ts
    - hub/test/orchestrator-proof-evaluators.test.ts
    - hub/test/orchestrator-proof-counterkey.test.ts
    - hub/test/orchestrator-proof-cycle.test.ts
    - hub/test/orchestrator-proof-no-scrub-reliance.test.ts
  modified:
    - hub/src/orchestrator/proof-guard.ts
    - hub/src/orchestrator/proof-types.ts
    - hub/src/orchestrator/macro-cycle.ts
decisions:
  - "Evaluator ctx is shared across the chain (observation set by the verifier, read by agentDeclined and budget)"
  - "protection evaluator tolerates drift detail updated_at_changed exactly like the dispatch gate (timestamptz round trip, digest already covers updated_at)"
  - "Spent injects/tokens WAIT only while a turn is live or CI is pending/unverifiable; wall always terminates"
  - "observeInject records last_inject_outcome as <kind> or <kind>:<reason>; proof_run_terminal:* is a full no-op"
status: complete
plan_head_before: 816d55a
commits: 3
actuals:
  tasks: 3
  commits: 3
---

# Phase PTYCAP-05 Plan 06: Evaluators, inject-outcome mapping, counter-key pin Summary

The proof guard is now the full SC-1/SC-2 state machine: kill switch, repo match, protection re-assertion, GitHub verifier, agent-declined, budget, in that order, every controller tick, with tick-side budget termination, a closed-set mapping of every inject outcome, and tests proving exactly-once side effects tick by tick.

## Commits

- 42e6be7 Task 1: proof-evaluators.ts + 29-test suite; guard shares one evaluator ctx
- 12bd1af Task 2: mapInjectOutcome/observeInject, realProofHooks evaluator wiring, counter-key pin (37 tests)
- b404472 Task 3: 11 cycle scenarios + final-string grep (12 tests) and no-scrub scan (3 tests)

## Verification (bun test, one process per file)

| File | Result |
|---|---|
| orchestrator-proof-evaluators | 29 pass / 0 fail |
| orchestrator-proof-counterkey | 37 pass / 0 fail |
| orchestrator-proof-cycle | 12 pass / 0 fail |
| orchestrator-proof-no-scrub-reliance | 3 pass / 0 fail |
| orchestrator-proof-tracer / macro-cycle | 20 / 23 pass, 0 fail |
| token-cap-coverage / counter-key-assignment-guard / kill-switch-coverage | 4 / 3 / 11 pass, 0 fail |
| orchestrator-inject-counterkey / autospawn-inject / tick-reinject | 10 / 14 / 9 pass, 0 fail |
| orchestrator-proof-gates / dal / verifier / protection / api | 23 / 23 / 47 / 50 / 10 pass, 0 fail |

`tsc --noEmit` (hub): no errors in the touched files. Full `bun run check-baseline` not re-run in this plan.

## Deviations from Plan

1. **[Rule 3 - blocking] macro-cycle.ts and proof-types.ts edited (plan said neither).** Plan 05-01 shipped `observeInject(run, outcomeKind: string)`, which drops the refusal reason, so the plan's mapping table (keyed on `refused(reason)`) was impossible. The hook now receives the full inject outcome plus the guard input (needed to terminalize). One-line change in macro-cycle (`observeInject(proofRun, outcome, proofGuardInput ?? undefined)`); the hook still accepts a bare kind string. The acceptance line `git diff ... macro-cycle.ts prints nothing` therefore does not hold; flag-OFF behavior is unchanged (23/23 macro-cycle tests, tracer flag-OFF tests pass).
2. **[Rule 2] Terminal notification carries the PR url** when known (`notifyFor(outcome, detail, prUrl)`); the success scenario requires it and a page without the PR link is not actionable.
3. **[Process] Tests written alongside the implementation rather than watched-RED first** (same as 05-01/05-05). Each branch has a test that fails against an implementation missing it.
4. **Test fixture:** the shared fake's default ruleset (`update` only) is not an accepted protection shape (needs required checks), so the tests build a `branch_lock + required 'ci'` scenario locally.

## Observations (no change made)

- The blocked tick for an already-terminal run (05-01 behavior) calls `disableTask` again. It is idempotent and never re-pages or re-logs; the cycle test pins that.
- `max_tokens`/`tokens_hwm` are read as numbers from BIGINT-safe strings via `Number()`, matching the gate.

## Known Stubs

None.

## Threat Flags

None. No new endpoints, writes to GitHub, or credential handling; the evaluators are read-only over the injected GitHub client.

## Self-Check: PASSED

- proof-evaluators.ts and the four new test files exist; commits 42e6be7, 12bd1af, b404472 exist.
- No timer/sleep in proof-evaluators.ts (test-enforced); no scrub-helper reference in any proof module (test-enforced).
