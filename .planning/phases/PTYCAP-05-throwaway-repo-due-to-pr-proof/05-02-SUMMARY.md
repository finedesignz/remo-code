---
phase: PTYCAP-05-throwaway-repo-due-to-pr-proof
plan: 02
subsystem: orchestrator
tags: [proof, github, ruleset, protection, fail-closed, read-only]
requires: [05-01]
provides:
  - makeProofGithub (read-only ProofGithub over githubApiRequest, injectable request fn)
  - evaluateProtection / reassertProtection / protectionDigest / canonicalJson
  - assertGithubPermissions / assertAgentNotAdmin
affects: [05-03, 05-05, 05-06, 05-07]
key-files:
  created:
    - hub/src/orchestrator/proof-github.ts
    - hub/src/orchestrator/proof-protection.ts
    - hub/test/orchestrator-proof-github-adapter.test.ts
    - hub/test/orchestrator-proof-protection.test.ts
  modified: []
decisions:
  - "Accepted protection = branch_lock (update + required checks) or review_gate (approval>=1 + last-push approval + non_fast_forward + required checks), zero VISIBLE bypass actors; branch_lock wins when both"
  - "Contributing rulesets are those behind the rules the chosen shape relies on; rule types outside the shape are still in the digest (any new effective rule is drift)"
  - "Re-assert maps default-branch change and weakened shape to drift; any read failure or ambiguity to unverifiable"
status: complete
plan_head_before: 6a8ae2194d50835c14b73016092e25aea953b67b
commits: 2
actuals:
  tokens: 12500
  tasks: 2
  commits: 2
---

# Phase PTYCAP-05 Plan 02: GitHub adapter and protection logic Summary

Read-only GET-only ProofGithub adapter over the GitHub App transport plus a pure, fail-closed protection verifier (assert, freeze digest, re-assert/drift, permission probe, agent-admin check) implementing verdict F1-1/2/4/5/6. 65 tests across 2 files pass, no network, no env reads, `tsc --noEmit` clean for the new files.

## Commits

- 32e802c feat: read-only ProofGithub adapter (Task 1)
- c31da8e feat: protection assertion, freeze, drift, permission and agent-admin checks (Task 2)

## Deviations from Plan

### Signature adjustments (Rule 3 - blocking)

1. **owner/repo threaded explicitly.** ProofGithub methods take `(owner, repo, ...)`, so the plan's `evaluateProtection(github, {defaultBranch})`, `reassertProtection(github, frozen)` and `assertAgentNotAdmin(github, login)` could not compile as written. Actual signatures:
   - `evaluateProtection(github, {owner, repo, defaultBranch})`
   - `reassertProtection(github, frozen)` where `FrozenProtection` carries `owner` and `repo` (plan 05-05/06's `frozenFromRun` must populate them from `repo_owner`/`repo_name`)
   - `assertGithubPermissions(github, {owner, repo})`
   - `assertAgentNotAdmin(github, {owner, repo}, login | undefined)`
   - `makeProofGithub({installationId}, deps?)` (owner/repo are per-call, not per-factory)
2. **`listWorkflowFiles` appends `?ref=<ref>`** to the contents path (the contract takes a ref; the plan's path list omitted it).
3. **Ruleset/inactive/target/updated_at handling.** Inactive ruleset, non-branch target, id mismatch, empty rules and missing `updated_at` are `proof_protection_unverifiable` (per must_haves); a non-empty bypass list is `proof_protection_insufficient`; null bypass is `unverifiable` detail `bypass_actors_not_visible`.

None required an architecture change. No auto-fixed bugs.

## Known Stubs

None.

## Threat Flags

None. The adapter issues GET only; no new endpoints or write paths.

## Owner dependency (already tracked for plan 05-09)

`bypass_actors` is returned only to callers with write access to the ruleset, so an Administration-read App gets `null` and `evaluateProtection` will fail closed (`bypass_actors_not_visible`). The arm dry run must surface this; resolving it is an owner runbook decision (grant the App ruleset write for verification, or accept a different verification route).

## Self-Check: PASSED

- proof-github.ts, proof-protection.ts, both test files exist; commits 32e802c and c31da8e exist.
- Acceptance greps (write verbs, scrub helpers, githubApiGet in the proof modules) print nothing.
