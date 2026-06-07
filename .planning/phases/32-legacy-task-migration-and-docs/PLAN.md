# Phase 32 — legacy-task-migration-and-docs · PLAN

FINAL phase of m-auto-dev-orchestrator. Closes the Phase-25 controller→wave deferral so
the system functions end-to-end **when REMO_ORCHESTRATOR_ENABLED=1**, migrates legacy
scheduled tasks into the orchestrator model, and does the docs sweep. Default stays OFF.

## Assumptions / invariants (Karpathy: state before coding)

- schema.sql is idempotent-only; the migration is a one-shot in `hub/scripts/` (NOT inline).
- Flag-OFF (`REMO_ORCHESTRATOR_ENABLED` unset) MUST inject/enqueue/register nothing.
- Smallest diff: reuse `buildControllerContext`, `computeDueRowsForTask`, `planWaves`,
  `runWavePlan`/`makeLiveSeams`, `dispatchMergeIfDue`, `runVerifyTail`. No new engine.
- Hub injects TEXT ONLY (cost-cap non-bypassable via inject.ts gate list).

## The tick / async model (HOW the wiring works end-to-end)

The hub DRIVES the waves from the DUE ROWS directly (not from next-tick RUNLOG parsing):

1. Drain worker (`startRoutineQueueWorker`, already booted) claims a `routine_queue` entry
   (per-session lock + global cap). Entry carries only `session_id`.
2. `makeCycleRunner()`'s runner resolves identity: `getSessionById(session_id)` →
   `{ user_id, repo_key }`; `getOrchestratorTaskForSession(user_id, session_id)` → the one
   orchestrator task (`id`, `lifecycle_stage`, `timezone`). No task ⇒ release no-op.
3. `buildControllerContext({userId, sessionId, taskId, stage, repo, tz})` → project state +
   run-log + **DUE rows** (`computeDueRowsForTask`).
4. `renderControllerPrompt(ctx)` is assembled for the run-log decision_rationale (context),
   but the DRIVER is the due-row command set:
   `commands = ctx.dueRows.map(d => d.row.command)`.
5. `planWaves(commands)` groups dependency-aware waves; merge-to-main is EXCLUDED by the
   planner. We carry each row's `micro_prompt` onto the matching `WaveUnit.microPrompt`.
6. `runWavePlan(plan, ctx{sessionId,userId,repoKey,decisionRationale}, makeLiveSeams())` —
   each unit's `executeCommand` live seam composes the templated prompt and INJECTS it into
   the bound session via the shared dispatch pipeline (cost-capped). The gsd work + PR +
   reviewer run ASYNC inside the agent turn; `pr_url`/verdict are reconciled on a LATER tick
   when `buildControllerContext` re-reads `routine_run_log` (the run-log row is written now
   with the dispatch outcome).
7. `dispatchMergeIfDue(ctx.dueRows, {...})` routes a due `merge-to-main` row to the off-hours
   window-gated special path.
8. `runVerifyTail({...})` — mandatory terminal deploy+log verify (Phase 27).

This replaces the `runWaves(... runLogBlocks:[] ...)` empty-set placeholder. The controller
prompt's `<<RUNLOG>>`/`<<DECISION>>` parser (`parseControllerDecisions`) remains for the
reconciliation path (agent-reported blocks on later ticks) — unchanged.

### Enqueue tick (gated)

A `startDueOrchestratorTick()` (in `controller.ts`), started ONLY by
`registerCycleRunnerIfEnabled()` when the flag is ON, periodically scans enabled orchestrator
tasks whose session has any DUE row and `enqueueCycle(session_id, priority)` (priority =
DEPLOY_FIX if a deploy-fix/merge row is due else BUILD). Interval =
`REMO_ORCHESTRATOR_TICK_INTERVAL_MS` (default 60000). Flag OFF ⇒ never started ⇒ no enqueue.
Coalescing is handled by the queue's per-session running lock.

## Deliverables

1. `hub/src/orchestrator/controller.ts` — real `makeCycleRunner` (identity resolution +
   due-row-driven waves + micro_prompt carry + merge + verify-tail); `resolveCycleContext`
   helper (exported, testable); `startDueOrchestratorTick`/`stopDueOrchestratorTick` +
   register in `registerCycleRunnerIfEnabled`. `index.ts` already calls
   `registerCycleRunnerIfEnabled`? NO — verify; add the call next to `startRoutineQueueWorker`.
2. `hub/scripts/migrate-legacy-tasks-to-orchestrator.ts` — one-shot, idempotent, `--dry-run`.
   Folds legacy `dev`/`qc` (+ chained step types) scheduled tasks per session into ONE
   orchestrator task + `orchestrator_rows`. Does not delete legacy rows (disables them).
3. Docs: new `docs/auto-dev-orchestrator.md`; Docs-map row in `CLAUDE.md`; env documentation
   for `REMO_ORCHESTRATOR_ENABLED`, `_GLOBAL_CONCURRENCY`, `_DRAIN_INTERVAL_MS`,
   `_TICK_INTERVAL_MS`, `REMO_VERIFY_APP_UUID/BASE_URL/ROUTES`, off-hours window;
   README feature line; `bun run docs:sync` if routes changed (none expected).
4. Tests: `hub/test/orchestrator-cycle-wiring.test.ts` (resolution → due rows → inject called
   with real command set; flag-OFF registers/enqueues/injects nothing) +
   `hub/test/migrate-legacy-tasks.test.ts` (dry-run, idempotent). Mock DB/network.

## QC

`bun run build:web`; `bun test` affected; `bun run check-baseline` (fail=0); no-indigo green.
