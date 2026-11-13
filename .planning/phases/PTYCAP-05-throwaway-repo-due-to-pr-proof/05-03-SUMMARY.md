---
phase: PTYCAP-05-throwaway-repo-due-to-pr-proof
plan: 03
subsystem: orchestrator
tags: [proof, verifier, github, fail-closed, read-only]
requires: [05-01]
provides:
  - verifyProof(github, run) -> ProofObservation (terminal | pending)
  - ProofObservation / ProofPendingState types
affects: [05-05, 05-06, 05-07]
key-files:
  created:
    - hub/src/orchestrator/proof-verifier.ts
    - hub/test/orchestrator-proof-verifier.test.ts
  modified: []
decisions:
  - "Order: compare(base_sha, default) -> PR scope -> CI -> re-compare; any non-identical compare (ahead/behind/diverged/not_found) is terminal main_advanced"
  - "Red wins over a sibling still pending (reports ci_red); truncated or unreadable checks report ci_unverifiable before any red/pending evaluation"
  - "Closed unmerged PR for the branch is non-terminal no_pr (detail pr_closed); a foreign proof/ head is terminal even if closed (plan-literal)"
status: complete
plan_head_before: 07c5c8e8ec716dfd5a81fc6e0bf66f9be67db379
commits: 2
actuals:
  tokens: 11000
  tasks: 2
  commits: 2
---

# Phase PTYCAP-05 Plan 03: Proof verifier Summary

Pure, dependency-injected `verifyProof(github, run)` that decides main_advanced, pr_scope_violation, pr_open_green or the non-terminal no_pr / ci_pending / ci_red / ci_unverifiable from GitHub facts only (ProofRun frozen fields + read-only ProofGithub). No write call, no timer, no agent-text input. 47 tests pass (`bun test hub/test/orchestrator-proof-verifier.test.ts`), `tsc --noEmit` clean for the new file.

## Commits

- aec4c80 feat: default-branch advance and PR scope detection (Task 1)
- 31cf545 feat: CI evaluation and pr_open_green decision (Task 2)

## Deviations from Plan

None - plan executed as written. Test run from repo root (`bun test hub/test/...`) rather than `cd hub`.

## Notes for consumers (05-05/06/07)

- `pending` observations carry `prUrl`/`prNumber`/`headSha` when a PR exists; terminal ones carry PR ref when known.
- A stale closed PR from an earlier run with a different `proof/<id>` head is terminal pr_scope_violation (plan-literal); arm/cleanup must ensure no foreign `proof/` heads exist on the throwaway repo.
- Green path performs a second compare after the CI read (race guard), so a green tick costs two compare calls.

## Known Stubs

None.

## Threat Flags

None. No new endpoints, write paths or installs.

## Self-Check: PASSED

- proof-verifier.ts and the test file exist; commits aec4c80 and 31cf545 exist.
- Acceptance greps (last_action/sentinels/STATE, setTimeout/setInterval/sleep) print nothing for proof-verifier.ts.
