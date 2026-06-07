# Phase 27 — verify-loop-tail · PLAN

Reqs: R-ADO-19 (always-appended verify tail), R-ADO-20 (Coolify log error-scan),
R-ADO-21 (bounded N=3 fix loop + run-log outcome). Decision D9.

## Goal
Terminal deploy/log-verify tail every orchestrator cycle ends with. REUSE the SHIPPED
auto-dev P5 deploy-verify (no reimplement). Add a Coolify runtime-log fetch + error-scan.
On failure → dispatch fix → re-verify, HARD-CAPPED at N=3, then surface to chat. Write the
outcome (deploy ok? routes ok? log clean? iterations? verdict) to routine_run_log.

## Assumptions (stated up front)
- P5 pieces to REUSE as-is (verified by reading):
  - `lib/coolify-client.ts`: `coolifyConfigFromEnv()` → `{token,baseUrl}|null`; `triggerRedeploy(cfg,uuid,fetchImpl)`.
  - `scheduler/deploy-verify-probe.ts`: `runDeployVerify(opts)` → `{healthOk,routes,pass}`; `formatVerifyReport`.
- Fix dispatch rides the P25 inject seam `injectOrchestratorPrompt` (inject.ts) — cost-cap-gated, text-only.
- Run-log write via P23 `appendRunLog` (NewRoutineRunLogEntry: deploy_verify_result is the outcome string).
- App uuid + base url come from env (`REMO_VERIFY_APP_UUID`, `REMO_VERIFY_BASE_URL`, `REMO_VERIFY_ROUTES`),
  guarded: missing Coolify token OR uuid → no-op `skipped` (NEVER crash, prod stays safe).
- Phase-28 propose-to-chat not built → thin `notifySeam` stub (marked Phase 28).

## Deliverables
1. `hub/src/lib/coolify-client.ts` — ADD `fetchAppLogs(cfg, uuid, opts?)` (GET logs API; best-effort, never throws).
2. `hub/src/orchestrator/verify-tail.ts`:
   - `LOG_ERROR_PATTERNS` (tunable regex set) + `scanLogForErrors(log)` → `{clean, matches[]}`.
   - `runVerifyTail(ctx, deps?)`: redeploy → runDeployVerify → fetchAppLogs+scan. If fail/dirty:
     dispatch fix (injectOrchestratorPrompt, cost-cap-gated) → re-run. HARD `MAX_FIX_ITERATIONS=3`.
     On exhaust → notifySeam(surface) + run-log. Always one `appendRunLog` with the outcome.
   - Graceful no-op when config absent (returns `{verdict:'skipped'}`).
   - All network/dispatch deps injectable for tests.
3. `controller.ts` — call `runVerifyTail` as TERMINAL step after `runWaves` in the live `makeCycleRunner`,
   behind the SAME `REMO_ORCHESTRATOR_ENABLED` flag. Wrapped best-effort (never wedge the tick).
4. `hub/test/orchestrator-verify-tail.test.ts` — mock coolify-client + inject + run-log:
   log-scan detect vs clean; bounded loop stops at ≤3 (no infinite); fail→fix→re-verify;
   success-first-try (no fix); flag-OFF dormancy; missing-env no-op; run-log entry written.

## Karpathy
Smallest diff. REUSE runDeployVerify + triggerRedeploy verbatim (import, don't reimplement).
Bounded loop is a hard `for (i<3)` — non-negotiable. No speculative scope. Mock all network in tests.
