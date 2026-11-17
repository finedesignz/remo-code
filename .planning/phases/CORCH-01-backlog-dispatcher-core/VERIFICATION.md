---
phase: CORCH-01-backlog-dispatcher-core
verified: 2026-11-13
head: b6a723a
status: passed_with_notes
verdict: SHIP-WITH-NOTES
verifier: independent (rule 13), Sonnet; read-only except this file
supersedes: VERIFICATION.md at ad5c461
---

# CORCH-01 Verification (HEAD b6a723a)

Goal: backlog and dispatcher core in the remo-code hub with `REMO_CORCH_ENABLED` default OFF, fail-closed default QuotaProvider/Workspace/PrLookup, nothing able to launch in prod.

## Ship verdict: SHIP-WITH-NOTES

All must-haves verified with tools at HEAD b6a723a. No MISSING items. Notes below are plan-scope deviations and environment caveats, none blocking.

## Per-goal table

| # | Goal / must-have | Verdict | Evidence |
|---|---|---|---|
| 1 | Flag OFF default; OFF = store/list only, no evaluation, interval, timer, launch, send (R1.2) | PASS | `hub/src/corch/flag.ts` `corchEnabled()` default false, call-time read. Every entry point guards: `dispatcher.ts:802` (`onKillSwitchReleased`), `reconciler.ts:22,69,85,93`, `ws/agent.ts` hooks wrapped in `if (corchEnabled())`, `routes.ts:41` trigger. `corch-flag-off.test.ts` 4 pass (evaluateUser/All, timer, reconciler, triggers touch nothing). |
| 2 | Boot refuses when both CORCH and ORCHESTRATOR ON; boots in other 3 combos (R1.3) | PASS | `flag.ts` `assertCorchConfig()` throws on both truthy. `hub/src/index.ts:561` called directly after `assertTokenCapConfig()` inside the fatal try/catch (`process.exit(1)`). `corch-boot-assert.test.ts` 10 pass (4-combo matrix + 5-line proximity pin). |
| 3 | Claim exactly once under race at cap 1; per-item and per-project uniqueness (R1.7, R3.1, R3.2) | PASS | `store.ts:239` `pg_advisory_xact_lock`; partial unique indexes `idx_corch_runs_live_item` / `idx_corch_runs_live_project` in schema.sql. `corch-dispatcher.e2e.test.ts` on real Postgres: 28 pass, 0 fail, 0 skip. |
| 4 | Default Quota/Workspace refuse; item stays queued, attempts unchanged (R1.13, R1.11) | PASS | `quota-provider.ts:14` `quota_no_snapshot`; `dispatcher.ts:44` `workspace_unavailable`; `dispatcher.ts:48` PrLookup `unavailable`. Refusal path `endRefusal(..., false)` consumes no attempt. Covered by `corch-gates` (58 pass) and e2e. |
| 5 | Launch only via `governedLaunch` HEAL; prompt only via shared `dispatch()`; exact 8-gate list, kill switch first, lifetime last, key `corch:<id>` (R1.9-1.11) | PASS | `dispatcher.ts:452` `governedLaunch`; the single `gates:` literal at `dispatcher.ts:146-155`: automationKillSwitchGate, dailyCostCapGate, dailyTokenCapGate, corchProjectBudgetGate, corchConcurrencyGate, corchQuotaGate, sessionInjectRateGate, automationLifetimeCounterGate. `counterKey: buildCorchKey` only at `dispatcher.ts:182`. kill-switch-coverage, token-cap-coverage, counter-key-assignment-guard, launch-callers-guard all green (below). |
| 6 | Requeue with backoff 60s*5^(n-1); 3rd failure blocks + one notification; refusals never consume attempt (R3.4, R3.5) | PASS | `store.ts:294-298` (blocked at `attempts+1 >= max_attempts`, backoff formula); `dispatcher.ts:334,528` single `notifyBlocked`. e2e covers death requeue, third-failure blocked with one notification, one case per refusal. |
| 7 | Positive-knowledge reclaim; stalled-once; restart never double-launches (R3.3, R3.7) | PASS | `reconciler.ts` (sole `setInterval` at :70, flag-guarded); `corch-no-polling-guard` 2 pass; e2e restart-without-double-launch case green. |
| 8 | `ext:corch` EXPLICIT-only | PASS | `auth/scopes.ts` `SCOPE_EXT_CORCH` in ALL_SCOPES (doc-commented EXPLICIT-only); `ext-api-key-middleware.ts` 403 `insufficient_scope` for POST `/corch/work-items` unless `hasExplicitScope`; `api-keys-scopes.test.ts` extended; `corch-routes.test.ts` 13 pass (403-before-write, non-explicit refused). |
| 9 | Schema additive only | PASS | See schema section. |
| 10 | No API key / no secrets | PASS | `git diff origin/main..HEAD` added-lines grep for ANTHROPIC_API_KEY, sk-ant, sk-svcacct, OPENAI_API_KEY, key literals, private-key blocks, ghp_/xox tokens: 0 matches. `grep ANTHROPIC|api_key|apiKey` in `hub/src/corch/*.ts`: 0. |
| 11 | Prompt fence, docs, CLAUDE.md env entries | PASS | `corch-prompt.test.ts` 3 pass; `docs/corch.md` (182 lines); CLAUDE.md carries REMO_CORCH_ENABLED/LEASE_MS/RECONCILE_INTERVAL_MS + docs-map row + ext:corch note. |

## Schema (additive check)

`git diff origin/main..HEAD -- hub/src/db/schema.sql`: 70 added lines, 0 removed lines. Contents: `CREATE TABLE IF NOT EXISTS` x3 (corch_projects, corch_work_items, corch_runs), `CREATE (UNIQUE) INDEX IF NOT EXISTS` x3, `ALTER TABLE users ADD COLUMN IF NOT EXISTS corch_max_concurrent_runs INTEGER NOT NULL DEFAULT 1`, and a guarded `ADD CONSTRAINT ... CHECK (> 0)` in a `DO` block. Plan criterion 4 grep (drop|truncate|alter column type) prints 0. No UPDATE/DELETE/INSERT/DROP/TRUNCATE added. FKs `ON DELETE CASCADE` reference new CORCH tables or `users(id)` from the new tables only. Only touch of an existing table is the additive defaulted users column (+ CHECK, validated against the default on existing rows). `bun run schema-lint` exit 0 (5 pre-existing allowed pragmas, none new). `migration-verify` exit 0 (errors=0). `schema-double-apply.e2e` 9 pass, 0 fail.

## Guards and tests (each its own `bun test` process, foreground)

| Test | Result | Exit |
|---|---|---|
| kill-switch-coverage | 10 pass / 0 fail | 0 |
| token-cap-coverage | 7 pass / 0 fail | 0 |
| counter-key-assignment-guard | 9 pass / 0 fail | 0 |
| launch-callers-guard | 12 pass / 0 fail | 0 |
| corch-no-polling-guard | 2 pass / 0 fail | 0 |
| orchestrator-macro-path-guard | 5 pass / 0 fail | 0 |
| corch-boot-assert | 10 pass / 0 fail | 0 |
| corch-flag-off | 4 pass / 0 fail | 0 |
| corch-gates | 58 pass / 0 fail | 0 |
| corch-prompt | 3 pass / 0 fail | 0 |
| corch-routes | 13 pass / 0 fail | 0 |
| dispatch-release-closed-run | 9 pass / 0 fail | 0 |
| e2e/corch-dispatcher.e2e (real PG, fresh DB vf_final) | 28 pass / 0 fail | 0 |
| e2e/schema-double-apply.e2e | 9 pass / 0 fail | 0 |

## CI-equivalent baseline

Fresh DB `vf_final` (postgres 16, 127.0.0.1:55432), env DATABASE_URL = REMO_E2E_DB_URL = that DB, JWT_SECRET placeholder.
`bun run check-baseline`: **exit 0**. baseline pass=3643 skip=323 fail=0 total=3966; actual **pass=3881 skip=0 fail=0 total=3881**; "OK - within tolerance". Matches BASELINE-DB.md run 2 exactly.

## Typecheck

`cd hub && bun run typecheck`: **253 `error TS`** = baseline N0 (253), no increase; 0 errors in `src/corch/`, `test/corch*`, `test/e2e/corch*`. (Typecheck exits 1 on the pre-existing 253.)

## Other scripts

- `schema-lint`: exit 0. `migration-verify`: exit 0 once `psql` was put on PATH (without it: `'psql' is not recognized`, a local-tooling gap, the script itself documents Windows may lack psql; not a branch defect, no ticket).
- `docs:sync`: NOT RUN. It rewrites `docs/openapi.json` / `docs/api.md` and needs `npx widdershins` (network), which would violate this verifier's read-only rule. Evidence instead: the baseline suite (3881 pass, includes openapi coverage tests) is green; docs-drift CI (Woodpecker) is the authoritative check. Status UNABLE-TO-VERIFY locally; low risk.

## Prior review artifacts read

- **QC-CODEX-R4.md**: PASS on 317408d..b6a723a. HIGH (hook-ownership identity check in `pipeline.ts:442-479`) FIXED, regression `dispatch-release-closed-run.test.ts`; MED (DAL resolved before insert guard, `dispatcher.ts:668-699`) FIXED, tests `corch-gates.test.ts:782,807`. 271 tests pass across 15 isolated suites. Postgres e2e not run by that seat (run here instead: green). I independently re-ran the cited regression and gate tests: green.
- **BASELINE-DB.md**: local 28 failures arise only when `DATABASE_URL` is unset (config.ts falls back to localhost:5432); identical class on unmodified origin/main (27). With CI env, branch green and +136 passes over main, 0 new failures. Reproduced here: exit 0, 3881/0 fail. Confirmed local-environment, not CORCH-caused.

## Notes (non-blocking)

1. **Plan scope fence deviation, shared code changed outside the flag.** Plan criterion 12 required zero diff under `hub/src/dispatch`, but `hub/src/dispatch/pipeline.ts` changed (+17/-7): the hook-identity ownership check in `dispatch()` send-catch and finalHaltCheck refusal. It is not in the plan's `files_modified`, and it is NOT flag-gated: it runs for every dispatch caller (heal, scheduler, revanote, etc.). It was authorized by the 7c panel (PANEL-7C.md, synthesis: only the racy "hook already released while send awaited" corner changes; old code double-released a slot) and is regression-tested (`dispatch-release-closed-run.test.ts` 9 pass). I judge it a genuine latent-bug fix with no non-racy behavior change, but it is a prod-affecting change to a shared path; the PR body must state it plainly (panel already specified this).
2. **`hub/src/api/automation.ts` hook is unconditional import** (`resumeDeferredWork` always dynamic-imports dispatcher), but `onKillSwitchReleased` returns immediately when `!corchEnabled()` (`dispatcher.ts:802`), so OFF is a no-op. additions only (0 removed lines).
3. **Skip ceiling raised** in `tools/regression-baseline.json`: `skip_max` 295 -> 323 (pass floor 3503 -> 3643, floor skip 291 -> 323). Justified in-file (DB-gated e2e files skip without REMO_E2E_DB_URL); pass floor rose, so net stricter on passes, looser on skips.
4. **Schema runs on every prod boot**: `ALTER TABLE users ADD COLUMN ... NOT NULL DEFAULT 1` plus CHECK constraint touch the existing `users` table. Additive, metadata-only default on PG 11+, idempotent; consistent with rule 6 (no destructive DDL). Mention in PR so the deploy owner is aware.
5. Untracked planning files (`.planning/phases/CORCH-01-*/` PLAN, SUMMARYs, PANEL-7C, BASELINE-DB, etc.) are not committed; `git status` shows `??`. Commit them with the PR if they are meant to ship.
6. Local env: scratch DBs `vf_final`, `vf_mv` created on the local scratch Postgres (55432); harmless.

## Prod impact assessment

With flag default OFF and default Quota/Workspace/PrLookup fail-closed: no launch, no send, no timer or interval, no dispatcher evaluation. Always-on surface: three new tables + one defaulted `users` column (additive), cookie `/api/corch/*` and explicit-scope `/api/ext/corch/work-items` routes (store/list only), and the shared `pipeline.ts` ownership fix (note 1). Even with the flag ON, nothing can launch until CORCH-02/CORCH-09 replace the refusing defaults.

## MISSING / PARTIAL

None.
