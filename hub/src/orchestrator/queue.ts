// hub/src/orchestrator/queue.ts
// Phase 22 (auto-dev-orchestrator) — global routine-cycle queue + per-session
// lock + drain worker. QUEUE MECHANICS ONLY: no cycle work runs here. The real
// per-tick controller (Phase 23) registers a runner via setCycleRunner(); until
// then the worker is dormant (claims nothing).
//
// Reqs: R-ADO-05 (global host concurrency cap), R-ADO-06 (FIFO + priority),
// R-ADO-07 (per-session single-cycle lock). Decision D10.
//
// Invariants this module guarantees:
//  - Global cap: at most REMO_ORCHESTRATOR_GLOBAL_CONCURRENCY cycles 'running'
//    across ALL sessions. Each drain pass re-derives the running count and only
//    promotes up to (cap - running) rows.
//  - Per-session lock: at most ONE running cycle per session. Enforced by the
//    Phase-21 partial unique index idx_routine_queue_session_running ON
//    (session_id) WHERE status='running'. The claim also filters out sessions
//    that already have a running row; on a concurrent-drain race the unique
//    index rejects the second promotion (caught → that session skipped).
//  - Release: the running-lock is released (status -> 'done' | 'failed') after
//    the injected runner settles, even on throw.

import { sql } from '../db/postgres.ts';
import type { RoutineQueueEntry } from '../db/orchestrator-rows-dal.ts';
import {
  orchestratorCyclesEnqueued,
  orchestratorCyclesDrained,
} from '../observability/orchestrator-metrics.ts';

// ── Priority enum (R-ADO-06) ─────────────────────────────────────────────────
// Higher integer drains first. deploy-fix outranks build when the cap is
// contended. Stored directly in routine_queue.priority.
export enum CyclePriority {
  BUILD = 0,
  DEPLOY_FIX = 10,
}

// ── Config (parsed once, idle-teardown style) ────────────────────────────────
function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (raw == null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return fallback;
  return n;
}

/** Global cap on concurrent running cycles across ALL sessions. Default 2. */
export const GLOBAL_CONCURRENCY = parsePositiveInt(
  process.env.REMO_ORCHESTRATOR_GLOBAL_CONCURRENCY,
  2,
);

/** Drain tick interval (ms). Default 1000. */
export const DRAIN_INTERVAL_MS = parsePositiveInt(
  process.env.REMO_ORCHESTRATOR_DRAIN_INTERVAL_MS,
  1000,
);

// ── Injected runner (dormant until Phase 23 registers one) ───────────────────
export type CycleRunner = (entry: RoutineQueueEntry) => Promise<void>;

let cycleRunner: CycleRunner | null = null;

/** Register the cycle-runner. Until set, the worker claims nothing (safe/dormant). */
export function setCycleRunner(fn: CycleRunner | null): void {
  cycleRunner = fn;
}

// ── Enqueue (R-ADO-06) ───────────────────────────────────────────────────────
/**
 * Insert a pending cycle for a session. `priority` is a CyclePriority (or any
 * int); drain order is priority DESC, then FIFO by enqueued_at. Returns the row.
 */
export async function enqueueCycle(
  sessionId: string,
  priority: CyclePriority | number = CyclePriority.BUILD,
): Promise<RoutineQueueEntry> {
  const rows = await sql<RoutineQueueEntry[]>`
    INSERT INTO routine_queue (session_id, priority, status)
    VALUES (${sessionId}, ${priority}, 'pending')
    RETURNING *
  `;
  try { orchestratorCyclesEnqueued.inc(); } catch { /* metrics must never break enqueue */ }
  return rows[0];
}

// ── Atomic claim (R-ADO-05 + R-ADO-07) ───────────────────────────────────────
/**
 * Claim up to (cap - running) pending rows, marking each 'running'. Runs inside
 * a single transaction; each pick uses FOR UPDATE SKIP LOCKED + a NOT-IN filter
 * against currently-running sessions, and the partial unique index is the hard
 * backstop against a concurrent drain double-running one session.
 *
 * Returns the rows promoted to 'running' (lock held; caller must release).
 */
export async function claimCycles(cap = GLOBAL_CONCURRENCY): Promise<RoutineQueueEntry[]> {
  if (cap <= 0) return [];
  return sql.begin(async (tx: typeof sql) => {
    const runningRow = await tx<{ n: string }[]>`
      SELECT count(*)::text AS n FROM routine_queue WHERE status = 'running'
    `;
    const running = Number(runningRow[0]?.n ?? 0);
    let slots = cap - running;
    if (slots <= 0) return [];

    const claimed: RoutineQueueEntry[] = [];
    while (slots > 0) {
      // Next eligible pending row: not for a session that is already running
      // (either pre-existing OR claimed earlier in THIS pass). SKIP LOCKED so
      // a parallel drain never blocks on the same candidate row.
      const claimedSessionIds = claimed.map((c) => c.session_id);
      const pick = await tx<RoutineQueueEntry[]>`
        SELECT * FROM routine_queue q
        WHERE q.status = 'pending'
          AND NOT EXISTS (
            SELECT 1 FROM routine_queue r
            WHERE r.session_id = q.session_id AND r.status = 'running'
          )
          ${claimedSessionIds.length
            ? sql`AND q.session_id NOT IN ${sql(claimedSessionIds)}`
            : sql``}
        ORDER BY q.priority DESC, q.enqueued_at ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      `;
      if (pick.length === 0) break;
      const row = pick[0];
      try {
        const promoted = await tx<RoutineQueueEntry[]>`
          UPDATE routine_queue
          SET status = 'running', started_at = now()
          WHERE id = ${row.id} AND status = 'pending'
          RETURNING *
        `;
        if (promoted.length === 0) {
          // Row was claimed by another drain between SELECT and UPDATE — skip.
          continue;
        }
        claimed.push(promoted[0]);
        slots--;
      } catch {
        // Unique-index violation: another drain promoted a different row for the
        // SAME session concurrently. Per-session lock held; skip this session.
        continue;
      }
    }
    return claimed;
  });
}

/** Release a claimed cycle. terminal ∈ {'done','failed','cancelled'}. */
export async function releaseCycle(
  id: string,
  terminal: 'done' | 'failed' | 'cancelled',
): Promise<void> {
  await sql`
    UPDATE routine_queue SET status = ${terminal}
    WHERE id = ${id} AND status = 'running'
  `;
}

// ── Drain (claim → run injected runner → release) ────────────────────────────
let draining = false;

/**
 * One drain pass. Dormant when no runner is registered. Claims up to the global
 * cap, runs each via the injected runner, releases on settle. Per-entry try/catch
 * so one failure never wedges the pass. Re-entrancy guarded.
 */
export async function drainOnce(): Promise<RoutineQueueEntry[]> {
  if (!cycleRunner) return []; // dormant — nothing runs without a registered runner
  if (draining) return [];
  draining = true;
  try {
    const claimed = await claimCycles();
    try { orchestratorCyclesDrained.inc({}, claimed.length); } catch { /* metrics must never break drain */ }
    const runner = cycleRunner;
    await Promise.all(
      claimed.map(async (entry) => {
        try {
          await runner(entry);
          await releaseCycle(entry.id, 'done');
        } catch (err: any) {
          console.warn(
            `[routine-queue] cycle failed session=${entry.session_id} id=${entry.id}: ${err?.message}`,
          );
          await releaseCycle(entry.id, 'failed').catch(() => {});
        }
      }),
    );
    return claimed;
  } finally {
    draining = false;
  }
}

// ── Worker lifecycle (mirrors startRevanoteCallbackWorker) ───────────────────
let timer: ReturnType<typeof setInterval> | null = null;

export function startRoutineQueueWorker(): void {
  if (timer) return;
  timer = setInterval(() => {
    drainOnce().catch((err) =>
      console.warn(`[routine-queue] drain error: ${err?.message}`),
    );
  }, DRAIN_INTERVAL_MS);
  // Don't keep the event loop alive solely for the drain timer.
  (timer as any).unref?.();
  console.log(
    `[routine-queue] worker started (cap=${GLOBAL_CONCURRENCY}, interval=${DRAIN_INTERVAL_MS}ms)`,
  );
}

export function stopRoutineQueueWorker(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

// Test-only: reset module state between tests.
export function _resetForTests(): void {
  cycleRunner = null;
  draining = false;
  stopRoutineQueueWorker();
}
