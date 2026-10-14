# PTYCAP-05 QC round 2 - adversary + correctness (sonnet)

Method: read diff b9cb500..HEAD for DAL, gates, guard, pipeline/automation-controls, inject, macro-cycle, verifier, github adapter, repo-key, schema, arm, attribution-loss. Ran (each own process, all 0 fail): run-identity 6, dal 35, disarm 10, usage-attribution-loss 6, tracer 20, owned-flag-matrix 11, verifier 51, merge-refusal 7.

## Round-1 findings

| # | Finding | Status | Evidence |
|---|---|---|---|
| codex 1 / adv MAJOR 1 | other enabled orchestrator task gets dev macro | FIXED | arm + `--enable` both call `assertNoOtherEnabledOrchestratorTask` in-tx, all users (dal). Dry run counts others (proof-arm step 11). Runtime: `proofGuard` returns blocked `proof_mode_non_proof_task` instead of pass_through; `proofIdentityRefusal` refuses a request with no run. Tests: dal, arm, gates, tracer. |
| codex 2 | stale queued/parked dev prompt after arm | FIXED | server-only `proofRunId` set only in macro-cycle from claimed run; budget gate and `finalHaltCheck`->`proofFinalCheck` require `req.proofRunId === active run.id`. Arm engages session kill switch and cancels pending routine_queue in tx. `orchestrator-proof-run-identity` replays a parked ordinary prompt through real `dispatch()`; would fail without the id match. |
| codex 3 | disarm ordering | FIXED | `disarmProofRunTx` inserts the session kill switch before the terminal UPDATE in one tx; pre-send recheck covers a terminal committed after gates. Disarm test locks statement order and rollback. |
| codex 4 | usage persist failure undercounts | FIXED with documented limit | see judgment below. |
| codex 5 | PR scope (off-prefix, fork) | FIXED | `listPulls` returns all PRs + head repo/author/created_at; verifier terminates on post-arm off-prefix PR (undated = violation), foreign head repo, deleted fork. Verifier tests cover each. |
| codex 6 | repo-ident case | FIXED | `canonicalGithubRepoIdent` applied in arm, DAL (allowlist compare, stored row), lookup; `CHECK (repo_ident = lower(...)) NOT VALID`. |
| adv MINOR 2 | dev macro on flag drift | FIXED | `scheduled_tasks.proof_owned`, `runMacroCycle` step 0 refuses with zero db work; 8-combination matrix test. |
| adv MINOR 3 / 6 | unverified agent perm, unbounded budgets | FIXED | `agent_permission_unverified` refusal; ceilings in arm + NOT VALID CHECKs. |
| corr MINOR 2 | null repoKey skips merge refusal | FIXED | now refuses `:unverifiable`; test added. |

## New findings

1. MINOR (judged; not a block) - `--enable` releases ANY engaged session-scope kill switch for the proof session, including a manual owner emergency stop. `orchestrator-proof-dal.ts` enableProofTaskTx UPDATE (~line 300) filters only `scope='session' AND session_id`. `--enable` is an explicit owner act, the scope is one throwaway-repo session, user/global switches are untouched, and arm's INSERT is DO NOTHING (so a manual row is kept at arm). Still, silently clearing a human stop is a weakening of a safety control. Fix: add `AND engaged_by = 'arm-orchestrator-proof'` (and have the proof terminalizer's engager use the same literal, or accept a small set), and have enable refuse `session_kill_switch_manual` otherwise. Runbook already states the release.
2. MINOR - `proof_owned` is permanent on a REUSED task (`dal` arm UPDATE). If the owner's real dev task for that session was reused, it becomes inert under flag OFF forever. Only armed tasks affected; flag-OFF behavior for every other task unchanged. Document (done in fixes.md) or arm should refuse to reuse a pre-existing non-proof task.
3. MINOR - mixed-case pre-existing allowlist row is treated as the same repo (canonical compare), arm then inserts the canonical twin; disarm deletes only the canonical one, leaving the old row. Cleanup nit; the allowlist then still holds the throwaway repo. Fix: compare/delete canonical-normalized in SQL (`lower(repo_ident)`).

No fail-open, merge-path, budget-bypass, flag-OFF, or race defect found in the fixes. Flag-OFF: new code is behind `isProofEnabled()`/`proofOwned` and dynamic imports; `finalHaltCheck` opts default off.

## Judgment: #4 in-memory attribution-loss mark

Acceptable, not a MAJOR fail-open. Requires a persist failure AND a hub restart before the next gate/tick evaluation (every dispatch and tick, ~30 min) with the DB healthy again. Exposure is the tokens of the failed turn(s), bounded independently by the arm ceilings (50 injects, 50M tokens, 24h), the global daily token cap, and the per-session inject-rate cap. A fully down DB already fails the gates closed. Events that never reach the hub are unobservable under any design short of agent-side ack. Residual is disclosed in the runbook. Recommended later hardening (not required): persist the mark (column on proof run) or terminalize active proof runs on boot.

## Verdict: PASS

(Findings 1-3 advisory MINOR; finding 1 is the one worth fixing before the live arm.)
