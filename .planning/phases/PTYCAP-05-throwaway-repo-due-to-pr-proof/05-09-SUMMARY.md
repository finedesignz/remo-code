---
phase: PTYCAP-05-throwaway-repo-due-to-pr-proof
plan: 09
subsystem: docs
tags: [runbook, owner-gate, rollback-order, docs, pin-test]
requires: [05-04, 05-05, 05-06, 05-07]
provides:
  - docs/ptycap-05-proof-runbook.md (owner OWNER GO/NO-GO arming and ordered rollback runbook)
  - hub/test/ptycap-05-runbook.test.ts (10 pins on the runbook and the CLAUDE.md entry)
  - CLAUDE.md env entry, docs map row, gate-list invariant
affects: []
key-files:
  created:
    - docs/ptycap-05-proof-runbook.md
    - hub/test/ptycap-05-runbook.test.ts
  modified:
    - docs/orchestrator-autospawn-runbook.md
    - docs/auto-dev-orchestrator.md
    - docs/usage-cost.md
    - docs/HANDOFF.md
    - CLAUDE.md
    - .planning/ROADMAP.md
decisions:
  - "Runbook states the daily token ceiling default as 20M (the value in hub/src/dispatch/gates.ts), not the older 50M figure still quoted elsewhere in CLAUDE.md"
  - "bypass_actors visibility is written as an owner dependency with no workaround, matching the code (no attestation path)"
  - "Phase 5 checkbox in the Phases list stays unchecked; Progress row reads 'Executed (9/9 plans) - live proof pending owner GO'"
status: complete
plan_head_before: 6888a23253dc1055e7b60e25f43748f19ac4dbca
commits: 3
actuals:
  tokens: 9300
  tasks: 3
  commits: 3
---

# Phase PTYCAP-05 Plan 09: Owner runbook and docs Summary

One owner runbook now carries the whole arming and rollback procedure for the throwaway-repo proof, and every doc matches what 05-01..05-08 actually built. Nothing was armed, no flag was set, and no GitHub, Coolify or prod system was contacted. The live arming remains an OWNER GO/NO-GO.

## Commits

- cfe7568 docs: owner runbook + autospawn runbook pr_url correction and pointer
- 6ea2ec6 docs: CLAUDE.md env/docs-map/invariant, auto-dev-orchestrator, usage-cost, HANDOFF
- 1279179 test: runbook pin test + ROADMAP delivery notes and progress

## What the runbook matches (built reality)

- CLI: `--user --session --repo-ident --installation-id [--agent-login] [--max-injects --max-tokens --max-wall-ms] [--every --unit] [--dry-run | --enable | --disarm]`; `--enable`/`--disarm` need only `--user`; `DATABASE_URL` required, `REMO_E2E_DB_URL` not honoured (05-07 deviation).
- All 13 arm refusal codes (including 05-07's extra `invalid_schedule`) with owner actions; outcome table with notification classes read from `proof-guard.ts`.
- Permissions Administration/Checks/Commit-statuses read; ruleset shapes branch-lock (preferred) and review-gate; empty bypass list; non-admin agent credential verified via the collaborator permission endpoint.
- Rollback order: kill switch or transactional `--disarm` FIRST, then unset the flags, then redeploy, with the online-session-bypasses-autospawn reason.
- Residuals and the `routine_run_log.pr_url` truth (autospawn runbook Step 5 corrected).

## Verification

- `bun test test/ptycap-05-runbook.test.ts`: 10 pass; `bun test test/docs-supersession.test.ts`: 4 pass.
- `bun run docs:sync`: no diff to `docs/openapi.json` or `docs/api.md`.
- `bun run check-baseline`: OK (actual pass=3100 skip=259 fail=0; baseline 3090/259/0).
- No deletions in any commit.

## Deviations from Plan

**1. [Process] Pin test written after the runbook, not watched-RED first.** The runbook was authored with the pinned statements in mind, so the 10 tests passed on first run (same pattern as 05-01/05-05/05-06). The ordering assertion compares indexes inside the rollback section and the merge-line assertion filters every line mentioning merge, so each fails against a runbook that lacks the statement.

**2. [Rule 1 - accuracy] Gate lists and evaluator order read from code, not the plan prose.** The proof gates ride the two `inject.ts` gate lists (online-session and autospawn paths), not "inject and drain"; the evaluator order is kill switch, repo match, protection, verifier, agent-declined, budget (`proof-evaluators.ts`). Docs state the code's truth.

**3. [Rule 1 - accuracy] Daily token ceiling default stated as 20M** (code) in the new docs; the older 50M figure elsewhere in CLAUDE.md was left untouched (out of scope).

None else. A stray `grep.exe.stackdump` from an aborted shell pipeline was deleted before the commit; it was never tracked.

## Known Stubs

None.

## Threat Flags

None. Docs use placeholders only (`<owner>`, `<repo>`, `<user-id>`, ...); a pin test rejects token-looking strings.

## Owner action required

The live proof is not armed. Follow `docs/ptycap-05-proof-runbook.md`; the owner decisions are the throwaway repo, the budget numbers if the defaults are wrong, and the GO (`--enable`).

## Self-Check: PASSED

Files present: docs/ptycap-05-proof-runbook.md, hub/test/ptycap-05-runbook.test.ts. Commits cfe7568, 6ea2ec6, 1279179 verified on the branch.
