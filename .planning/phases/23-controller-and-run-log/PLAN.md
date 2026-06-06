# Phase 23 — controller-and-run-log — PLAN

**Branch:** `feat/auto-dev-orchestrator` · **Depends on:** Phase 22 (queue) + Phase 21 (data model)
**Requirements:** R-ADO-08, R-ADO-09, R-ADO-10 (+ honors D1, D4 and the carried-gate from D10/Phase 22).

## Scope (DECISION CORE only)

This phase builds the per-tick controller core: due-row evaluation, run-log read/write,
controller-prompt assembly + decision parsing, and a flag-gated cycle-runner registration.
**Out of scope (explicitly deferred):** wave fan-out / per-command skill execution (Phase 24),
the gsd-command injection seam (Phase 25). `runWaves(decision)` is a no-op P24 seam.

## Assumptions (stated up front)

- The Phase-21 DAL (`hub/src/db/orchestrator-rows-dal.ts`) already exposes
  `insertRoutineRunLog`/`recentRoutineRunLog` and the `OrchestratorRow`/`RoutineRunLogEntry`
  types — `run-log.ts` is a THIN re-export/wrapper, not a new DB layer.
- The Phase-22 queue (`hub/src/orchestrator/queue.ts`) exposes `setCycleRunner` + the
  `CycleRunner` type + `RoutineQueueEntry`. We register through that seam.
- Schedule eligibility is OWNED by `hub/src/scheduler/schedule-rules.ts`
  (`shouldSkipFire`, `boundReason`). We IMPORT it — never copy.
- The decision parser mirrors `hub/src/scheduler/controller-schema.ts`
  (`parseControllerDecision`) and `triage-schema.ts` (malformed → safe fallback).
- No Postgres reachable in this worktree (no docker, no `REMO_E2E_DB_URL`) → DB round-trips
  are env-gated; the live cycle-runner is flag-OFF so prod stays dormant regardless.

## Deliverables

1. **`hub/src/orchestrator/due-rows.ts`** — `computeDueRows(rows, { now, tz, runCountForRow })`.
   Pure (no DB): caller supplies `now`, `tz`, and a per-row run-count lookup. Per row:
   - `enabled === false` ⇒ not due.
   - `frequency_label === 'Never'` ⇒ not due (disabled).
   - `frequency_label === 'Once'` (or rule `max_runs`) ⇒ due only if run-count < max_runs
     (Once ⇒ max_runs=1); when it fires, the result flags `autoDisableAfter: true`.
   - else: due iff `schedule_rule` present AND `!shouldSkipFire(rule, now, tz)` AND not
     bound-stopped (`boundReason([rule], now, runCount) === null`).
   Returns `DueRow[]` ( `{ row, autoDisableAfter }` ). No rule + non-Once/Never ⇒ not due
   (a row with no cadence is never due — safe).
   A thin DB helper `computeDueRowsForTask(taskId, { now, tz })` loads rows + per-command run
   counts and delegates (env-gated by callers that have a DB).

2. **`hub/src/orchestrator/run-log.ts`** — `appendRunLog(entry)` → `insertRoutineRunLog`;
   `recentRunLog(sessionId, n=20)` → `recentRoutineRunLog`. Re-export the entry types.

3. **`hub/src/orchestrator/controller.ts`**
   - `buildControllerContext({ userId, sessionId, taskId, stage, repo?, runLogLimit? })` —
     assembles `{ runtimeContext, runLog, dueRows }` (reuses `buildRuntimeContext`; best-effort,
     DB failures fall back to empty — never throw).
   - `renderControllerPrompt(ctx)` — SPEC §4 skeleton as a template, substituting
     repo/stage/due_rows/run_log. Always-on implicit rows: `status-check/decide` first,
     `deploy+log-verify` terminal.
   - `parseControllerDecisions(raw)` — mirror `parseControllerDecision`; supports MULTIPLE
     per-command `<<RUNLOG ... RUNLOG>>` blocks (one run-log entry per command) PLUS the
     top-level `<<DECISION>>`. Malformed/absent ⇒ `{ ok:false, fallback }` safe no-op
     (action `continue`, zero run-log entries). One run-log entry per parsed command block.
   - `runWaves(_decision)` — **Phase-24 SEAM**: logs "deferred to P24" and returns. No dispatch.
   - `makeCycleRunner()` → a `CycleRunner` that (when DB present) builds context, renders the
     prompt, calls `runWaves` (no-op), and writes a run-log entry; on any error releases via
     the queue's own release path (queue wraps it).
   - `registerCycleRunnerIfEnabled()` — reads `REMO_ORCHESTRATOR_ENABLED` (default `'0'`/OFF);
     when OFF, does NOT call `setCycleRunner` (queue stays dormant). When ON, registers
     `makeCycleRunner()`. Exported `isOrchestratorEnabled()` for tests/observability.

4. **Tests** (`hub/test/orchestrator-controller.test.ts`, `hub/test/orchestrator-due-rows.test.ts`,
   `hub/test/orchestrator-run-log.test.ts`) — all-on (no DB) + env-gated e2e blocks mirroring
   the Phase-21/22 test layout:
   - due-rows: Never⇒not due; Once⇒fires once then run-count gates it off; cron/window/bounds
     via `shouldSkipFire`; disabled row⇒not due; no-rule⇒not due.
   - parser: valid multi-command parse; malformed⇒safe `continue` fallback w/ zero entries;
     missing block⇒fallback.
   - prompt: contains repo/stage/due-row/run-log substitutions + the implicit terminal verify.
   - gate: `REMO_ORCHESTRATOR_ENABLED` unset ⇒ runner NOT registered ⇒ `drainOnce()` dormant
     (claims nothing). Set ⇒ runner registered.
   - run-log: env-gated round-trip (append → recent) when `REMO_E2E_DB_URL` present.

## Flag-gating the live path OFF (carried Phase-22 gate)

`REMO_ORCHESTRATOR_ENABLED` defaults to `'0'`. `registerCycleRunnerIfEnabled()` is the ONLY
place that calls `setCycleRunner`; with the flag OFF it is a no-op, so the queue worker
(`drainOnce`) claims nothing and prod stays fully dormant on the e2e-unproven queue.
Documented in CLAUDE.md Environment Variables.

## Karpathy

Smallest diff: 3 new files + 3 test files + 1 CLAUDE.md doc line. No edits to queue/DAL/scheduler.
Reuse `shouldSkipFire`/`boundReason`/`buildRuntimeContext`/parser convention. No speculative
dispatch — `runWaves` is an explicit no-op seam. Verifiable: `bun test` on the 3 new files +
`bun run check-baseline`.
