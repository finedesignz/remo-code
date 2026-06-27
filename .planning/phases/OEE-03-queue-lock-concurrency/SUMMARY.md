<!-- updated: 2026-06-25 -->
# Phase OEE-03 — Queue + Lock Concurrency E2E — SUMMARY

## Scope
E2e-prove the flag-gated-OFF Auto-Dev Orchestrator `routine_queue` + drain worker +
per-session running-lock against **real Postgres** via the OEE harness (OEE-01/02).
Validation only — no product scope, no prod flag flip.

## Deliverable
- `hub/test/e2e/orchestrator-queue-lock.e2e.test.ts` — one e2e test file.

Drives the GENUINE production code paths in `hub/src/orchestrator/queue.ts`
(`enqueueCycle`, `claimCycles`, `drainOnce`, `releaseCycle`, `setCycleRunner`,
`_resetForTests`). Uses the OEE harness `setupHarness()/teardownHarness()` and seeds
extra `sessions` + `routine_queue` rows via `h.sql`.

## What it proves
1. **Global concurrency cap holds.** With `REMO_ORCHESTRATOR_GLOBAL_CONCURRENCY=2`
   pinned at import, `cap+2` cycles across distinct sessions are enqueued; a runner
   blocks on a barrier and records peak concurrency. `drainOnce` promotes exactly
   `cap` at once, a concurrent `claimCycles` mid-wave claims 0, peak-in-flight never
   exceeds `cap`, and nothing is left stuck `running`.
2. **Per-session coalescing (no stacking).** With one cycle already `running` for a
   session, a second `enqueueCycle` for the SAME session is NOT promoted by
   `claimCycles` (per-session partial unique lock `idx_routine_queue_session_running`).
   Exactly one running row; the second stays `pending` and becomes claimable only
   after the first releases — coalesced, never duplicated.
3. **Stale/foreign entry is a no-op, not a crash.** A manually-planted stale `running`
   row (process-restart leftover) holds the session lock; a terminal `done` row and a
   fresh `pending` row for the same locked session are present. `drainOnce` claims 0,
   runs nothing, throws nothing; the single running row is untouched. Releasing the
   stale row unblocks the pending cycle, which then runs exactly once.

## How to run
    # Skips cleanly (0 fail) without a disposable DB:
    cd C:/Users/artic/GitHub/remo-code-oee
    bun test hub/test/e2e/orchestrator-queue-lock.e2e.test.ts

    # Against a real disposable (NON-PROD) Postgres:
    REMO_E2E_DB_URL=postgres://localhost:5432/remo_e2e \
      bun test hub/test/e2e/orchestrator-queue-lock.e2e.test.ts

The non-prod DSN guard (`assertNonProdDsn`, OEE-01) refuses prod-looking DSNs.
`DATABASE_URL` is set to `REMO_E2E_DB_URL` before `queue.ts` is imported, because
`hub/src/db/postgres.ts` binds its shared `sql` at import time.

## Production seam added
**None.** The test uses only existing seams: the Phase-23 DI seam `setCycleRunner()`,
the test-only `_resetForTests()`, and the import-time `GLOBAL_CONCURRENCY` env read —
all already present in `queue.ts`. No `hub/src` changes, no schema.sql changes, no
cost-cap bypass, `REMO_ORCHESTRATOR_ENABLED` untouched.

## Verification (local)
- `bun test hub/test/e2e/orchestrator-queue-lock.e2e.test.ts` -> 0 pass / 6 skip / 0 fail
  (skips without `REMO_E2E_DB_URL`, as designed).
- `bunx tsc --noEmit -p hub/tsconfig.json` -> no NEW errors referencing the new file.
