// hub/src/scheduler/run-reaper.ts
// fix/sched-qc — finalizes scheduled_task_runs stuck in `pending` forever.
//
// BUG (verified in prod 2026-07): `scheduled_task_runs` rows dispatched to a
// session whose CLI turn never completes are inserted `pending` and NOTHING
// ever finalizes them (there is no timeout on the agent reply path). Prod has
// rows pending since 2026-07-08, so the task looks perpetually in-flight and
// its post-run actions / email summary never fire.
//
// This module periodically sweeps for `status='pending'` runs older than
// RUN_MAX_MS and finalizes them `failed` / `run_timeout` through the shared
// `finalizeRun` (so post-run actions + email summary behave normally).
//
// Idempotency: the reaper finalizes with `only_if_active` — a conditional
// UPDATE that only lands while the row is still non-terminal (pending or
// in_flight). A run another poller owns (e.g. TEAB's poll-to-terminal loop) can
// therefore never be double-finalized: the loser of the race writes nothing and
// skips the broadcast + post-run fan-out. TEAB's loop passes the same guard.
//
// Ceiling coupling: a TEAB run legitimately runs up to REMO_TEAB_MAX_RUN_MS
// (default 6h) — the SAME default as REMO_RUN_MAX_MS — so a plain RUN_MAX_MS
// sweep could reap a TEAB run out from under its own poller. The reaper
// therefore uses a per-row ceiling: `teab` rows are only reaped once they exceed
// max(REMO_RUN_MAX_MS, REMO_TEAB_MAX_RUN_MS), i.e. after TEAB's own poll has had
// its full window to finalize (its deadline tick fires first at
// REMO_TEAB_MAX_RUN_MS).

import { finalizeRun } from './dispatcher.ts'

function parsePositiveIntEnv(raw: string | undefined, fallback: number): number {
  if (raw == null || raw === '') return fallback
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

function envFlagOn(raw: string | undefined): boolean {
  if (raw == null) return false
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase())
}

/** Max age of a `pending` run before it's finalized `run_timeout`. Default 6h. */
export const RUN_MAX_MS = parsePositiveIntEnv(process.env.REMO_RUN_MAX_MS, 21_600_000)

/** Sweep cadence. Default 5min. Env override: REMO_RUN_REAPER_INTERVAL_MS. */
export const RUN_REAPER_INTERVAL_MS = parsePositiveIntEnv(
  process.env.REMO_RUN_REAPER_INTERVAL_MS,
  300_000,
)

/**
 * Max age of an in-flight TEAB run before the reaper may touch it. Read live so
 * it always tracks the sender's own ceiling (senders/teab.ts, same default).
 */
export function teabMaxRunMs(): number {
  return parsePositiveIntEnv(process.env.REMO_TEAB_MAX_RUN_MS, 21_600_000)
}

/** Per-row reap ceiling. `teab` rows get max(RUN_MAX_MS, REMO_TEAB_MAX_RUN_MS). */
export function reapCeilingMs(taskType: string | null | undefined): number {
  return taskType === 'teab' ? Math.max(RUN_MAX_MS, teabMaxRunMs()) : RUN_MAX_MS
}

/** Minimal run shape the reaper needs. */
export interface StaleRunRow {
  id: string
  /** started_at as epoch millis. */
  started_at_ms: number
  /** Owning task's `task_type` — drives the per-row ceiling (TEAB runs longer). */
  task_type?: string | null
}

// Injectable seams (tests swap these; defaults are the real adapters).
export interface RunReaperDeps {
  loadPendingRuns: () => Promise<StaleRunRow[]>
  finalizeRun: typeof finalizeRun
}

const REAL_DEPS: RunReaperDeps = {
  loadPendingRuns: async () => {
    const { sql } = await import('../db/postgres.ts')
    const rows = await sql<{ id: string; started_at_ms: string | null; task_type: string | null }[]>`
      SELECT r.id,
             EXTRACT(EPOCH FROM COALESCE(r.started_at, r.scheduled_for)) * 1000 AS started_at_ms,
             t.task_type
      FROM scheduled_task_runs r
      LEFT JOIN scheduled_tasks t ON t.id = r.task_id
      WHERE r.status = 'pending'
    `
    return rows
      .filter((r) => r.started_at_ms != null)
      .map((r) => ({
        id: r.id,
        started_at_ms: Number(r.started_at_ms),
        task_type: r.task_type ?? null,
      }))
  },
  finalizeRun,
}

/**
 * One reap pass: finalize every `pending` run older than RUN_MAX_MS as
 * `failed` / `run_timeout`. Best-effort per run (one failure never aborts the
 * pass). Returns the runIds reaped.
 */
export async function reapStaleRuns(
  now: number = Date.now(),
  deps?: Partial<RunReaperDeps>,
): Promise<string[]> {
  const d: RunReaperDeps = { ...REAL_DEPS, ...deps }
  const reaped: string[] = []

  let runs: StaleRunRow[] = []
  try {
    runs = await d.loadPendingRuns()
  } catch (err: any) {
    console.warn(`[run-reaper] pending-run load failed: ${err?.message ?? err}`)
    return reaped
  }

  for (const run of runs) {
    const age = now - run.started_at_ms
    const ceiling = reapCeilingMs(run.task_type)
    if (!(age >= ceiling)) continue
    try {
      await d.finalizeRun(run.id, 'failed', 'run_timeout', { only_if_active: true })
      reaped.push(run.id)
      console.warn(
        `[run-reaper] finalized stale run=${run.id} (pending for ${Math.round(age / 60_000)}m ≥ ${ceiling}ms) as failed/run_timeout`,
      )
    } catch (err: any) {
      console.warn(`[run-reaper] reap failed run=${run.id}: ${err?.message ?? err}`)
    }
  }

  return reaped
}

let sweepTimer: ReturnType<typeof setInterval> | null = null

/**
 * Start the periodic stale-run sweep (idempotent). No-op when
 * REMO_RUN_REAPER_DISABLED is set (1|true|yes|on).
 */
export function startRunReaperSweep(): void {
  if (envFlagOn(process.env.REMO_RUN_REAPER_DISABLED)) {
    console.log('[run-reaper] disabled via REMO_RUN_REAPER_DISABLED — sweep not started')
    return
  }
  if (sweepTimer) return
  sweepTimer = setInterval(() => {
    reapStaleRuns().catch((err) =>
      console.warn(`[run-reaper] sweep pass failed: ${err?.message ?? err}`),
    )
  }, RUN_REAPER_INTERVAL_MS)
  ;(sweepTimer as any)?.unref?.()
}

/** Stop the periodic sweep (test hook / graceful shutdown). */
export function stopRunReaperSweep(): void {
  if (sweepTimer) {
    clearInterval(sweepTimer)
    sweepTimer = null
  }
}
