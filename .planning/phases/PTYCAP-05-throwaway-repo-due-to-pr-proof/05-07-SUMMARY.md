---
phase: PTYCAP-05-throwaway-repo-due-to-pr-proof
plan: 07
subsystem: orchestrator
tags: [proof, arm, disarm, enable, operator-cli, fail-closed, frozen-budget]
requires: [05-01, 05-02]
provides:
  - armProof / disarmProof / enableProof cores with injectable deps (hub/src/orchestrator/proof-arm.ts)
  - operator CLI hub/scripts/arm-orchestrator-proof.ts (--dry-run, arm, --enable, --disarm)
  - read-only lookups hub/src/db/orchestrator-proof-arm-reads.ts
affects: [05-08, 05-09]
key-files:
  created:
    - hub/src/orchestrator/proof-arm.ts
    - hub/scripts/arm-orchestrator-proof.ts
    - hub/src/db/orchestrator-proof-arm-reads.ts
    - hub/test/orchestrator-proof-arm.test.ts
    - hub/test/orchestrator-proof-disarm.test.ts
    - hub/test/orchestrator-proof-script-guard.test.ts
  modified: []
decisions:
  - "arm writes arm_preconditions.bypass_verification = 'verified' exactly (05-04 key); evaluateProtection only succeeds with bypass actors visible and empty"
  - "Precondition order and codes: github_app_unconfigured, invalid_budget, (invalid_schedule), installation_not_owned, repo_not_in_installation, session_repo_mismatch, proof_permissions_missing, no_ci_workflow, proof_protection_unverifiable|insufficient, agent_credential_is_admin, other_repo_allowlisted"
  - "Budgets: flag, then deps.env REMO_PROOF_MAX_*, then 6 / 3000000 / 21600000; digits-only positive integers, garbage refuses"
  - "Unreadable agent permission is recorded agent_permission='unverified' with a warning, never a refusal"
  - "Core detects tx errors by ProofStateError name/code so it imports no sql client"
status: complete
plan_head_before: 8bc140ecf70697fe3c958ccd54048517d9831950
commits: 3
actuals:
  tokens: 60000
  tasks: 3
  commits: 3
---

# Phase PTYCAP-05 Plan 07: Arm / disarm / enable mechanism Summary

Data-only owner entry mechanism for the one-repo proof: an ordered fail-closed arm decision with a read-only dry run and frozen budgets, a disarm that runs the transaction before the session kill switch, an enable that works only on an armed run, and a thin CLI guarded by a static scan. Nothing was run against a real database, GitHub or prod; all tests use fakes.

## Commits

- 83fb6b4 feat: armProof core + dry run (26 tests)
- aaae10d feat: disarm and enable cores (10 tests)
- 636a8d8 feat: operator CLI, reads DAL, static guard (15 tests)

## Verification

- orchestrator-proof-arm 26 pass, orchestrator-proof-disarm 10 pass, orchestrator-proof-script-guard 15 pass
- token-cap-coverage 4 pass, counter-key-assignment-guard 3 pass
- acceptance greps: no `process.env.X =` and no `coolify` in the script or core

## Deviations from Plan

**1. [Rule 3 - Blocking] SQL lookups moved to a new DAL file.** The static-scan requirement forbids SQL text in the script and core, but the plan also wanted installation and session lookups "through the shared sql" inside the script. Added `hub/src/db/orchestrator-proof-arm-reads.ts` (two read-only SELECT helpers). Not in `files_modified`; no existing file touched.

**2. [Rule 3] `REMO_E2E_DB_URL` not honoured.** The precedent copies it into `process.env.DATABASE_URL`; the plan prohibits any assignment to `process.env`. The CLI requires `DATABASE_URL` and says so.

**3. `--name` flag dropped.** `armProofRunTx` has no task-name field (it inserts 'Orchestrator'); adding one would change the 05-01 DAL. Cadence is passed via `scheduleRule`.

**4. Extra refusal code `invalid_schedule`** for a bad `--every`/`--unit` (not in the plan list; arm refuses rather than defaulting on garbage).

## Known Stubs

None.

## Threat Flags

None. The CLI is local-operator only, makes no network call of its own (GitHub reads go through the existing adapter) and prints ids and digest prefixes, never a token.

## Self-Check: PASSED

Files and commits 83fb6b4, aaae10d, 636a8d8 verified present.
