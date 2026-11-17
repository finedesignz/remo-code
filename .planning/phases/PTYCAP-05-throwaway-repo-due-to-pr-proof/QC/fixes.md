# PTYCAP-05 QC fixes

## Round 1 fixes (A)

Branch phase-ptycap-05-throwaway-repo-proof. Each test file run in its own process (`bun test <file>`); all green.
Mutation checks (disable the new check, watch the new tests fail) done for the run-identity gate and the proof-owned marker.
Note: fix 1 was implemented before its tests (no red run); fixes 2-4 had their key tests verified non-vacuous by mutation.

| Finding | Commit | Test(s) |
|---|---|---|
| codex #1 / adversary MAJOR 1 - exclusivity (arm, dry run, --enable refuse while ANY other orchestrator task is enabled, all users; runtime dispatches only the claimed proof task, typed reason `proof_mode_non_proof_task`; runbook prerequisite + refusal row) | bfdb294 | orchestrator-proof-dal (arm/enable tx + dry-run count), orchestrator-proof-arm (refusal codes, enableProof), orchestrator-proof-gates (no-run refused), orchestrator-proof-tracer (non-proof task blocked, never dev macro) |
| codex #2 - stale queued prompts (server-only `proofRunId` on DispatchRequest; budget gate + final pre-send check in `finalHaltCheck` require exact active-run match; arm halts the session via kill switch and cancels pending routine cycles in-tx; enable releases the halt) | 0d27ecf | orchestrator-proof-run-identity (ordinary dev prompt parked before arm, replayed through the real `dispatch()` + grace drain, never reaches send; control proof request does), orchestrator-proof-dal (arm halts/cancels, enable releases), orchestrator-proof-gates |
| codex #3 - disarm ordering (kill switch inserted BEFORE the terminal UPDATE in the same transaction; pre-send active-run recheck is in 0d27ecf) | 6c6c43d | orchestrator-proof-disarm (statement order lock -> kill insert -> run UPDATE, one begin; failure rolls both back), orchestrator-proof-run-identity (c: run terminal after gates stops send) |
| adversary MINOR - proof task falls back to dev macro when a flag is off (`scheduled_tasks.proof_owned` marker set at arm, carried on the loaded task row; `runMacroCycle` refuses before any reconcile/db work unless the full stack is ON) | e3a3824 | orchestrator-proof-owned-flag-matrix (all 8 flag combinations, zero reconcile/runlog, control for non-proof tasks, resolveCycleContext), orchestrator-proof-schema (column DDL pin), orchestrator-proof-dal (arm sets marker) |

Regression runs (each in its own process, 0 fail): orchestrator-proof-noop, token-cap-coverage, counter-key-assignment-guard, kill-switch-coverage, dispatch-pipeline, automation-controls-*, every test file matching orchestrator|schema|controller|scheduled|ptycap|dispatch|kill.

Not covered by local runs: `hub/test/e2e/proof-checks.ts` (real postgres, Woodpecker only). The new SQL (kill-switch INSERT ... SELECT in disarm, routine_queue cancel, proof_owned column, enabled-task count) is plain idempotent DML/DDL but has only been exercised against the in-memory fake.

Deliberate behavior notes
- Arm engages a session kill switch and `--enable` releases it (it also releases a stale terminal/proof kill on that session; a manually engaged session switch on the proof session is released too).
- Queued/grace requests live in hub memory and cannot be reached from the arm script; they are invalidated by the exact `proofRunId` match, which an ordinary dev prompt can never satisfy.
- `proof_owned` is permanent for a task (a proof task is not reused for real dev work).

## Round 1 fixes (B)

Each touched/new test file run in its own process; 114 files matching orchestrator|schema|controller|scheduled|ptycap|dispatch|kill|token|repo-key|usage|counter-key|merge|agent: 0 fail. orchestrator-proof-noop, token-cap-coverage, counter-key-assignment-guard green. Mutation checks (disable the new check, watch the new tests fail) done for fix 2 and fix 3. Fix 1: new tests written first and run red (module / assertion missing) before the implementation. Fix 4: tests written before code, not separately run red.

| Finding | Commit | Test(s) |
|---|---|---|
| codex #4 - usage persist failure under-counts the hard token budget. VERIFIED (agent.ts caught and dropped it). Mechanism: failed persist marks the session in `hub/src/usage/attribution-loss.ts`; `sumSessionTokensSince` returns `attributionLost` for any window the loss falls in; budget gate -> `proof_budget_attribution_lost`, tick evaluator -> `terminated:budget_attribution_lost`. No outbox. | 4e1acab | ptycap-usage-attribution-loss (handler marks on failure, not on success; window semantics; bounded; DAL surfaces it), orchestrator-proof-gates, orchestrator-proof-evaluators |
| codex #5 - PR scope. VERIFIED (adapter dropped off-prefix PRs; no head repo). `listPullsWithHeadPrefix` -> `listPulls` (all recent PRs + head repo, author, created_at). Verifier: PR created after arm from a non-`proof/` head, or run-branch PR whose head repo != armed repo (or deleted), -> `pr_scope_violation`. | fed75fe | orchestrator-proof-verifier (fork, deleted, case-insensitive, off-prefix new/old/undated), orchestrator-proof-github-adapter, fake-github, evaluators |
| codex #6 - canonical repo identity. VERIFIED. `canonicalGithubRepoIdent` in lib/repo-key.ts; armProof + armProofRunTx canonicalize (allowlist compare/insert, session repo_key compare, proof row); `findActiveProofRunForRepo` canonicalizes the lookup; schema adds `CHECK (repo_ident = lower(repo_ident)) NOT VALID` so the existing partial unique index is single-flight over the canonical value. The proof table is not on main, so no existing row can conflict; no one-shot script needed. | c95cdf9 | orchestrator-proof-arm, orchestrator-proof-dal (mixed case stored canonical, twin allowlist row, lookup any casing, non-github ident rejected), orchestrator-proof-schema |
| lens-correctness MINOR 2 - merge refusal skipped on null repoKey. VERIFIED. Now `proof_repo_never_merges:unverifiable` when the proof flag stack is on. | 92998ed | orchestrator-proof-merge-refusal (null repoKey refused with no lookup; flag OFF unchanged) |
| lens-adversary MINOR 3 - arm with agent_permission unverified. VERIFIED. Now refuses `agent_permission_unverified` (dry run too). MINOR 6 - no budget ceiling. VERIFIED. Ceilings injects 50 / tokens 50M / wall 24h: arm `invalid_budget` + additive NOT VALID CHECKs. Runbook updated. | e29a03c | orchestrator-proof-arm (default harness now passes agent-login), orchestrator-proof-schema, ptycap-05-runbook |

Scope limits stated plainly
- Fix 1 detects a persist failure the hub SAW. It is process memory: a hub restart forgets the mark, and a usage_event that never reaches the hub (hub down) is not observable. A durable outbox was explicitly out of scope; the limit is in the runbook residuals.
- Fix 2 treats ANY PR created after arming from a non-`proof/` head as a violation (not only agent-authored; author is recorded in the detail). The repo is a throwaway.
- Not covered locally: `hub/test/e2e/proof-checks.ts` (real postgres, Woodpecker). The new schema statements (3 DO blocks of NOT VALID CHECKs) are plain idempotent DDL, exercised only by the source-scan schema test. `bunx tsc` shows only pre-existing errors in ws/agent.ts / orchestrator-merge-command.test.ts, none in touched lines.

## Round 2 fixes (final round)

Each touched/new test file run in its own process (`bun test <file>`), 0 fail. Mutation checks (disable the new check, watch the new tests fail) done for A, D, E/F, B, C. All findings VERIFIED (none refuted).

| Finding | Commit | Test(s) |
|---|---|---|
| codex new #1 - global exclusivity race. Arm, disarm and enable now share ONE hub-global `pg_advisory_xact_lock` (`PROOF_LOCK_KEY`); the enabled-task count is rechecked under it. The fake sql now models real blocking advisory-lock semantics. | 74781c0 | orchestrator-proof-dal (two users enabling concurrently: one wins, one `other_orchestrator_task_enabled`; all three txs take the same key) |
| codex #2/#3 - stale send / disarm race. `buildSend` (exported) persists, then with proof mode ON delivers via `sendAtProofBoundary`: fresh kill-switch read + active-run identity recheck while holding the same global lock arm/disarm/enable take; refusal throws `proof_send_refused:<reason>`. Flag OFF: unchanged, no lock. | 9c3d3a6 | orchestrator-proof-send-boundary (REAL buildSend; disarm and arm each committed while the insert is parked: refused, socket untouched; control delivers behind the lock; flag OFF takes no lock) |
| codex new #2 + sonnet MINOR 1 - kill switch ownership. Arm refuses `session_halt_engaged` for a foreign engaged session halt, releases only stale proof-tooling halts (engaged_by arm-orchestrator-proof / proof-guard), stores the id of the row it engaged in additive `orchestrator_proof_runs.kill_switch_id`; `--enable` releases exactly that id. | b22ad39 | orchestrator-proof-dal (foreign halt refused and kept, id recorded, post-arm owner halt survives enable, stale proof halt replaced), orchestrator-proof-schema |
| sonnet MINOR 3 - allowlist case twin. Disarm deletes `WHERE user_id AND lower(repo_ident) = canonical`. | b22ad39 | orchestrator-proof-dal (mixed-case twin removed, other repo untouched) |
| codex #4 - durable attribution. `sumSessionTokensSince` compares completed assistant turns with `token_usage` rows over [since, now-120s); fewer rows reports `attributionLost` (existing consumers terminalize `budget_attribution_lost`). Survives restart, no eviction, no new DDL. In-process mark kept as an extra early signal. | 31e4eee | orchestrator-proof-dal (turn without ledger row lost with the in-process mark reset; matched turns ok; grace/streaming/user/other-session/pre-arm ignored) |
| codex #5 - PR pagination. `listPulls(owner, repo, since)` pages newest-first (50/page) until a short page or a page whose last PR predates `armed_at`; page cap 40 or any page error throws, verifier stays pending (fail closed). | ec5dd85 | orchestrator-proof-github-adapter (post-arm off-prefix PR on page 2 returned; early stop; cap fails closed; later page error propagates) |

Behaviour notes (owner visible, in docs/ptycap-05-proof-runbook.md): new refusal `session_halt_engaged`; a stale halt left by a previous proof run no longer needs manual release (arm replaces it) but a manual one does; a completed assistant turn with no usage event (e.g. cancelled) now reads as attribution loss and ends the proof (fail closed); PR scope scans all pages since arm.

Not covered locally: real Postgres (hub/test/e2e/proof-checks.ts, Woodpecker): the new SQL (halt SELECT/INSERT RETURNING/release by id, `lower(repo_ident)` DELETE, completed_turns/usage_rows counts, ADD COLUMN) is exercised only against the in-memory fake. Sonnet MINOR 2 (proof_owned permanent on a reused task) remains documented, not changed.
