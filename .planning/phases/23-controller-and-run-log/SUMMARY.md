# Phase 23 — controller-and-run-log · SUMMARY

**Status:** Complete (PASS, 3/3) · commits `52b5045` (feat), `dea21af` (docs) on `feat/auto-dev-orchestrator`

Per-tick controller decision core. Decision-core ONLY — wave fan-out (Phase 24) + gsd-command seam (Phase 25) deferred via no-op seam.

## Delivered
- `hub/src/orchestrator/due-rows.ts` — pure `computeDueRows`/`isRowDue` (Never=disabled, Once=max_runs=1 auto-disable, cron/window/bounds via REUSED `shouldSkipFire`+`boundReason`); returns ALL due; DB helper `computeDueRowsForTask`.
- `hub/src/orchestrator/run-log.ts` — thin `appendRunLog`/`recentRunLog` over Phase-21 DAL.
- `hub/src/orchestrator/controller.ts` — `buildControllerContext` (best-effort, degrades-empty), `renderControllerPrompt` (SPEC §4), `parseControllerDecisions` (malformed→safe `continue`), `writeRunLogFromBlocks`, `runWaves` (Phase-24 no-op seam), `registerCycleRunnerIfEnabled` (flag gate, sole `setCycleRunner` caller).
- 3 test files (26 tests).

## Safety
`REMO_ORCHESTRATOR_ENABLED` default OFF ⇒ no runner registered ⇒ queue dormant ⇒ prod unaffected. Not yet boot-wired (Phase 24 owns session→task→user resolution).

## Verification
26 pass / 0 fail; baseline 1346 / 0 fail. DB e2e deferred (no PG host) — carried to the pre-enablement integration gate.
