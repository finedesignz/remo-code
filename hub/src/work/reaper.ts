/**
 * Stale-work reaper (milestone WORK). Same shape + idempotency discipline as
 * `hub/src/ask/reaper.ts`: a work item whose CLI turn never completes would sit
 * `queued`/`dispatched` forever and the caller (a Desktop agent holding a client
 * email) would poll it forever.
 *
 * Ceiling is generous (default 45min) because a work turn does a real build + a
 * deploy-verify probe, unlike an ask. `finalizeWork` is a CONDITIONAL UPDATE, so a
 * reply landing the instant after a reap writes nothing — exactly one winner.
 */
import { finalizeWork, loadOpenWorkRuns } from '../db/work-dal.ts'

function parsePositiveIntEnv(raw: string | undefined, fallback: number): number {
  if (raw == null || raw === '') return fallback
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

function envFlagOn(raw: string | undefined): boolean {
  if (raw == null) return false
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase())
}

/** Hard work ceiling. Default 45min. */
export function workMaxMs(): number {
  return parsePositiveIntEnv(process.env.REMO_WORK_MAX_MS, 2_700_000)
}

/** Sweep cadence. Default 60s. */
export function workReaperIntervalMs(): number {
  return parsePositiveIntEnv(process.env.REMO_WORK_REAPER_INTERVAL_MS, 60_000)
}

export interface WorkReaperDeps {
  loadOpenWorkRuns: typeof loadOpenWorkRuns
  finalizeWork: typeof finalizeWork
}

const REAL_DEPS: WorkReaperDeps = { loadOpenWorkRuns, finalizeWork }

/** One pass. Returns the work ids this pass actually finalized (won the race for). */
export async function reapStaleWork(
  now: number = Date.now(),
  deps?: Partial<WorkReaperDeps>,
): Promise<string[]> {
  const d: WorkReaperDeps = { ...REAL_DEPS, ...deps }
  const reaped: string[] = []

  let rows: Array<{ id: string; created_at_ms: number }> = []
  try {
    rows = await d.loadOpenWorkRuns()
  } catch (err: any) {
    console.warn(`[work-reaper] open-work load failed: ${err?.message ?? err}`)
    return reaped
  }

  const ceiling = workMaxMs()
  for (const row of rows) {
    if (!(now - row.created_at_ms >= ceiling)) continue
    try {
      const won = await d.finalizeWork(row.id, 'timeout', { reason: 'work_timeout' })
      if (won) reaped.push(row.id)
    } catch (err: any) {
      console.warn(`[work-reaper] reap failed work=${row.id}: ${err?.message ?? err}`)
    }
  }
  return reaped
}

let sweepTimer: ReturnType<typeof setInterval> | null = null

/** Start the periodic sweep (idempotent). No-op when REMO_WORK_REAPER_DISABLED. */
export function startWorkReaperSweep(): void {
  if (envFlagOn(process.env.REMO_WORK_REAPER_DISABLED)) {
    console.log('[work-reaper] disabled via REMO_WORK_REAPER_DISABLED — sweep not started')
    return
  }
  if (sweepTimer) return
  sweepTimer = setInterval(() => {
    reapStaleWork().catch((err) =>
      console.warn(`[work-reaper] sweep pass failed: ${err?.message ?? err}`),
    )
  }, workReaperIntervalMs())
  ;(sweepTimer as any)?.unref?.()
}

export function stopWorkReaperSweep(): void {
  if (sweepTimer) {
    clearInterval(sweepTimer)
    sweepTimer = null
  }
}
