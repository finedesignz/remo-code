# Phase 27 — verify-loop-tail · SUMMARY

**Status:** Complete (PASS) · commit `d358b25` (+ coolify-client chunk) on `feat/auto-dev-orchestrator`

The mandatory terminal step of every orchestrator cycle: confirm the app is deployed, live, and error-free in logs — bounded fix loop.

## Delivered
- `hub/src/lib/coolify-client.ts` — read-only `fetchAppLogs()`.
- `hub/src/orchestrator/verify-tail.ts` — `runVerifyTail`: reuses P5 `triggerRedeploy` + `runDeployVerify`/`formatVerifyReport`; adds log fetch + `LOG_ERROR_PATTERNS` scan; **bounded `MAX_FIX_ITERATIONS=3`** loop (redeploy→probe→scan; PASS stops; else cost-cap-gated fix via P25 inject → re-verify); surface-to-chat (Phase-28 notify stub) + run-log on exhaust. Verdict `pass|fail|skipped`.
- `controller.ts` — `runVerifyTail` wired after `runWaves` (flag-gated, try/catch).

## Safety
Flag-OFF default; missing COOLIFY/target env → `skipped` no-op (no network/crash); hard loop cap; all network mocked in tests.

## Verification
14 pass / 0 fail; baseline 1411 / 0 fail.
