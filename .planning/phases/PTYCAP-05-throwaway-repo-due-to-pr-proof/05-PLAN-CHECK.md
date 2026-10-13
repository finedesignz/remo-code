# PTYCAP-05 Plan Check (goal-backward)

Verdict: PASS (0 BLOCKERs, 3 WARNs). No plan edits were required.

## Coverage
- SC-1 (branch-only, never merges, one allowlisted repo, hard budget) is implemented in code + tests: 05-02 (ruleset protection, fail closed), 05-03 (detective verifier, compare vs base_sha), 05-05 (proofBudgetGate / proofProtectionGate on both inject gate lists, merge refusal), 05-06 (evaluator chain), 05-07 (arm, exactly-one allowlist under advisory xact lock).
- SC-2 / SC-3 are runbook-only and worded "armed-ready, live proof pending owner GO" (05-09, pinned by ptycap-05-runbook.test.ts). Nothing in the repo flips flags or enables the task.
- Verdict amendments F1/F2/F3 each map to a task + test: branch-lock/review-gate + zero bypass (02), frozen id+digest+updated_at, drift/unverifiable terminals (02/05), base_sha compare (03), non-admin agent credential (02/07), Administration/Checks/Statuses read probe + owner grant (02/07/09), scrub not relied on (06 test), advisory-lock arm/disarm + CHECK + partial unique indexes + DO-block DDL (01), token attribution fail closed (01/05), claimed-snapshot render, no dev-macro fallback, final-string grep (01), rollback order (07/09).

## Ordering
- Wave 1: 01. Wave 2: 02, 03, 04 (disjoint files). Wave 3: 05, 06, 07 (disjoint; 06 explicitly does not edit macro-cycle.ts/inject.ts, which 01 and 05 own). Wave 4: 08, 09 (disjoint). depends_on edges are consistent with files_modified; no same-wave overlap.
- Spot-checked symbols/paths exist: inject.ts taskId + resolveInjectCounterKey, automationKillSwitchGate, automationLifetimeCounterGate, runMergeToMain, listInstallationRepos, githubApiRequest, github_installations, DO-block pattern, regression-baseline.json (pass_min 1850 / skip_max 260), kill-switch-coverage / token-cap-coverage / mount-order tests, e2e autospawn test.
- Verify commands are concrete (`cd hub; bun test <file>`) with fails_when clauses. Flag-OFF true no-op: 01 tracer + 08 differential matrix (zero SQL/fetch).

## bypass_actors / App permission note
05-02 treats absent/null bypass_actors as `proof_protection_unverifiable` (detail bypass_actors_not_visible), never as empty; 05-07 dry run names the missing permission and states the App token cannot see bypass actors; 05-09 runbook names Administration-read, Checks-read, Commit-statuses-read and presents the write-visibility dependency as an owner decision with no attestation bypass. Fails closed as required.

## Issues
1. WARN: No explicit global network-ban in the proof tests; GitHub isolation relies on the injectable request fn and fakes. 05-08 asserts zero fetch only for the flag-OFF matrix. Executor should stub globalThis.fetch to throw in the proof test files.
2. WARN: Advisory-lock behavior is only provable on real Postgres (05-08 e2e helper, DB-gated, skipped in the floor config); DB-free tests use fakes. Accepted, consistent with Phase 4.
3. WARN: bypass_actors likely requires write-level ruleset access, so arming may be refused until the owner decides the App permission level; this is a go/no-go dependency, not a code defect.
