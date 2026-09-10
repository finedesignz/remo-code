# Phase 22 — global-queue-and-per-session-lock — PLAN

- Status: In progress
- Depends on: Phase 21 (data model: `routine_queue` + per-session running-lock partial unique index — DONE @ 7fcc433)
- Requirements: R-ADO-05 (global host concurrency cap), R-ADO-06 (FIFO + priority), R-ADO-07 (per-session single-cycle lock)
- Scope: queue mechanics ONLY. No cycle work executes. No controller logic (Phase 23).

## Assumptions

- `routine_queue` schema is authoritative (Phase 21): `id, session_id, priority INTEGER, status, enqueued_at, started_at`.
  - Partial unique index `idx_routine_queue_session_running ON (session_id) WHERE status='running'` = the per-session lock.
  - Partial index `idx_routine_queue_pending ON (priority DESC, enqueued_at) WHERE status='pending'` = drain order.
  - status CHECK ∈ {pending,running,done,failed,cancelled}.
- `postgres` lib exposes `sql.begin(fn)` transactions and tagged-template `sql\`...\``.
- Higher `priority` integer = drains first; deploy-fix outranks build.

## Decisions

- **Priority enum** (`CyclePriority`): `BUILD = 0`, `DEPLOY_FIX = 10`. Stored in `routine_queue.priority`.
  Ordering = `priority DESC, enqueued_at ASC` (matches the Phase-21 index, FIFO within equal priority).
- **Global cap**: env `REMO_ORCHESTRATOR_GLOBAL_CONCURRENCY` (positive int, default **2**). Parsed once at module load,
  same style as `idle-teardown` reads `REMO_SESSION_IDLE_GRACE_SECONDS`.
- **Atomic claim** (the core invariant): one drain pass runs in a single `sql.begin` transaction:
  1. `SELECT count(*) FROM routine_queue WHERE status='running'` → `running`. `slots = cap - running`. If `slots<=0`, no-op.
  2. Repeat up to `slots` times: pick the next eligible pending row with
     `SELECT ... WHERE status='pending' AND session_id NOT IN (SELECT session_id FROM routine_queue WHERE status='running')
      ORDER BY priority DESC, enqueued_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED`,
     then `UPDATE ... SET status='running', started_at=now()`.
     The partial unique index is the hard guarantee: even if two concurrent drains race past the NOT IN read,
     the second `UPDATE→running` violates `idx_routine_queue_session_running` and is caught → that session skipped.
  3. Collected claimed rows are returned; the cap is never exceeded because each claim re-derives running count
     within the serialized loop (claimed-this-pass counted against `slots`).
- **Per-session lock**: relies entirely on the partial unique index. A second due-tick for a session with a running
  row cannot be claimed (NOT-IN filter) and, on a race, cannot be promoted (unique-index violation) → coalesced.
- **Runner injection**: `setCycleRunner(fn)` registers an async `(entry)=>Promise<void>`. The drain worker does
  NOTHING (claims nothing) until a runner is registered → dormant + safe (Phase 23 registers the real one).
- **Release**: after the injected runner resolves → `status='done'`; on throw → `status='failed'`; either way the
  running-lock is released so the session is eligible again. Wrapped per-entry so one failure doesn't wedge the drain.
- **Lifecycle**: `startRoutineQueueWorker()` / `stopRoutineQueueWorker()` mirror `startRevanoteCallbackWorker`.
  `setInterval` drain tick (env `REMO_ORCHESTRATOR_DRAIN_INTERVAL_MS`, default 1000). Started in `hub/src/index.ts`
  startup block alongside the other workers; stopped in the SIGTERM/SIGINT shutdown block.

## Files

- NEW `hub/src/orchestrator/queue.ts` — enum, `enqueueCycle`, `setCycleRunner`, `drainOnce` (claim+run), worker start/stop, test helpers.
- EDIT `hub/src/index.ts` — start worker on boot, stop on shutdown.
- NEW `hub/test/orchestrator-queue.test.ts` — claim cap, per-session lock, priority+FIFO, release-on-error. Env-gated e2e (`REMO_E2E_DB_URL`) mirroring Phase-21 test; always-on unit assertions for enum/config/dormancy.

## Verifiable success criteria

- `bun test hub/test/orchestrator-queue.test.ts` green (always-on layer; e2e layer runs when `REMO_E2E_DB_URL` set).
- `bun run check-baseline` fail=0, pass count >= prior baseline.
- No runner registered ⇒ `drainOnce()` claims nothing (dormant).
