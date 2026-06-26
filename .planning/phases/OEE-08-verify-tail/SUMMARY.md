# OEE-08 — verify-tail always-runs / no-op-when-unset (e2e) — SUMMARY

**File:** `hub/test/e2e/orchestrator-verify-tail.e2e.test.ts` (REMO_E2E_DB_URL-gated).

**Proves the terminal verify-tail vs real PG** via the shipped `runVerifyTail(ctx, depsOverride, targetOverride)` DI seam (every outbound dep stubbed — configFromEnv/triggerRedeploy/runDeployVerify/fetchAppLogs/inject/notify — zero network; real DB-backed `appendRunLog`):
- Stub target: verdict `pass`, exactly ONE `routine_run_log` row (command=`deploy-verify`, outcome=`verify_pass`).
- `resolveVerifyTargetFromEnv()` returns null when `REMO_VERIFY_*` unset.
- No-op when unset: verdict `skipped`, no redeploy/probe/log calls, exactly ONE `verify_skipped:*` row (no spurious pass/fail).

**Seam added:** none — existing `runVerifyTail` DI seam. No `hub/src`/`schema.sql` change, flag untouched.

**Verify:** `bun test ...orchestrator-verify-tail.e2e.test.ts` → 1 pass / 5 skip / 0 fail (no DB). Runs green vs real PG in the qc gate.
