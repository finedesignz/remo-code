# Phase 22 — global-queue-and-per-session-lock · SUMMARY

**Status:** Complete (READY-WITH-CAVEAT) · commit `ad76045` on `feat/auto-dev-orchestrator`

Hub-wide routine-cycle queue with global concurrency cap + per-session running-lock. Dormant mechanics only — no live cycle-runner until Phase 23.

## Delivered
- `hub/src/orchestrator/queue.ts` — `enqueueCycle(sessionId, priority=BUILD)`, `claimCycles(cap)` (atomic tx claim), `setCycleRunner(fn)` (worker dormant until set), `drainOnce()`, `start/stopRoutineQueueWorker()`, `releaseCycle(id, terminal)`. `CyclePriority{BUILD=0, DEPLOY_FIX=10}`.
- `hub/src/index.ts` — start worker in startup, stop in `gracefulShutdown` (safe: dormant).
- Global cap: `slots = cap - running` per tx + `draining` re-entrancy guard. Per-session lock: filter + Phase-21 partial unique index backstop. Release-on-throw frees the lock.
- `hub/test/orchestrator-queue.test.ts` — always-on enum/dormancy tests + env-gated (`REMO_E2E_DB_URL`) e2e for cap/coalesce/FIFO/release.

## Env vars
- `REMO_ORCHESTRATOR_GLOBAL_CONCURRENCY` (default **2**)
- `REMO_ORCHESTRATOR_DRAIN_INTERVAL_MS` (default 1000)

## QC
3/3 requirements PASS; concurrency sound (per-session lock DB-enforced; cap exact for single-hub). check-baseline fail=0.

## CARRIED GATE → Phase 23
Run `orchestrator-queue.test.ts` against a real Postgres before registering a live cycle-runner (no PG reachable on the build host; deferred to CI/disposable-PG at Phase 23 entry). Known limit (doc-only): multi-process hub could transiently exceed the global cap — not the deployed single-replica topology.
