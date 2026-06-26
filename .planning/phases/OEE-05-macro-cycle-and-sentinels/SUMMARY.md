# OEE-05 — TMAC runMacroCycle + sentinel reconciliation (e2e) — SUMMARY

Branch: feat/orchestrator-e2e-proveout (worktree remo-code-oee). Test-only; no commit.

## Deliverable
hub/test/e2e/orchestrator-macro-cycle.e2e.test.ts — drives REAL runMacroCycle(input, sink.deps)
against real Postgres via the OEE harness + scripted sink. describe.skip without REMO_E2E_DB_URL.

## Proves (8 tests)
1. INJECT: dev type -> ONE macro prompt captured; real DEV prompt body, {repo_path} substituted;
   macro:dev resume run-log row written through (outcome=dispatched).
2. INJECT type-discrimination: security type -> SECURITY-HARDENING macro body.
3. RECONCILE: prior reply <<STATE>>+<<NOTIFY>> parsed by real sentinels.ts, reconciled into a
   routine_run_log STATE row: decision_rationale carries lifecycle=building;milestone=OEE;next=...,
   outcome='building' (STATE.lifecycle), deploy_verify_result='no' (STATE.deployed_live); then re-injects.
4. HALT: open mandatory <<GATE>> at production-maintenance -> halted, injected=false, captured=0;
   STATE still reconciled first; blocking gate notify fans out.
5. CONTINUE: halting stage, no open gate -> re-injects.
6. STAGE SENSITIVITY: same open <<GATE>> at development -> does NOT halt, re-injects
   (stageHalts = beta|production-maintenance proven e2e).

## Verification
- bun test hub/test/e2e/orchestrator-macro-cycle.e2e.test.ts -> 0 pass / 8 skip / 0 fail
  (no REMO_E2E_DB_URL here -> clean skip). With disposable PG the 8 assertions run for real.
- Typecheck: spec's hub/tsconfig.json does NOT exist in repo (hub runs on Bun default TS; no
  project tsconfig — same for every hub test). No type errors reference this file under
  Bun-appropriate resolution. Bare-tsc bun:test/allowImportingTsExtensions diagnostics hit
  every test file identically, not introduced here.

## Seams / notes for OEE-06 + OEE-07
- No seam added. Uses existing MacroCycleDeps DI via createScriptedSink(). hub/src untouched.
- DATABASE_URL repoint: run-log DAL binds shared sql to DATABASE_URL at import. Test sets
  DATABASE_URL=REMO_E2E_DB_URL BEFORE importing macro-cycle.ts (mirrors phase-08), passes sql:h.sql
  to sink so write-throughs land in the queried DB. OEE-06/07 must keep this ordering for DB asserts.
- OEE-06 cost-cap: this phase uses sink.inject override (captures prompt, returns canned dispatched),
  NOT the real injectOrchestratorPrompt/dailyCostCapGate. To prove the cap, OEE-06 swaps deps.inject
  for the REAL injectOrchestratorPrompt so the turn traverses the non-bypassable gate. Macro-cycle is
  cap-honest: every inject flows through deps.inject. Do NOT assert a bypass.
- OEE-07 notify: reconcile calls deps.fanOut; sink captures all in sink.notifies
  ({event,level,detail,channels}). Assert full stage matrix off sink.notifies, no real outbound.
  Dedup: when both <<GATE>> and blocking <<NOTIFY>> present, GATE owns the single gate fan-out
  (blocking NOTIFY suppressed) — exactly one gate page/turn.
- Run-log shape: STATE -> command='state'; resume -> command='macro:<type>', outcome=<inject kind>.
  run-live/stub paths emit outcome='skipped'/'stub_not_ready'.
