# OBSRV-04 Summary: Autospawn Shadow Dry-Run

**Status:** SHIPPED
**Branch:** `OBSRV-04-autospawn-shadow-dry-run`

## What shipped

Flag-gated shadow dry-run for build-session autospawn. With `REMO_ORCHESTRATOR_AUTOSPAWN_SHADOW=1`,
`maybeAutospawnOffline` runs the full AND-chain then writes a run-log row with
`command='autospawn-shadow'`, `outcome='shadow_would_spawn'` and returns WITHOUT calling
`launchSessionForUser` or dispatching any prompt.

## Files changed

- `hub/src/orchestrator/controller.ts` — `isAutospawnShadowEnabled()`
- `hub/src/orchestrator/inject.ts` — shadow intercept, InjectOutcome variant, InjectDeps field, REAL_DEPS
- `hub/test/orchestrator-autospawn-shadow.test.ts` — 8-test guard (all green)

## Test results

8 pass, 0 fail (23 expect() calls) — covers SHADOW-01..04.

## Operator runbook

1. Set `REMO_ORCHESTRATOR_AUTOSPAWN_SHADOW=1` (with autospawn gates ON + allowlist populated).
2. Wait for orchestrator tick; query run-log for `command='autospawn-shadow'` rows.
3. When satisfied, remove shadow flag — real autospawn fires.

Shadow rows NOT counted toward daily launch cap (filtered by AUTOSPAWN_LAUNCH_COMMAND).
