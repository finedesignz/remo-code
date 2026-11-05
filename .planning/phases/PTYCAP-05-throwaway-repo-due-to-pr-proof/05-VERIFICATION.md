---
phase: PTYCAP-05-throwaway-repo-due-to-pr-proof
verified: 2026-10-13
status: human_needed
ship_verdict: SHIP-AFTER-OWNER-GO
score: SC-1 PASS (code+tests); SC-2 BLOCKED-owner; SC-3 BLOCKED-owner; amendments 17 PASS / 2 PARTIAL
branch: phase-ptycap-05-throwaway-repo-proof (PR #511 draft)
head_verified: 783dcf1e6eac04ccffc9bdb849d097a03f393844
---

# Phase 5 (PTYCAP-05) Verification Report

**Goal (ROADMAP):** The orchestrator produces one reviewable PR, unattended, on a repo nobody cares about.
**Stance:** SUMMARY claims not trusted. Every row below was checked against code and a test run in this session
(each file run as `bun test <file>` in its own process; all counts below are from those runs).
Nothing was armed, no flag was set, no GitHub / Coolify / prod / browser system was touched.

## Success criteria

| SC | Text | Verdict | Evidence |
|----|------|---------|----------|
| SC-1 | Branch-only. Never merges to main. One whitelisted repo. Hard budget. | **PASS** (code + tests) | See SC-1 detail |
| SC-2 | Produces a reviewable PR with a green CI check, or cleanly does nothing and says why | **BLOCKED-owner** | Machinery proven vs fake GitHub and real Postgres in CI; the real unattended run needs the owner GO. Not PASS. |
| SC-3 | This has never once happened; until it does the orchestrator is unproven | **BLOCKED-owner** | Closes only when one real proof reaches `pr_open_green` (or an honest `nothing:`) live. Zero live runs exist. |

### SC-1 detail (proven in code, no live system needed)

- **Never merges:** merge routing refuses any repo owned by an armed/running proof run, fail closed on lookup error and on null repoKey: `hub/src/orchestrator/merge-command.ts:133,139,141` (`proof_repo_never_merges`, `:unverifiable`). Tests `orchestrator-proof-merge-refusal.test.ts` 7 pass (armed refused; flag-OFF unchanged; null repoKey fail closed; lookup error fail closed).
- **Prompt cannot instruct a merge/deploy:** `hub/src/orchestrator/proof-prompt.ts:21-28` (default branch read-only, push only `proof/<run-id>`). `orchestrator-proof-tracer.test.ts` "FINAL string carries none of the banned tokens" (merge/deploy/release/--admin/force absent, every push line names the proof branch) - 20 pass.
- **Hub detective layer:** `proof-verifier.ts:56-73,134,167` compares `base_sha` to the default branch (any commit since arm = `terminated:main_advanced`), PR scope violation / fork / off-prefix / wrong base (`:154-165`), a merged proof PR = `main_advanced`. `orchestrator-proof-verifier.test.ts` 51 pass.
- **Preventive layer (ruleset):** `proof-protection.ts:92-93,175-177,190` accepts only branch-lock or review-gate shapes plus required checks plus zero bypass actors; bypass list not visible = `proof_protection_unverifiable`. `orchestrator-proof-protection.test.ts` 50 pass.
- **One allowlisted repo, single flight:** `schema.sql:1758-1763` partial unique indexes (one non-terminal proof per user, per repo, per task); `other_repo_allowlisted` refusal `proof-arm.ts:239`; DAL transactions under `pg_advisory_xact_lock` `orchestrator-proof-dal.ts:133`. `orchestrator-proof-arm.test.ts` 33, `-dal` 45, `-schema` 6 pass.
- **Hard budget:** defaults 6 injects / 3,000,000 tokens (four buckets) / 6 h wall, ceilings 50 / 50M / 24 h (`proof-arm.ts:33-41,152`), mirrored as DB CHECKs (`schema.sql:1725-1746`). `proofBudgetGate` and `proofProtectionGate` are in BOTH orchestrator gate lists (`inject.ts:303-304,462-463`); coverage scans `token-cap-coverage` 4 pass and `kill-switch-coverage` 11 pass; `orchestrator-proof-gates.test.ts` 24 pass.
- **Flag-OFF no-op confirmed:** `orchestrator-proof-noop.test.ts` 39 pass: differential across 7 OFF flag combinations - identical injected args to the dev macro, zero SQL, zero fetch, proof module never loaded, gates pass through with zero dep calls, merge routing unchanged (`:183-316`).

## Amendments (GATES/verdict.md)

| # | Amendment | Verdict | Evidence |
|---|-----------|---------|----------|
| F1-1 | Ruleset must be branch-lock / un-self-suppliable review, plus required checks, zero bypass; "PR + green" rejected | PASS | `proof-protection.ts:92-93,115-117,175-177`; protection tests 50 pass |
| F1-2 | Freeze ruleset id + digest + updated_at at arm; re-assert before EVERY dispatch; fail closed -> `proof_protection_unverifiable` / `_drift` | PASS | `proof-protection.ts:68-84,204-216`; `proofProtectionGate` `inject.ts:304,463`; gates test 24 pass |
| F1-3 | Detective: any commit on default branch since arm base_sha terminates | PASS | `proof-verifier.ts:56-73,126,134`; verifier test 51 pass |
| F1-4 | Agent credential non-admin, arm-time assertion | PASS (with caveat) | `proof-protection.ts:258` `assertAgentNotAdmin` called `proof-arm.ts:222`; `--agent-login` required (`agent_permission_unverified`). Caveat: only checked at arm, not per dispatch |
| F1-5 | App Administration-read + Checks-read requested; absence fails arm closed; grant is owner step | PASS | `proof-protection.ts:230-231,240`; `proof-arm.ts:193` (`proof_permissions_missing`); `docs/HANDOFF.md:49-50` |
| F1-6 | Credential scrubbing NOT relied on | PASS | `orchestrator-proof-no-scrub-reliance.test.ts` 3 pass; runbook s2 |
| F2-1 | Arm/disarm single transactions under advisory xact lock; recheck allowlist + no active proof | PASS | `orchestrator-proof-dal.ts:87,122,133,138,180`; arm/disarm tests 33/10 pass |
| F2-2 | DB-enforced status CHECK, positive budget CHECKs, partial unique indexes | PASS | `schema.sql:1714-1763` |
| F2-3 | Budget must not lose tokens on session delete; fail closed if attribution impossible | PARTIAL | Session-gone is detected and fails closed: `token-usage-dal.ts:248-270`, `proof-gates.ts:178`, `proof-evaluators.ts:161` (tests dal:454, gates:206, evaluators:309). In-DB per-turn detector compares AGGREGATE counts (`token-usage-dal.ts:~279-288`) - open QC MAJOR 1 |
| F2-4 | Idempotent DDL via DO-block pattern | PASS | `schema.sql:1712-1756`; `orchestrator-proof-schema.test.ts` 6 pass |
| F3-1 | proofGuard returns the claimed snapshot; atomic armed->running before render; no second lookup | PASS | `proof-guard.ts:155-182` (`claimActiveRun`); tracer test "ONE claim, prompt rendered from the claimed snapshot" |
| F3-2 | Lookup/render error or proof task with no override => NO injection, never the dev macro | PASS | `proof-guard.ts:164,179-182`; `orchestrator-proof-owned-flag-matrix.test.ts` 11 pass (every flag combination) |
| F3-3 | Test greps FINAL injected string for merge/deploy/push-to-main | PASS | tracer test `FINAL string carries none of the banned tokens` |
| F3-4 | Rollback order: kill switch / transactional disarm FIRST, then unset flags; runbook says so | PASS | runbook s5; `ptycap-05-runbook.test.ts` 10 pass; `orchestrator-proof-disarm.test.ts` 10 pass |
| F3-5 | Macro_task_type stays 'dev', prompt override keyed on claimed run (`proofRunId`) | PASS | `inject.ts:105,327,456`; `orchestrator-proof-run-identity.test.ts` 6, `-send-boundary` 4 pass |
| Fork | Merge routing refuses proof repo | PASS | see SC-1 |
| Fork | Proof mode hub-exclusive (non-proof orchestrator dispatch refused) | PASS | `proof-gates.ts` / `proof-guard.ts` `proof_mode_non_proof_task`; `other_orchestrator_task_enabled` at arm |
| Fork | Kill-switch ownership | PARTIAL | Arm refuses a pre-existing foreign halt (`session_halt_engaged`). A manual engage AFTER arm is not distinguishable from the proof-owned row; `--enable` could release it (open QC MAJOR 2). `schema.sql:1641-1642` allows one engaged row per session |
| Fork | Runbook flags/codes exist in code | PASS | verified below |

## Verified test runs (each in its own process)

All 21 `hub/test/orchestrator-proof-*.test.ts` files: 0 fail. Also `ptycap-05-runbook` 10, `ptycap-usage-attribution-loss` 6, `token-cap-coverage` 4, `kill-switch-coverage` 11, `mount-order` 23: 0 fail. I did NOT re-run `bun run check-baseline` (full gate); QC/VERDICT.md records it OK (pass 3169 / skip 259 / fail 0).

## Open items

1. **QC MAJOR 1 (OPEN) - budget attribution uses aggregate counts.** A lost usage row can be masked by an extra row from another turn (`token-usage-dal.ts` ~279-288). Fix: per-turn correlation id on `usage_event` and `token_usage`, or a durable usage outbox keyed to the proof run. Reachable only when armed.
2. **QC MAJOR 2 (OPEN) - kill-switch ownership.** A manual engage after arm cannot be told apart from the proof-owned row; `--enable` could release it. Fix: multiple engaged rows per scope with owner tags, or a separate proof halt mechanism.
3. **Runbook overstatement (doc defect tied to MAJOR 2).** `docs/ptycap-05-proof-runbook.md` step 3 says a halt engaged by anyone else "after arm: it survives `--enable`". That is not guaranteed while MAJOR 2 is open. Correct the sentence or close MAJOR 2 before the owner relies on it.
4. QC seat gap: `agy` not run (seat MISSING); the cross-model panel was Sonnet x2 plus Codex only. QC state is BLOCKED per the 2-round cap, so a content block remains open and needs fix-then-re-QC (or the owner accepting the two residuals) before merge.
5. F1-4 residual: agent non-admin is asserted at arm only; a later privilege grant is not re-checked per dispatch.
6. Runbook s6 states the 20M daily token cap default; code confirms `gates.ts:164` = 20M (root CLAUDE.md still says 50M - doc drift outside this phase).
7. Supervisor/MSI: no new signed supervisor is required for this phase per the runbook (stream-json macro path, PTY producer D-01 deferred).

## BLOCKED-owner: exact arming runbook (copied from docs/ptycap-05-proof-runbook.md; every flag, endpoint, env var and refusal code referenced was grepped in code and exists)

Verified existing in code: CLI flags `--user --session --repo-ident --installation-id --agent-login --dry-run --max-injects --max-tokens --max-wall-ms --every --unit --enable --disarm` (`hub/scripts/arm-orchestrator-proof.ts`); env `REMO_ORCHESTRATOR_PROOF/_ENABLED/_AUTOSPAWN`, `REMO_PROOF_MAX_INJECTS/_TOKENS/_WALL_MS`, `REMO_ORCHESTRATOR_DAILY_TOKEN_CAP`; `GET /api/orchestrator/proof` (`hub/src/index.ts:499`); `GET /api/automation/kill-switch`, `POST /kill-switch/engage`, `/release` (`hub/src/api/automation.ts:108,119,134`); all 16 arm refusal codes plus `proof_not_armed`, `proof_mode_non_proof_task`, `proof_repo_never_merges`, `bypass_actors_not_visible`, `proof_protection_drift`; all runbook outcome codes in `proof-types.ts` / `proof-evaluators.ts` / `proof-verifier.ts`. Script refuses without `DATABASE_URL` and ignores `REMO_E2E_DB_URL` (`arm-orchestrator-proof.ts:93-94`).

**Owner prerequisites (s3), verify before dry run**
1. Phases 3, 4, 5 PRs merged and deployed; hub live by bundle hash (not /health); kill switch NOT engaged (`GET /api/automation/kill-switch`).
2. GitHub App: add Administration (read), Checks (read), Commit statuses (read); installation owner accepts. Dry run must not report `proof_permissions_missing`.
3. Dependency: ruleset `bypass_actors` visibility. If dry run shows `proof_protection_unverifiable` / `bypass_actors_not_visible`, arm refuses by design (owner decision on App permission level; no override path).
4. Create a throwaway repo; install the App; add a CI workflow with a stable check name (else `no_ci_workflow`).
5. Create ruleset on the default branch, Active, EMPTY bypass list. Branch-lock (preferred: restrict updates, deletions, force pushes + required CI check) or review-gate (PR with >=1 approval of latest push, no force push, required CI check). "PR + green check" alone is rejected.
6. Make the agent credential non-admin (write only on that repo); verify with `GET /repos/<owner>/<repo>/collaborators/<login>/permission`; pass `--agent-login <login>` (required, else `agent_permission_unverified`).
7. Disable every other orchestrator task first (hub-exclusive; else `other_orchestrator_task_enabled`).
8. A supervisor online and a session whose `repo_key` = `github://<owner>/<repo>`; autospawn allowlist empty or exactly that repo.

**Steps (s4)**
1. Dry run (zero writes): `bun run hub/scripts/arm-orchestrator-proof.ts --user <user-id> --session <session-id> --repo-ident github://<owner>/<repo> --installation-id <installation-id> --agent-login <login> --dry-run` (optional `--max-injects N --max-tokens N --max-wall-ms N --every N --unit minutes|hours`; ceilings 50 / 50,000,000 / 86,400,000 ms).
2. Resolve any refusal (exit 2) per the runbook s4 table.
3. Arm (data only): same command without `--dry-run` - one transaction creates the single allowlist entry, the DISABLED proof task, its due-scan row, the frozen proof run, and engages a proof-owned session kill switch.
4. Owner sets hub env `REMO_ORCHESTRATOR_PROOF=1`, `REMO_ORCHESTRATOR_ENABLED=1`, `REMO_ORCHESTRATOR_AUTOSPAWN=1`, reviews `REMO_ORCHESTRATOR_DAILY_TOKEN_CAP`, redeploys the hub.
5. Verify idle safety: `GET /api/orchestrator/proof` shows `armed`, no session spawned, task disabled, zero other enabled orchestrator tasks. Otherwise roll back.
6. GO: `bun run hub/scripts/arm-orchestrator-proof.ts --user <user-id> --enable` (only on an armed run, else `proof_not_armed`).
7. Monitor event-driven (no polling): `GET /api/orchestrator/proof`; `routine_run_log` rows `autospawn-launch` / `proof-outcome`; the throwaway repo (PR from `proof/<run-id>`, default branch unchanged).
8. Outcomes: `pr_open_green` (blocking notify, includes PR url) = SC-2/SC-3 evidence; `nothing:<reason>` (quiet) = SC-2 clean no-op, SC-3 not closed; `terminated:<reason>` (blocking).
9. After any terminal outcome: `--disarm` and unset `REMO_ORCHESTRATOR_AUTOSPAWN` (single-shot).

**Abort / rollback (s5), exact order:** (1) FIRST `POST /api/automation/kill-switch/engage` body `{"scope":"session","session_id":"<session-id>","reason":"proof abort"}` OR `bun run hub/scripts/arm-orchestrator-proof.ts --user <user-id> --disarm`; (2) THEN unset `REMO_ORCHESTRATOR_PROOF` and `REMO_ORCHESTRATOR_AUTOSPAWN`; (3) THEN redeploy the hub. Reversing the order lets the ordinary dev macro (which squash-merges green PRs) run unguarded on the throwaway repo.

Owner decisions: which throwaway repo; budget numbers if defaults are wrong; the GO (`--enable`).

## Ship verdict

**SHIP-AFTER-OWNER-GO.** SC-1 and all F1/F2/F3 amendments are implemented and tested; flag-OFF is a proven no-op. Merge of the machinery PR is safe (everything defaults OFF). SC-2 and SC-3 stay BLOCKED-owner until the live run; Phase 5 must stay unchecked in ROADMAP until a real `pr_open_green` is recorded. Before the owner uses arming, fix or explicitly accept open QC MAJORs 1 and 2 and correct the runbook sentence (item 3). If the owner will not accept those two residuals, treat the verdict as NEEDS-WORK for arming only.

## Repair round (post-BLOCKED)

Commit 932c71b fixes both BLOCKED MAJORs (per-turn usage correlation via `turn_id`; owner-tagged session halts so `--enable` cannot release a manual engage). Evidence: touched tests pass individually, `bun run check-baseline` OK (pass 3173, fail 0). Codex re-QC: fixes clean; one NEW MAJOR recorded, not fixed (120s grace keyed on `messages.created_at` can yield a fail-closed false positive `budget_attribution_lost` for turns longer than 120s; see QC/VERDICT.md). Final status: SC-1 PASS; SC-2/SC-3 BLOCKED-owner (unchanged); PR remains draft pending the grace-timestamp fix. SHIP-AFTER-OWNER-GO unchanged.
