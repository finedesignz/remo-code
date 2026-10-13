---
phase: "5"
slug: "throwaway-repo-due-to-pr-proof"
status: draft
nyquist_compliant: true
wave_0_complete: true
created: "2026-10-13"
---

# Phase 5 - Validation Strategy

> Per-phase validation contract. One bun process per test file (Bun `mock.module` is process-global). No local Postgres exists on the dev host: DB-backed proof is the helper `hub/test/e2e/proof-checks.ts`, called from the body of ONE EXISTING DB-gated e2e test (`orchestrator-autospawn.e2e.test.ts`), executed only by Woodpecker (postgres:16, `REMO_E2E_DB_URL`), read once from the draft PR's qc run. ZERO new `test()` calls in any e2e file, ZERO new skips.
> The LIVE proof (a real PR with green CI from a real due task) is OWNER-GATED and is NOT validated here. Phase 5 verification reports SC-2/SC-3 as "armed-ready, live proof pending owner GO", never PASS.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Bun test 1.3.14 (hub unit tests are DB-free; leaf-module mocks; fake `sql` and fake `ProofGithub` local to each test via `hub/test/fixtures/proof-fake-sql.ts` and `proof-fake-github.ts`) |
| **Config file** | `hub/bunfig.toml` (preload `./test/_setup.ts`) |
| **Quick run command** | `cd hub; bun test test/<touched>.test.ts` (one file per process) |
| **Full suite command** | `bun run check-baseline` (per-file isolation; floors pass_min 1850, skip_max 260, fail_max 0; run with a 600 s timeout) |
| **Type gate** | `cd hub; bunx tsc --noEmit -p tsconfig.json \| grep -c "error TS"` must be <= 427 |
| **Other gates** | `bun run schema-lint` (exit 0); `bun run docs:sync` then no further diff in `docs/openapi.json` / `docs/api.md` |
| **Skip budget** | baseline skip 259, `skip_max` 260: ZERO new skipped tests. Any new `test()` in an e2e file, any `skip_max` bump, or a vacuous early return in place of the DB gate fails the phase. |
| **Network** | NONE. Every GitHub interaction in tests goes through the injectable `ProofGithub` fake or an injected `request` function. |

---

## Sampling Rate

- **After every task commit:** the quick command for each test file the task touched, plus `bun run schema-lint` when `schema.sql` changed.
- **After every plan (wave end):** `bun run check-baseline` + the tsc count.
- **Before `/gsd-verify-work`:** full phase gate (below) green.
- **Max feedback latency:** 60 s for quick runs.

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|--------|
| 05-01-T1 | 01 | 1 | SC-1, SC-2, NOOP, F2-2, F2-4, F3-1, F3-2 | T-05-01..04 | TRACER: armed run -> claim (one UPDATE...RETURNING) -> proof prompt from the claimed snapshot -> decline -> single-winner terminal (1 run-log row, 1 notification, task disabled, session kill); OFF identical to today; no dev-macro fallback | integration over fakes + schema-lint | `cd hub; bun test test/orchestrator-proof-tracer.test.ts` ; `cd hub; bun test test/orchestrator-macro-cycle.test.ts` ; `bun run schema-lint` | pending |
| 05-01-T2 | 01 | 1 | F2-1, F2-2, F2-3, F2-4 | T-05-03, T-05-21 | arm/disarm/enable each ONE txn under advisory lock; exactly-one allowlist; rollback leaves nothing; four-bucket token sum with attribution flag; monotone hwm | unit (fake sql) + static pin | `cd hub; bun test test/orchestrator-proof-dal.test.ts` ; `cd hub; bun test test/orchestrator-proof-schema.test.ts` ; `bun run schema-lint` | pending |
| 05-01-T3 | 01 | 1 | SC-1 | T-05-05 | read-only ProofGithub contract; typed failures; shared deterministic fake | unit | `cd hub; bun test test/orchestrator-proof-fake-github.test.ts` | pending |
| 05-02-T1 | 02 | 2 | SC-1, F1-5 | T-05-08, T-05-10 | adapter is GET-only; exact REST paths; 403/404/other mapped; bypass_actors absent -> null | unit (injected request) | `cd hub; bun test test/orchestrator-proof-github-adapter.test.ts` | pending |
| 05-02-T2 | 02 | 2 | SC-1, F1-1, F1-2, F1-4, F1-5, F1-6 | T-05-06..09 | branch_lock / review_gate only; PR+green-check rejected; zero VISIBLE bypass; unverifiable vs drift; permission probe; agent-admin check; no scrub reliance | unit | `cd hub; bun test test/orchestrator-proof-protection.test.ts` | pending |
| 05-03-T1 | 03 | 2 | SC-1, F1-3 | T-05-11, T-05-13, T-05-14 | any commit past base_sha (compare) = main_advanced; merged/wrong-base/foreign proof PR terminal | unit | `cd hub; bun test test/orchestrator-proof-verifier.test.ts` | pending |
| 05-03-T2 | 03 | 2 | SC-2 | T-05-12 | green only with complete success evidence incl. frozen required contexts; truncated/unreadable never green | unit (matrix) | `cd hub; bun test test/orchestrator-proof-verifier.test.ts` | pending |
| 05-04-T1 | 04 | 2 | SC-2 | T-05-15..17 | read-only, tenant-scoped GET; no write methods; no id/credential leak; mounted after auth | route unit + mount pin | `cd hub; bun test test/orchestrator-proof-api.test.ts` ; `cd hub; bun test test/mount-order.test.ts` | pending |
| 05-04-T2 | 04 | 2 | SC-2 | T-05-SC | OpenAPI registered; generated docs in sync | generator | `bun run docs:sync` | pending |
| 05-05-T1 | 05 | 3 | SC-1, F1-2, F2-3, CK, NOOP | T-05-18..21 | budget gate (injects / four-bucket tokens / wall), key pin, terminal-run block, attribution lost, per-dispatch protection re-assert, OFF zero calls, ON fails closed | unit | `cd hub; bun test test/orchestrator-proof-gates.test.ts` | pending |
| 05-05-T2 | 05 | 3 | SC-1, NOOP | T-05-23 | both inject lists: kill FIRST, proof gates 2nd/3rd, counter LAST; scan non-vacuous | static scan | `cd hub; bun test test/kill-switch-coverage.test.ts` ; `cd hub; bun test test/token-cap-coverage.test.ts` ; `cd hub; bun test test/orchestrator-autospawn-inject.test.ts` ; `cd hub; bun test test/orchestrator-inject-counterkey.test.ts` | pending |
| 05-05-T3 | 05 | 3 | SC-1 | T-05-22 | `proof_repo_never_merges` refusal with run-log row and zero inject; existing merge behavior unchanged | unit | `cd hub; bun test test/orchestrator-proof-merge-refusal.test.ts` ; `cd hub; bun test test/orchestrator-merge-command.test.ts` ; `cd hub; bun test test/orchestrator-autospawn-no-automerge.guard.test.ts` | pending |
| 05-06-T1 | 06 | 3 | SC-1, SC-2, F1-2, F2-3, F3-2 | T-05-24, T-05-25 | locked evaluator order; tick-side budget termination with no inject; wait vs proceed; budget outcome naming | unit | `cd hub; bun test test/orchestrator-proof-evaluators.test.ts` | pending |
| 05-06-T2 | 06 | 3 | SC-2, CK | T-05-26 | inject-outcome mapping onto closed sets (>= 12 cases); counterKey === `task:<id>` online and autospawn; single page per refused tick | unit | `cd hub; bun test test/orchestrator-proof-counterkey.test.ts` ; `cd hub; bun test test/orchestrator-proof-tracer.test.ts` ; `cd hub; bun test test/orchestrator-macro-cycle.test.ts` | pending |
| 05-06-T3 | 06 | 3 | SC-1, SC-2, F1-6, F3-2, F3-3 | T-05-27, T-05-28 | >= 9 multi-tick scenarios with exactly-once effects; FINAL injected string has no banned token and only the exact-branch push; no scrub reliance | integration over fakes + static scan | `cd hub; bun test test/orchestrator-proof-cycle.test.ts` ; `cd hub; bun test test/orchestrator-proof-no-scrub-reliance.test.ts` | pending |
| 05-07-T1 | 07 | 3 | SC-1, F1-2, F1-4, F1-5, F2-1 | T-05-29..32 | ordered fail-closed arm preconditions (>= 10 codes), frozen budget/protection/base_sha, dry run writes nothing | unit | `cd hub; bun test test/orchestrator-proof-arm.test.ts` | pending |
| 05-07-T2 | 07 | 3 | F2-1, F3-4 | T-05-33 | disarm txn FIRST then kill switch; exact-row scope; enable only from armed | unit | `cd hub; bun test test/orchestrator-proof-disarm.test.ts` | pending |
| 05-07-T3 | 07 | 3 | SC-1 | T-05-30, T-05-34 | CLI is data only: no flag assignment, no cap, no hosting-provider reference; no-DB dry run exits non-zero | static scan + spawn | `cd hub; bun test test/orchestrator-proof-script-guard.test.ts` | pending |
| 05-08-T1 | 08 | 4 | NOOP | T-05-35 | 7-combination OFF matrix: zero sql, zero fetch, identical inject args, parity with controller predicates | differential | `cd hub; bun test test/orchestrator-proof-noop.test.ts` | pending |
| 05-08-T2 | 08 | 4 | F2-1, F2-2, F2-3, F2-4 | T-05-36, T-05-38 | real Postgres: double-apply, 5-way arm race, DB-level unique indexes, CHECKs, exactly-once terminal, attribution after session delete, gate on real ledger, disarm scope | CI-only helper in an existing e2e body | `cd hub; bun test test/e2e/orchestrator-autospawn.e2e.test.ts` (parses; skipped locally) ; tsc count | pending |
| 05-08-T3 | 08 | 4 | NOOP | T-05-37 | full baseline green, skip unchanged, floors untouched | full gate | `bun run check-baseline` ; `bun run schema-lint` | pending |
| 05-09-T1 | 09 | 4 | SC-1, F1-4, F1-5, F1-6, F3-4 | T-05-39..41 | owner runbook: permission grant, repo + ruleset, non-admin agent credential, ordered rollback, honest scope | doc + supersession | `cd hub; bun test test/docs-supersession.test.ts` | pending |
| 05-09-T2 | 09 | 4 | NOOP | T-05-42 | CLAUDE.md env + docs map + supporting docs; docs-drift clean | doc + generator | `cd hub; bun test test/docs-supersession.test.ts` ; `bun run docs:sync` | pending |
| 05-09-T3 | 09 | 4 | SC-3, F3-4 | T-05-39, T-05-41 | runbook statements pinned (rollback order, permissions, empty bypass, live-proof-pending); ROADMAP delivery notes | doc pin | `cd hub; bun test test/ptycap-05-runbook.test.ts` | pending |

---

## Success Criterion -> Test Map

| Success criterion | Provable in this phase | Test files | Needs LIVE run |
|-------------------|------------------------|------------|----------------|
| SC-1 branch-only | prompt boundary on the FINAL injected string; verifier scope (head prefix, base); arm refuses insufficient protection | `orchestrator-proof-cycle.test.ts`, `orchestrator-proof-tracer.test.ts`, `orchestrator-proof-verifier.test.ts`, `orchestrator-proof-protection.test.ts`, `orchestrator-proof-arm.test.ts` | protection actually enforced by GitHub |
| SC-1 never merges to main | merge-routing refusal; main_advanced via compare(base_sha); per-dispatch and per-tick ruleset re-assertion; session kill on every terminal | `orchestrator-proof-merge-refusal.test.ts`, `orchestrator-proof-verifier.test.ts`, `orchestrator-proof-gates.test.ts`, `orchestrator-proof-evaluators.test.ts`, `orchestrator-proof-cycle.test.ts` | no merge occurred |
| SC-1 one whitelisted repo | exactly-one allowlist in pre-check and in-txn; single-flight unique indexes; 5-way arm race (CI) | `orchestrator-proof-arm.test.ts`, `orchestrator-proof-dal.test.ts`, `e2e/proof-checks.ts` | - |
| SC-1 hard budget | gate at injects/tokens/wall; tick-side termination with no inject; frozen budgets | `orchestrator-proof-gates.test.ts`, `orchestrator-proof-evaluators.test.ts`, `e2e/proof-checks.ts` | - |
| SC-2 PR with green CI | verifier green/pending/red/no-CI/truncated matrix; success scenario | `orchestrator-proof-verifier.test.ts`, `orchestrator-proof-cycle.test.ts` | a real PR with green CI exists |
| SC-2 or cleanly nothing + why | each `nothing:<reason>` mapped from an existing InjectOutcome; one run-log row, one notification; readable GET route | `orchestrator-proof-counterkey.test.ts` (mapping), `orchestrator-proof-cycle.test.ts`, `orchestrator-proof-api.test.ts`, `orchestrator-proof-tracer.test.ts` | - |
| SC-3 never happened | NOT closable here; runbook + pin test keep the wording honest | `ptycap-05-runbook.test.ts` | YES (owner GO) |
| (f) counter key | `counterKey === task:<id>` online and autospawn; key mismatch into the proof session blocked `lifetime_counter_key_missing` | `orchestrator-proof-counterkey.test.ts`, `orchestrator-proof-gates.test.ts` | - |
| Flag OFF true no-op | 7-combination differential; gates and merge path pass-through | `orchestrator-proof-noop.test.ts`, `orchestrator-proof-tracer.test.ts`, `orchestrator-proof-gates.test.ts` | - |

---

## Locked-Verdict Amendment -> Task -> Test Map

| Amendment | Encoded in | Test |
|-----------|-----------|------|
| F1-1 ruleset must be branch-lock OR review gate the author cannot self-supply, PLUS required checks, PLUS zero bypass (PR + green check is NOT preventive) | 05-02-T2 | `orchestrator-proof-protection.test.ts` ('pull_request + required_status_checks only' -> proof_protection_insufficient; null bypass -> unverifiable) |
| F1-2 freeze id + digest + updated_at at arm; re-assert before EVERY dispatch; fail closed -> `proof_protection_unverifiable` / `proof_protection_drift` | 05-02-T2 (freeze/drift), 05-05-T1 (per dispatch incl. replay), 05-06-T1 (per tick), 05-07-T1 (arm) | `orchestrator-proof-protection.test.ts`, `orchestrator-proof-gates.test.ts`, `orchestrator-proof-evaluators.test.ts`, `orchestrator-proof-arm.test.ts` |
| F1-3 detective: any commit past arm-time base_sha, not just HEAD equality | 05-03-T1 | `orchestrator-proof-verifier.test.ts` (ahead_by 1 while HEAD equality alone would miss) |
| F1-4 agent credential non-admin: runbook + arm-time assertion where readable | 05-02-T2, 05-07-T1, 05-09-T1 | `orchestrator-proof-protection.test.ts`, `orchestrator-proof-arm.test.ts`, `ptycap-05-runbook.test.ts` |
| F1-5 App requests Administration-read + Checks-read (+ Commit statuses-read); absence => arm fails closed; grant is an owner runbook step | 05-02-T2 (probe), 05-07-T1 (arm), 05-09-T1 (runbook) | `orchestrator-proof-protection.test.ts`, `orchestrator-proof-arm.test.ts`, `ptycap-05-runbook.test.ts` |
| F1-6 orchestrator session exempt from the git-push scrub => scrubbing NOT relied on | 05-02-T2 scan, 05-06-T3 scan, 05-09-T1 | `orchestrator-proof-protection.test.ts`, `orchestrator-proof-no-scrub-reliance.test.ts`, `ptycap-05-runbook.test.ts` |
| F2-1 arm/disarm single txn under per-user advisory xact lock; recheck exactly-one allowlist + no non-terminal proof | 05-01-T2, 05-07-T1/T2 | `orchestrator-proof-dal.test.ts` (beginCalls === 1, lock first), `orchestrator-proof-arm.test.ts`, `orchestrator-proof-disarm.test.ts`, `e2e/proof-checks.ts` (5-way race) |
| F2-2 DB-enforced status CHECK, positive budget CHECKs, partial unique single-flight | 05-01-T1 | `orchestrator-proof-schema.test.ts`, `e2e/proof-checks.ts` (raw INSERTs rejected) |
| F2-3 budget accounting must not lose tokens when a session is deleted; fail closed | 05-01-T2, 05-05-T1, 05-06-T1 | `orchestrator-proof-dal.test.ts` (sessionExists), `orchestrator-proof-gates.test.ts`, `orchestrator-proof-evaluators.test.ts`, `e2e/proof-checks.ts` (delete session) |
| F2-4 idempotent DDL via the DO-block pattern | 05-01-T1 | `orchestrator-proof-schema.test.ts`, `bun run schema-lint`, `e2e/proof-checks.ts` (double apply) |
| F3-1 proofGuard returns the claimed snapshot used to render; atomic armed->running; no second lookup | 05-01-T1 | `orchestrator-proof-tracer.test.ts` (lookup spy count) |
| F3-2 any lookup/render error or proof-owned task with no override => NO injection; never the dev macro | 05-01-T1, 05-06-T3 | `orchestrator-proof-tracer.test.ts`, `orchestrator-proof-cycle.test.ts` (guard-error scenario) |
| F3-3 test greps the FINAL injected string: no merge / deploy / push-to-main | 05-01-T1, 05-06-T3 | `orchestrator-proof-tracer.test.ts`, `orchestrator-proof-cycle.test.ts` (banned tokens + exact-branch push) |
| F3-4 rollback order: kill switch or transactional disarm FIRST, then unset flags | 05-07-T2, 05-09-T1/T3 | `orchestrator-proof-disarm.test.ts` (call order), `ptycap-05-runbook.test.ts` (document order) |

---

## Planning-Time Findings (carried into execution and VERIFICATION)

| # | Finding | Evidence | Where handled |
|---|---------|----------|---------------|
| 1 | CONTEXT assumption RESOLVED: installation id maps to a user through `github_installations(id, user_id, revoked_at)` | schema.sql:91 | 05-07-T1 (`installation_not_owned`) |
| 2 | CONTEXT assumption RESOLVED: the App has NO ruleset/checks read today (Contents, Metadata, Pull requests only) | docs/HANDOFF.md:45-49 | 05-02-T2 probe, 05-07-T1 refusal, 05-09 owner grant |
| 3 | CONTEXT assumption: `token_usage` carries `session_id` (the DAL writes it from the usage input; ON DELETE SET NULL on the FK) | token-usage-dal.ts:46-61, schema.sql:1334 | 05-01-T2, 05-05-T1, 05-08-T2; confirm live via `tokens_hwm` progress in the GET route |
| 4 | NEW: due-ness comes from `orchestrator_rows`, not `scheduled_tasks.schedule_rule`; the BSA-06 precedent script sets the latter, so a proof task armed that way would never fire | controller.ts scanAndEnqueueDueCycles -> computeDueRowsForTask | 05-01-T2 (arm inserts the row), 05-07-T1 |
| 5 | NEW RISK (owner dependency): GitHub documents that a ruleset GET returns `bypass_actors` only to a caller with WRITE access to the ruleset; an Administration-READ App token may receive none. The code fails closed (`bypass_actors_not_visible`) and offers no attestation path (verdict: fail closed on ambiguity). Arming may therefore be blocked until the owner decides the App permission level or a follow-up verdict amendment changes how zero-bypass is established | GitHub REST docs for rulesets (verified 2026-10-13) | 05-02-T2, 05-07-T1 message, 05-09-T1 runbook; surfaced in the planner report |
| 6 | `dispatchMergeIfDue` is exported but not called by the macro path; the refusal lives inside `runMergeToMain` so every route to it is covered | controller.ts:457; merge-command.ts | 05-05-T3 |
| 7 | Known drift: `routine_run_log.pr_url` is not reconciled from sentinels; the proof reads GitHub instead | macro-cycle.ts reconcileSentinels | 05-09-T1 corrects the autospawn runbook |

---

## Phase Gate (before /gsd-verify-work)

1. Every command in the per-task map exits 0 (the e2e file parses and is skipped locally).
2. `bun run check-baseline`: pass >= 1850, skip <= 260 (expected unchanged at 259), fail 0.
3. `bun run schema-lint` exit 0; tsc error count <= 427; `bun run docs:sync` leaves no diff.
4. The draft PR's Woodpecker qc run shows the real-Postgres section (`proof-checks.ts`) green.
5. VERIFICATION wording: SC-1 machinery PASS; SC-2 and SC-3 "armed-ready, live proof pending owner GO"; the automation `term.input` PTY producer deferral (D-01) and finding 5 are recorded.
6. No arming, no env flip, no Coolify/prod/DB access, no push or merge was performed by any plan.
