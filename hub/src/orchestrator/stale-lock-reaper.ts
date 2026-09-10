// hub/src/orchestrator/stale-lock-reaper.ts
// fix/dispatch-stale-lock-reaper — recovers a wedged auto-dev macro loop.
//
// BUG (verified in prod, ~2 days wedged): `SessionQueue`'s per-session
// `inFlight` token is set on dispatch and cleared ONLY by `markFinished`. When
// a session's CLI turn never completes (dead/unauthed local session),
// `markFinished` is never called, so the lock is held FOREVER. Every 60s
// heartbeat then sees `isRunLive(sessionId)` true and silently `skipped
// "run live"` — no work, no alert, indefinitely.
//
// This module periodically scans enabled orchestrator tasks for a
// session whose in-flight lock has been held ≥ STALE_LOCK_MS, `abandon()`s
// the wedged lock so the next heartbeat can re-inject, appends a `failed`
// run-log row, and fires a ONE-SHOT (cooldown-deduped) failure notify.

import { getQueue } from '../dispatch/pipeline.ts';
import { appendRunLog } from './run-log.ts';
import { fanOutNotify } from './notify.ts';

function parsePositiveIntEnv(raw: string | undefined, fallback: number): number {
  if (raw == null || raw === '') return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/** How long an in-flight lock may be held before it's considered wedged. Default 4h. */
export const STALE_LOCK_MS = parsePositiveIntEnv(
  process.env.REMO_ORCHESTRATOR_STALE_LOCK_MS,
  14_400_000,
);

/** Minimum gap between repeat failure-notifies for the same session. Default 1h. */
export const REAP_NOTIFY_COOLDOWN_MS = parsePositiveIntEnv(
  process.env.REMO_ORCHESTRATOR_REAP_NOTIFY_COOLDOWN_MS,
  3_600_000,
);

// Module-level cooldown tracker (sessionId → last notify Date.now()). Best-effort,
// in-memory only — a hub restart resets it, which is fine (a still-wedged lock
// re-notifies on the next reap pass rather than staying silent forever).
const lastNotifyAt = new Map<string, number>();

/** Test-only — clear the notify cooldown tracker between test cases. */
export function _resetReapNotifyCooldown(): void {
  lastNotifyAt.clear();
}

export interface StaleLockTask {
  id: string;
  session_id: string;
  user_id: string;
  timezone: string | null;
}

// Injectable seams (tests swap these; defaults are the real adapters).
export interface StaleLockReaperDeps {
  loadTasks: () => Promise<StaleLockTask[]>;
  getQueue: typeof getQueue;
  appendRunLog: typeof appendRunLog;
  fanOut: typeof fanOutNotify;
}

async function realDeps(): Promise<StaleLockReaperDeps> {
  return {
    loadTasks: async () => {
      const { sql } = await import('../db/postgres.ts');
      return sql<StaleLockTask[]>`
        SELECT id, session_id, user_id, timezone FROM scheduled_tasks
        WHERE task_type = 'orchestrator' AND enabled = true AND session_id IS NOT NULL
      `;
    },
    getQueue,
    appendRunLog,
    fanOut: fanOutNotify,
  };
}

/**
 * One reap pass: for every enabled orchestrator task whose session holds an
 * in-flight lock ≥ STALE_LOCK_MS, abandon the lock, append a failure run-log
 * row, and (cooldown-permitting) fire a failure notify. Best-effort per
 * session — one failure never aborts the pass. Returns the sessionIds reaped.
 */
export async function reapStaleOrchestratorLocks(
  now: number = Date.now(),
  deps?: Partial<StaleLockReaperDeps>,
): Promise<string[]> {
  const d: StaleLockReaperDeps = { ...(await realDeps()), ...deps };
  const reaped: string[] = [];

  let tasks: StaleLockTask[] = [];
  try {
    tasks = await d.loadTasks();
  } catch (err: any) {
    console.warn(`[orchestrator.reaper] task load failed: ${err?.message ?? err}`);
    return reaped;
  }

  const q = d.getQueue();

  for (const task of tasks) {
    try {
      const sessionId = task.session_id;
      const age = q.inFlightAgeMs(sessionId, now);
      if (age === null || age < STALE_LOCK_MS) continue;

      q.abandon(sessionId);
      reaped.push(sessionId);

      const minutes = Math.round(age / 60_000);
      const rationale = `reaped stale in-flight lock after ${minutes}m — session not completing turns (wedged); next heartbeat will re-inject`;

      try {
        await d.appendRunLog({
          session_id: sessionId,
          repo_key: null,
          command: 'reaper',
          decision_rationale: rationale,
          outcome: 'failed',
        });
      } catch (err: any) {
        console.warn(`[orchestrator.reaper] run-log append failed session=${sessionId}: ${err?.message ?? err}`);
      }

      const last = lastNotifyAt.get(sessionId) ?? 0;
      if (now - last >= REAP_NOTIFY_COOLDOWN_MS) {
        lastNotifyAt.set(sessionId, now);
        try {
          await d.fanOut({
            userId: task.user_id,
            sessionId,
            event: 'failure',
            level: 'blocking',
            detail: `Auto-dev session ${sessionId} wedged for ${minutes}m (repo=${task.id}) — stale lock reaped, will retry next heartbeat`,
            channels: ['telegram', 'inapp', 'email', 'push'],
          });
        } catch (err: any) {
          console.warn(`[orchestrator.reaper] notify failed session=${sessionId}: ${err?.message ?? err}`);
        }
      }
    } catch (err: any) {
      console.warn(`[orchestrator.reaper] task reap failed task=${task.id}: ${err?.message ?? err}`);
    }
  }

  return reaped;
}
