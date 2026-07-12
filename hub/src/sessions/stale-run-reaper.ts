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
// PREDICATE = POSITIVE KNOWLEDGE, PER SUPERVISOR. Never age. Never a global UPDATE.
//
// This reaper has been wrong twice, both times by treating ABSENCE OF EVIDENCE AS
// EVIDENCE OF ABSENCE:
//   1. Age-only: killed live long-running builds (a 7h TEAB build is legitimately old).
//   2. Global "not in any connected supervisor's inventory": killed live runs whenever
//      the liveness data was merely MISSING. Worst case — the hub restarts, this sweep
//      fires before any supervisor has reconnected and pushed inventory (~10s cadence),
//      the live-set is EMPTY, and every old open run in the fleet is closed while its
//      CLI keeps running. The age floor does not help: those runs are old by definition.
//
// An empty live-set means "I don't know", NOT "nothing is alive". So:
//   - We sweep PER SUPERVISOR, and only supervisors that are CONNECTED **and have
//     pushed session_inventory at least once since boot** (`getInventoriedSupervisors`).
//     That is the only condition under which "your session is not in your inventory"
//     proves the session is gone.
//   - Zero such supervisors ⇒ the sweep is a NO-OP. A hub that just booted knows
//     nothing and must reap nothing.
//   - A DISCONNECTED supervisor's runs are NOT ours: `finalizeOpenRunsForSupervisor`
//     already closes them on socket close.
//   - NULL-`session_id` rows (the known leak; they can never appear in ANY inventory)
//     are attributed by their `supervisor_id`, which they always carry — so they are
//     reaped by their OWNING supervisor's sweep, once that supervisor has proven it is
//     alive and inventorying.
// Age survives only as a GRACE within a supervisor's scope (a spawn in flight).

import { finalizeUnbackedOpenRunsForSupervisor } from '../db/supervisor-dal.ts'
import { getInventoriedSupervisors } from '../ws/supervisor-registry.ts'

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
  finalizeUnbackedOpenRunsForSupervisor: typeof finalizeUnbackedOpenRunsForSupervisor
  getInventoriedSupervisors: typeof getInventoriedSupervisors
}

const REAL_DEPS: StaleRunReaperDeps = {
  finalizeUnbackedOpenRunsForSupervisor,
  getInventoriedSupervisors,
}

/**
 * One sweep pass. For each supervisor that is connected AND has pushed inventory,
 * close ITS open runs that are absent from ITS just-pushed inventory and past the
 * grace. NO-OP when no supervisor has pushed inventory yet (e.g. right after a hub
 * restart) — the hub has no knowledge, so it reaps nothing. Never throws (a DB blip
 * must not take the boot-started interval down); one supervisor's failure does not
 * abort the others.
 */
export async function reapUnbackedSessionRuns(
  deps?: Partial<StaleRunReaperDeps>,
): Promise<string[]> {
  const d: StaleRunReaperDeps = { ...REAL_DEPS, ...deps }
  const reaped: string[] = []
  let scopes: Array<{ supervisorId: string; liveSessionIds: string[] }> = []
  try {
    scopes = d.getInventoriedSupervisors()
  } catch (err: any) {
    console.warn(`[stale-run-reaper] registry read failed: ${err?.message ?? err}`)
    return reaped
  }
  if (scopes.length === 0) return reaped // knows nothing ⇒ reaps nothing

  const minAgeMs = sessionRunMaxMs()
  for (const scope of scopes) {
    try {
      const ids = await d.finalizeUnbackedOpenRunsForSupervisor({
        supervisorId: scope.supervisorId,
        liveSessionIds: scope.liveSessionIds,
        minAgeMs,
      })
      if (ids.length > 0) {
        reaped.push(...ids)
        console.warn(
          `[stale-run-reaper] closed ${ids.length} open session_run(s) absent from supervisor=${scope.supervisorId}'s ` +
          `live inventory and older than ${minAgeMs}ms (exit_reason=no_live_backing)`,
        )
      }
    } catch (err: any) {
      console.warn(`[stale-run-reaper] sweep failed supervisor=${scope.supervisorId}: ${err?.message ?? err}`)
    }
  }
  return reaped
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
