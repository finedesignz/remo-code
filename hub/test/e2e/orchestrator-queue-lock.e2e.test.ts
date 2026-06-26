// hub/test/e2e/orchestrator-queue-lock.e2e.test.ts
// Milestone OEE (Orchestrator E2E Prove-Out) — Phase OEE-03.
//
// E2e-proves the FLAG-GATED-OFF Auto-Dev Orchestrator routine_queue + drain worker
// + per-session running-lock against REAL Postgres, using the OEE harness. Drives
// the GENUINE production code paths in hub/src/orchestrator/queue.ts:
//   - enqueueCycle / claimCycles / drainOnce / releaseCycle / setCycleRunner.
//
// Proves (OEE-03 scope):
//   1. Global concurrency cap holds — no more than REMO_ORCHESTRATOR_GLOBAL_CONCURRENCY
//      cycles run concurrently across ALL sessions.
//   2. Per-session coalescing — a second enqueue for a session whose cycle is already
//      live does NOT stack a duplicate running row (per-session partial unique lock).
//   3. A stale/foreign queue entry (session already running / row already terminal)
//      is a no-op skip, never a crash.
//
// Gating mirrors hub/test/phase-08.e2e.test.ts: describe.skip without REMO_E2E_DB_URL
// so `bun run check-baseline` stays green. DATABASE_URL is pointed at REMO_E2E_DB_URL
// BEFORE queue.ts is imported, because hub/src/db/postgres.ts binds its shared `sql`
// to config.databaseUrl at import time (queue.ts uses that shared `sql`).
//
// NO production seam added. queue.ts already exposes setCycleRunner() (the Phase-23
// DI seam) + _resetForTests(); the global cap is read from the env at import. Both
// are existing seams — nothing in hub/src is touched.

import { test, expect, beforeAll, afterAll } from 'bun:test';
import { randomUUID } from 'crypto';
import {
  hasE2eDb,
  maybeDescribe,
  setupHarness,
  teardownHarness,
  type Harness,
} from './orchestrator-harness.ts';
import type { RoutineQueueEntry } from '../../src/db/orchestrator-rows-dal.ts';

// Global cap for this run. Set BEFORE the queue module is imported (GLOBAL_CONCURRENCY
// is parsed once at import). 2 is the production default; we pin it explicitly so the
// assertion is deterministic regardless of ambient env.
const TEST_CAP = 2;

maybeDescribe('OEE-03 e2e — routine_queue + drain worker + per-session lock (real PG)', () => {
  let h: Harness;
  let queue: typeof import('../../src/orchestrator/queue.ts');

  beforeAll(async () => {
    // queue.ts -> hub/src/db/postgres.ts binds `sql` to config.databaseUrl at import,
    // so DATABASE_URL must point at the disposable DB BEFORE the lazy import below.
    process.env.DATABASE_URL = process.env.REMO_E2E_DB_URL!;
    process.env.REMO_ORCHESTRATOR_GLOBAL_CONCURRENCY = String(TEST_CAP);
    h = await setupHarness();
    queue = await import('../../src/orchestrator/queue.ts');
    queue._resetForTests();
  });

  afterAll(async () => {
    if (queue) queue._resetForTests();
    if (h) await teardownHarness(h);
  });

  /** Seed an extra session row in the harness DB; returns its id. */
  async function seedSession(label: string): Promise<string> {
    const rows = await h.sql<{ id: string }[]>`
      INSERT INTO sessions (user_id, name, project_dir, token_hash)
      VALUES (${h.userId}, ${'oee-q-' + label}, ${'/tmp/oee-q-' + label}, ${'th-' + randomUUID()})
      RETURNING id
    `;
    return rows[0].id;
  }

  /**
   * Clear the ENTIRE routine_queue before each test. The global concurrency cap is
   * a GLOBAL invariant — `claimCycles` derives available slots from
   * `count(*) WHERE status='running'` across ALL sessions (queue.ts), not per-user.
   * On the shared CI Postgres, residual 'running' rows left by sibling test files
   * would shrink the cap and make these assertions flaky (claim 0). This file runs
   * in its own `bun test` process serially (check-baseline isolation), so wiping the
   * whole table is safe and makes the global-cap measurement deterministic.
   */
  async function clearQueue(): Promise<void> {
    await h.sql`DELETE FROM routine_queue`;
  }

  // ── Proof 1: global concurrency cap holds ──────────────────────────────────
  test('global cap: drainOnce never runs more than GLOBAL_CONCURRENCY cycles concurrently', async () => {
    await clearQueue();
    expect(queue.GLOBAL_CONCURRENCY).toBe(TEST_CAP);

    // Enqueue cap+2 cycles, each for a DISTINCT session (so the per-session lock
    // never masks the global-cap effect we're measuring).
    const n = TEST_CAP + 2;
    const sessionIds: string[] = [];
    for (let i = 0; i < n; i++) sessionIds.push(await seedSession(`cap-${i}`));
    for (const sid of sessionIds) await queue.enqueueCycle(sid);

    let inFlight = 0;
    let maxInFlight = 0;
    const gates: Array<() => void> = [];

    // Runner blocks until released, recording the peak concurrent count. Each drain
    // pass promotes up to (cap - running); we release the whole wave together so the
    // peak equals the number the cap allowed to run at once.
    queue.setCycleRunner(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise<void>((resolve) => gates.push(resolve));
      inFlight--;
    });

    // First pass: claims exactly TEST_CAP rows (running goes 0 -> cap).
    const pass1Promise = queue.drainOnce();
    // Let the runners enter (microtask flush + a tick for the blocked promise).
    await new Promise((r) => setTimeout(r, 50));
    expect(inFlight).toBe(TEST_CAP);
    expect(maxInFlight).toBe(TEST_CAP);

    // A concurrent second pass while the first wave is still running must claim
    // NOTHING — the cap is already saturated.
    const midClaim = await queue.claimCycles();
    expect(midClaim.length).toBe(0);

    // Release the in-flight wave; the first drain pass settles.
    gates.forEach((g) => g());
    const pass1 = await pass1Promise;
    expect(pass1.length).toBe(TEST_CAP);
    expect(maxInFlight).toBe(TEST_CAP); // never exceeded the cap

    // Drain the remainder in subsequent passes; cap still bounds each wave.
    gates.length = 0;
    const drainRest = async () => {
      const claimed = await queue.drainOnce();
      // settle any newly-blocked runners from this pass
      gates.forEach((g) => g());
      gates.length = 0;
      return claimed;
    };
    const pass2 = await drainRest();
    expect(pass2.length).toBeLessThanOrEqual(TEST_CAP);

    // Everything eventually reaches a terminal status; nothing stuck 'running'.
    // (Drain until the pending+running set for our sessions is empty.)
    for (let i = 0; i < 5; i++) {
      const remaining = await h.sql<{ n: string }[]>`
        SELECT count(*)::text AS n FROM routine_queue
        WHERE session_id = ANY(${sessionIds}) AND status IN ('pending','running')
      `;
      if (Number(remaining[0].n) === 0) break;
      await drainRest();
      await new Promise((r) => setTimeout(r, 10));
    }
    const stuck = await h.sql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM routine_queue
      WHERE session_id = ANY(${sessionIds}) AND status = 'running'
    `;
    expect(Number(stuck[0].n)).toBe(0);
    expect(maxInFlight).toBe(TEST_CAP);
  });

  // ── Proof 2: per-session coalescing (no duplicate running row) ──────────────
  test('per-session lock: a second enqueue for a live session does NOT stack a second running row', async () => {
    await clearQueue();
    const sid = await seedSession('coalesce');

    // Cycle #1 is already live (running) for this session.
    await queue.enqueueCycle(sid);
    const live = await queue.claimCycles(); // promotes #1 -> running
    expect(live.length).toBe(1);
    expect(live[0].session_id).toBe(sid);

    // A second enqueue arrives for the SAME session while #1 is still running.
    await queue.enqueueCycle(sid);

    // claimCycles must REFUSE to promote it — the per-session lock holds.
    const second = await queue.claimCycles();
    expect(second.length).toBe(0);

    // Exactly ONE running row for this session (no stacking).
    const running = await h.sql<RoutineQueueEntry[]>`
      SELECT * FROM routine_queue WHERE session_id = ${sid} AND status = 'running'
    `;
    expect(running.length).toBe(1);

    // The second cycle stays pending, available once #1 releases.
    const pendingBefore = await h.sql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM routine_queue WHERE session_id = ${sid} AND status = 'pending'
    `;
    expect(Number(pendingBefore[0].n)).toBe(1);

    // Release #1; now the queued cycle becomes claimable (coalesced, not duplicated).
    await queue.releaseCycle(live[0].id, 'done');
    const afterRelease = await queue.claimCycles();
    expect(afterRelease.length).toBe(1);
    expect(afterRelease[0].session_id).toBe(sid);
    await queue.releaseCycle(afterRelease[0].id, 'done');
  });

  // ── Proof 3: stale / foreign queue entry is a no-op, not a crash ────────────
  test('stale/foreign entry: drainOnce over an already-running session + a terminal row is a clean no-op', async () => {
    await clearQueue();
    const sid = await seedSession('stale');

    // Manually plant a STALE running row (as if a prior drain promoted it and the
    // process restarted without releasing). The per-session lock is now held by it.
    await h.sql`
      INSERT INTO routine_queue (session_id, priority, status, started_at)
      VALUES (${sid}, 0, 'running', now())
    `;
    // And a foreign/terminal pending->done row that drain must simply ignore.
    await h.sql`
      INSERT INTO routine_queue (session_id, priority, status)
      VALUES (${sid}, 0, 'done')
    `;
    // Plus a fresh pending row for the SAME (locked) session.
    await queue.enqueueCycle(sid);

    let ran = 0;
    queue.setCycleRunner(async () => {
      ran++;
    });

    // Drain must NOT crash and must NOT run the pending row (session lock held by the
    // stale running row). Returns no newly-claimed rows.
    const claimed = await queue.drainOnce();
    expect(claimed.length).toBe(0);
    expect(ran).toBe(0);

    // The stale running row is still the ONLY running row (no duplicate spawned).
    const running = await h.sql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM routine_queue WHERE session_id = ${sid} AND status = 'running'
    `;
    expect(Number(running[0].n)).toBe(1);

    // Releasing the stale row unblocks the pending one; drain then runs it once.
    const staleRow = await h.sql<RoutineQueueEntry[]>`
      SELECT * FROM routine_queue WHERE session_id = ${sid} AND status = 'running' LIMIT 1
    `;
    await queue.releaseCycle(staleRow[0].id, 'failed');
    const claimed2 = await queue.drainOnce();
    expect(claimed2.length).toBe(1);
    expect(ran).toBe(1);
  });
});

// Guard: when no disposable DB is configured the whole suite is skipped, so importing
// this file in CI (no REMO_E2E_DB_URL) never touches Postgres.
if (!hasE2eDb()) {
  test.skip('OEE-03 queue/lock e2e skipped (set REMO_E2E_DB_URL to run)', () => {});
}
