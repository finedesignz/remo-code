---
phase: PTYCAP-05-throwaway-repo-due-to-pr-proof
plan: 01
subsystem: orchestrator
tags: [proof, orchestrator, schema, dal, flag-gated, tracer]
requires: []
provides:
  - orchestrator_proof_runs table (additive DDL)
  - proof-types (flag stack, closed outcome sets, ProofRun, ProofGithub contract)
  - orchestrator-proof-dal (claim, terminalize, arm/disarm/enable txs, counters)
  - proofGuard + single-winner terminalizer + macro-cycle hooks
  - shared fakes: proof-fake-sql, proof-fake-github
affects: [05-02, 05-03, 05-05, 05-06, 05-07, 05-08]
tech-stack:
  patterns: [flag-gated dynamic import, single conditional UPDATE RETURNING claim, advisory-xact-lock transactions, injectable read-only GitHub client]
key-files:
  created:
    - hub/src/orchestrator/proof-types.ts
    - hub/src/orchestrator/proof-guard.ts
    - hub/src/orchestrator/proof-prompt.ts
    - hub/src/db/orchestrator-proof-dal.ts
    - hub/test/orchestrator-proof-tracer.test.ts
    - hub/test/orchestrator-proof-dal.test.ts
    - hub/test/orchestrator-proof-schema.test.ts
    - hub/test/orchestrator-proof-fake-github.test.ts
    - hub/test/fixtures/proof-fake-sql.ts
    - hub/test/fixtures/proof-fake-github.ts
  modified:
    - hub/src/db/schema.sql
    - hub/src/db/token-usage-dal.ts
    - hub/src/orchestrator/macro-cycle.ts
decisions:
  - "ProofCycleHooks widened to {guard, render, observeInject, abort}: render lives on the hooks so macro-cycle never imports proof-prompt/guard at module top level; abort ends a claimed run when render throws"
  - "ProofGuardInput/Decision types live in proof-types.ts (not proof-guard.ts) so macro-cycle's only static proof import is proof-types"
  - "claim-throws path ends the run via terminalizeActiveProofRunForTask (keyed by task) since no snapshot exists"
  - "Refused/failed proof injects do not page from macro-cycle; plan 05-06 maps inject outcomes to terminals on the observeInject seam"
status: complete
plan_head_before: 9c78e0131070196ed31ed691b423ebd987b685e9
commits: 3
actuals:
  tasks: 3
  commits: 3
---

# Phase PTYCAP-05 Plan 01: Proof tracer, state layer, ProofGithub contract Summary

Flag-gated proof path from an armed `orchestrator_proof_runs` row to a single-winner terminal outcome (claim, snapshot-rendered no-merge prompt, run-log row, one notification, task disabled, session kill), with the transactional state layer and a frozen read-only GitHub contract plus shared fakes.

## Commits

- 60457c5 Task 1 (tracer): schema, proof-types, tracer DAL, proofGuard, proof prompt, macro-cycle hooks, tracer tests
- 70acb3a Task 2: arm/disarm/enable transactions, counters, observation, sumSessionTokensSince, fake sql, DAL + schema tests
- 1273259 Task 3: ProofGithub interface, ProofGithubError, makeFakeProofGithub, shared scenario helpers

## Verification

| Test file (bun, one process each) | Result |
|---|---|
| orchestrator-proof-tracer.test.ts | 20 pass / 0 fail |
| orchestrator-proof-dal.test.ts | 23 pass / 0 fail |
| orchestrator-proof-schema.test.ts | 5 pass / 0 fail |
| orchestrator-proof-fake-github.test.ts | 11 pass / 0 fail |
| orchestrator-macro-cycle.test.ts (existing) | 23 pass / 0 fail |
| `bun run schema-lint` | OK |

Typecheck (tsc via the primary checkout's binary): no errors in touched files; one pre-existing error at macro-cycle.ts:91 (listMessages cast) is unrelated and untouched.

## Deviations from Plan

1. **[Process] Tracer test written after the implementation, not before.** The plan asked for a watched RED. The seams were designed together and the test was written against them before the first run; all 20 passed first run. Flag-OFF differential test uses a hook-touch counter, so it would fail if any proof code ran with a flag off.
2. **[Rule 3 - design] ProofCycleHooks gained `render` and `abort`** (plan listed `{guard, observeInject}`) and the guard types moved to proof-types.ts. Needed to satisfy the acceptance criterion that macro-cycle imports only proof-types statically while still rendering from the claimed snapshot and ending the run on a render throw.
3. **[Rule 2] `terminalizeActiveProofRunForTask` added** so a claim that throws (no snapshot) still fails closed as `nothing:guard_error` through the terminalizer.
4. **Fake sql `begin` rollback** snapshots runs/tasks/rows/allowlist and restores on throw, so the "no partial rows" assertion is real.

## Known Stubs

None. `evaluators` is `[agentDeclinedEvaluator]` by design (plan 05-06 registers the rest); `observeInject` persists `last_inject_outcome` only (05-06 adds the terminal mapping).

## Threat Flags

None beyond the plan's threat model. No network, no env flag flipped, no supervisor change, no push.

## Self-Check: PASSED

All created files present; commits 60457c5, 70acb3a, 1273259 exist on branch phase-ptycap-05-throwaway-repo-proof.
