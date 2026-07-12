// hub/src/sessions/stale-run-reaper.ts
// fix/stop-the-bleed — absolute-age backstop for leaked `session_runs` rows.
//
// BUG (prod, repeatedly): `sessions/budget.ts` computes the supervisor's
// effective concurrency from `COUNT(session_runs WHERE ended_at IS NULL)`. Any
// open run that never gets closed permanently consumes a slot, and once the
// leaked rows reach the cap EVERY launch returns `at_capacity` 429 — the web
// "Start ▶" button silently does nothing. The known instance was the NULL-
// `session_id` rows the orphan reconciler could never match (SQL three-valued
// logic; fixed in supervisor-dal.finalizeOrphanedRunsForSupervisor).
//
// That fix closes the KNOWN leak. This sweep closes the CLASS: any open run
// older than the ceiling is force-closed regardless of session_id, supervisor,
// or inventory, so no future leak of this shape can wedge the app again.
//
// NOT a replacement for the reconciler (which closes runs within seconds); this
// is the slow backstop that guarantees an upper bound.

import { finalizeAgedOpenRuns } from '../db/supervisor-dal.ts'

function parsePositiveIntEnv(raw: string | undefined, fallback: number): number {
  if (raw == null || raw === '') return fallback
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

function envFlagOn(raw: string | undefined): boolean {
  if (raw == null) return false
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase())
}

/**
 * Max age of an OPEN `session_runs` row before it is force-closed
 * (`exit_reason='run_max_age'`). Default 24h — comfortably above the hub's own
 * idle-teardown bound (REMO_SESSION_IDLE_GRACE_SECONDS, default 4h), so a
 * healthy long-lived session is never reaped. Env: REMO_SESSION_RUN_MAX_MS.
 */
export function sessionRunMaxMs(): number {
  return parsePositiveIntEnv(process.env.REMO_SESSION_RUN_MAX_MS, 86_400_000)
}

/** Sweep cadence. Default 15min. Env: REMO_SESSION_RUN_REAPER_INTERVAL_MS. */
export const SESSION_RUN_REAPER_INTERVAL_MS = parsePositiveIntEnv(
  process.env.REMO_SESSION_RUN_REAPER_INTERVAL_MS,
  900_000,
)

export interface StaleRunReaperDeps {
  finalizeAgedOpenRuns: typeof finalizeAgedOpenRuns
}

const REAL_DEPS: StaleRunReaperDeps = { finalizeAgedOpenRuns }

/**
 * One sweep pass. Returns the run ids closed. Never throws (a DB blip must not
 * take the boot-started interval down).
 */
export async function reapAgedSessionRuns(
  deps?: Partial<StaleRunReaperDeps>,
): Promise<string[]> {
  const d: StaleRunReaperDeps = { ...REAL_DEPS, ...deps }
  try {
    const ids = await d.finalizeAgedOpenRuns(sessionRunMaxMs())
    if (ids.length > 0) {
      console.warn(
        `[stale-run-reaper] force-closed ${ids.length} open session_run(s) older than ${sessionRunMaxMs()}ms (exit_reason=run_max_age)`,
      )
    }
    return ids
  } catch (err: any) {
    console.warn(`[stale-run-reaper] sweep failed: ${err?.message ?? err}`)
    return []
  }
}

let sweepTimer: ReturnType<typeof setInterval> | null = null

/**
 * Start the periodic sweep (idempotent). No-op when
 * REMO_SESSION_RUN_REAPER_DISABLED is set (1|true|yes|on).
 */
export function startStaleRunReaperSweep(): void {
  if (envFlagOn(process.env.REMO_SESSION_RUN_REAPER_DISABLED)) {
    console.log('[stale-run-reaper] disabled via REMO_SESSION_RUN_REAPER_DISABLED — sweep not started')
    return
  }
  if (sweepTimer) return
  sweepTimer = setInterval(() => {
    void reapAgedSessionRuns()
  }, SESSION_RUN_REAPER_INTERVAL_MS)
  ;(sweepTimer as any)?.unref?.()
}

/** Stop the periodic sweep (test hook / graceful shutdown). */
export function stopStaleRunReaperSweep(): void {
  if (sweepTimer) {
    clearInterval(sweepTimer)
    sweepTimer = null
  }
}
