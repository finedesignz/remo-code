// hub/src/sessions/stale-run-reaper.ts
// fix/stop-the-bleed — global backstop for leaked `session_runs` rows.
//
// BUG (prod, repeatedly): `sessions/budget.ts` computes the supervisor's effective
// concurrency from `COUNT(session_runs WHERE ended_at IS NULL)`. Any open run that
// never gets closed permanently consumes a slot, and once the leaked rows reach the
// cap EVERY launch returns `at_capacity` 429 — the web "Start ▶" button silently
// does nothing. The known instance was the NULL-`session_id` rows the orphan
// reconciler could never match (SQL three-valued logic; fixed in
// supervisor-dal.finalizeOrphanedRunsForSupervisor). That fix closes the KNOWN leak;
// this sweep closes the CLASS — a row whose supervisor never pushes inventory again
// (gone / crashed / never reconnected) is invisible to the reconciler forever.
//
// PREDICATE = LIVENESS, NOT AGE.
// An earlier draft reaped purely on age. That was WRONG, and would have traded one
// capacity bug for another: a 7h TEAB build or a long autonomous run is legitimately
// old, and force-closing it frees its slot while the CLI keeps running — inviting a
// second CLI to launch on top of it and losing the real exit result. So we reap only
// runs that NOTHING LIVE BACKS: the session appears in no connected supervisor's
// `session_inventory` (a NULL `session_id` can never appear in one, so those rows are
// unbacked by construction). Age is only a GRACE on top of that, so a spawn in flight
// or a briefly-reconnecting supervisor is never caught. A run a connected supervisor
// still reports as LIVE is NEVER closed here, no matter how old.

import { finalizeUnbackedOpenRuns } from '../db/supervisor-dal.ts'
import { getAllLiveSessionIds } from '../ws/supervisor-registry.ts'

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
 * Grace: how old an UNBACKED open run must be before it is closed. Default 24h.
 * The DAL clamps this to SESSION_RUN_MIN_AGE_FLOOR_MS (60s), so no caller — present
 * or future — can turn the sweep into a fleet-wide force-close. Read at call time.
 * Env: REMO_SESSION_RUN_MAX_MS.
 */
export function sessionRunMaxMs(): number {
  return parsePositiveIntEnv(process.env.REMO_SESSION_RUN_MAX_MS, 86_400_000)
}

/** Sweep cadence. Default 15min. Read at call time. Env: REMO_SESSION_RUN_REAPER_INTERVAL_MS. */
export function sessionRunReaperIntervalMs(): number {
  return parsePositiveIntEnv(process.env.REMO_SESSION_RUN_REAPER_INTERVAL_MS, 900_000)
}

export interface StaleRunReaperDeps {
  finalizeUnbackedOpenRuns: typeof finalizeUnbackedOpenRuns
  getAllLiveSessionIds: typeof getAllLiveSessionIds
}

const REAL_DEPS: StaleRunReaperDeps = { finalizeUnbackedOpenRuns, getAllLiveSessionIds }

/**
 * One sweep pass: close open runs that NO connected supervisor reports as live and
 * that are past the grace. Returns the run ids closed. Never throws (a DB blip must
 * not take the boot-started interval down).
 */
export async function reapUnbackedSessionRuns(
  deps?: Partial<StaleRunReaperDeps>,
): Promise<string[]> {
  const d: StaleRunReaperDeps = { ...REAL_DEPS, ...deps }
  try {
    const liveSessionIds = d.getAllLiveSessionIds()
    const ids = await d.finalizeUnbackedOpenRuns({ liveSessionIds, minAgeMs: sessionRunMaxMs() })
    if (ids.length > 0) {
      console.warn(
        `[stale-run-reaper] closed ${ids.length} open session_run(s) with NO live supervisor backing ` +
        `(older than ${sessionRunMaxMs()}ms; exit_reason=no_live_backing)`,
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
    void reapUnbackedSessionRuns()
  }, sessionRunReaperIntervalMs())
  ;(sweepTimer as any)?.unref?.()
}

/** Stop the periodic sweep (test hook / graceful shutdown). */
export function stopStaleRunReaperSweep(): void {
  if (sweepTimer) {
    clearInterval(sweepTimer)
    sweepTimer = null
  }
}
