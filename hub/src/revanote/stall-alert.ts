// hub/src/revanote/stall-alert.ts
//
// Owner-visible alert when revanote intake silently stalls.
//
// BACKGROUND (see scratchpad diagnosis 2026-09, memory
// project_revanote_intake_blocked_twice.md): all ~23 revanote client sites map
// onto ONE remo-code session (`hyperoptimized-sites`, in-flight cap 1). When
// that single session wedges, EVERY client's annotations silently pile up as
// `failed`/`failed_offline`/parked-`pending` with zero owner-visible signal —
// the callback to revanote reports the failure, but nothing tells the owner.
// This sweep is the missing alarm, not a fix to the one-session-per-fleet
// architecture (out of scope).
//
// Two independent stall signatures, modeled on `scheduler/run-reaper.ts`:
//
//   A. STALLED ANNOTATIONS — an annotation has been sitting unresolved past
//      REMO_REVANOTE_STALL_PARKED_MAX_MS (default 1h) in one of:
//        - parked offline:  status='pending' AND skip_reason='session_offline'
//        - rejected:        status='failed'  (session_busy / budget / no_target)
//        - target-offline:  status='failed_offline' (grace TTL lapsed)
//      Age is measured from `dispatched_at` when set, else `received_at`.
//
//   B. STUCK IN-FLIGHT RUNS — an `annotation_runs` row has sat `status='in_flight'`
//      past REMO_REVANOTE_STALL_RUN_MAX_MS (default 30min). The dispatcher's own
//      `finalizeTimeoutMs` (default 20min) is supposed to force a finalize before
//      this — a run still in_flight at 30min means even that forced fallback
//      never fired (session wedged / process stuck), which is a strictly worse
//      signal than A and worth its own threshold.
//
// De-dup: ONE row per user in `revanote_stall_alerts` tracks `last_alert_at`.
// A user with any qualifying stall gets AT MOST one fan-out per
// REMO_REVANOTE_STALL_COOLDOWN_MS (default 1h) — never one email per annotation
// (there can be dozens across 23 sites at once).
//
// Channel: reuses the existing orchestrator fan-out (`orchestrator/notify.ts`
// `fanOutNotify` — telegram + in-app + emails4agents email), per-user opt-in
// respected. No new transport invented.

import { sql } from '../db/postgres.ts'
import { fanOutNotify, type NotifyDeps } from '../orchestrator/notify.ts'

function parsePositiveIntEnv(raw: string | undefined, fallback: number): number {
  if (raw == null || raw === '') return fallback
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

function envFlagOn(raw: string | undefined): boolean {
  if (raw == null) return false
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase())
}

/** Age threshold for a parked/rejected/target-offline annotation. Default 1h. */
export const STALL_PARKED_MAX_MS = parsePositiveIntEnv(
  process.env.REMO_REVANOTE_STALL_PARKED_MAX_MS,
  3_600_000,
)

/** Age threshold for a stuck in_flight annotation_run. Default 30min. */
export const STALL_RUN_MAX_MS = parsePositiveIntEnv(
  process.env.REMO_REVANOTE_STALL_RUN_MAX_MS,
  1_800_000,
)

/** Sweep cadence. Default 5min. */
export const STALL_SWEEP_INTERVAL_MS = parsePositiveIntEnv(
  process.env.REMO_REVANOTE_STALL_SWEEP_INTERVAL_MS,
  300_000,
)

/** Per-user re-alert cooldown, so a persistent stall doesn't spam. Default 1h. */
export const STALL_COOLDOWN_MS = parsePositiveIntEnv(
  process.env.REMO_REVANOTE_STALL_COOLDOWN_MS,
  3_600_000,
)

export interface UserStallSummary {
  user_id: string
  parked_count: number
  parked_oldest_ms: number | null
  stuck_run_count: number
  stuck_run_oldest_ms: number | null
}

/** Injectable seams (tests swap these; defaults are the real adapters). */
export interface StallAlertDeps {
  loadStalledPerUser: (now: number) => Promise<UserStallSummary[]>
  getLastAlertAt: (userId: string) => Promise<number | null>
  recordAlert: (userId: string, now: number) => Promise<void>
  notify: (input: {
    userId: string
    sessionId: string
    detail: string
  }) => Promise<{ delivered: string[] }>
}

const REAL_DEPS: StallAlertDeps = {
  loadStalledPerUser: async (now: number) => {
    const parkedCutoff = new Date(now - STALL_PARKED_MAX_MS)
    const runCutoff = new Date(now - STALL_RUN_MAX_MS)

    const parkedRows = await sql<
      { user_id: string; cnt: string; oldest: string }[]
    >`
      SELECT user_id, COUNT(*) AS cnt, MIN(COALESCE(dispatched_at, received_at)) AS oldest
      FROM annotations
      WHERE (
        (status = 'pending' AND skip_reason = 'session_offline')
        OR status IN ('failed', 'failed_offline')
      )
      AND COALESCE(dispatched_at, received_at) < ${parkedCutoff}
      GROUP BY user_id
    `

    const stuckRunRows = await sql<
      { user_id: string; cnt: string; oldest: string }[]
    >`
      SELECT user_id, COUNT(*) AS cnt, MIN(started_at) AS oldest
      FROM annotation_runs
      WHERE status = 'in_flight' AND started_at < ${runCutoff}
      GROUP BY user_id
    `

    const byUser = new Map<string, UserStallSummary>()
    for (const r of parkedRows) {
      byUser.set(r.user_id, {
        user_id: r.user_id,
        parked_count: Number(r.cnt),
        parked_oldest_ms: new Date(r.oldest).getTime(),
        stuck_run_count: 0,
        stuck_run_oldest_ms: null,
      })
    }
    for (const r of stuckRunRows) {
      const existing = byUser.get(r.user_id)
      if (existing) {
        existing.stuck_run_count = Number(r.cnt)
        existing.stuck_run_oldest_ms = new Date(r.oldest).getTime()
      } else {
        byUser.set(r.user_id, {
          user_id: r.user_id,
          parked_count: 0,
          parked_oldest_ms: null,
          stuck_run_count: Number(r.cnt),
          stuck_run_oldest_ms: new Date(r.oldest).getTime(),
        })
      }
    }
    return [...byUser.values()]
  },

  getLastAlertAt: async (userId: string) => {
    const rows = await sql<{ last_alert_at: string }[]>`
      SELECT last_alert_at FROM revanote_stall_alerts WHERE user_id = ${userId}
    `
    return rows[0] ? new Date(rows[0].last_alert_at).getTime() : null
  },

  recordAlert: async (userId: string, now: number) => {
    await sql`
      INSERT INTO revanote_stall_alerts (user_id, last_alert_at)
      VALUES (${userId}, ${new Date(now)})
      ON CONFLICT (user_id) DO UPDATE SET last_alert_at = EXCLUDED.last_alert_at
    `
  },

  notify: async ({ userId, sessionId, detail }) => {
    return fanOutNotify({
      userId,
      sessionId,
      event: 'failure',
      level: 'blocking',
      detail,
      channels: ['telegram', 'inapp', 'email'],
    })
  },
}

function formatDetail(s: UserStallSummary, now: number): string {
  const parts: string[] = []
  if (s.parked_count > 0) {
    const ageMin = s.parked_oldest_ms != null ? Math.round((now - s.parked_oldest_ms) / 60_000) : 0
    parts.push(`${s.parked_count} revanote annotation(s) parked/rejected/target-offline (oldest ~${ageMin}m)`)
  }
  if (s.stuck_run_count > 0) {
    const ageMin = s.stuck_run_oldest_ms != null ? Math.round((now - s.stuck_run_oldest_ms) / 60_000) : 0
    parts.push(`${s.stuck_run_count} revanote run(s) stuck in-flight (oldest ~${ageMin}m)`)
  }
  return `Revanote intake looks stalled: ${parts.join('; ')}. Check the client-site session.`
}

/**
 * One sweep pass: find every user with a qualifying stall signature and fan
 * out at most one alert per user per STALL_COOLDOWN_MS. Best-effort per user —
 * one failure never aborts the pass. Returns the userIds actually alerted.
 */
export async function sweepRevanoteStalls(
  now: number = Date.now(),
  deps?: Partial<StallAlertDeps>,
): Promise<string[]> {
  const d: StallAlertDeps = { ...REAL_DEPS, ...deps }
  const alerted: string[] = []

  let summaries: UserStallSummary[] = []
  try {
    summaries = await d.loadStalledPerUser(now)
  } catch (err: any) {
    console.warn(`[revanote-stall-alert] load failed: ${err?.message ?? err}`)
    return alerted
  }

  for (const s of summaries) {
    if (s.parked_count === 0 && s.stuck_run_count === 0) continue
    try {
      const lastAlertAt = await d.getLastAlertAt(s.user_id)
      if (lastAlertAt != null && now - lastAlertAt < STALL_COOLDOWN_MS) continue

      const detail = formatDetail(s, now)
      await d.notify({ userId: s.user_id, sessionId: '', detail })
      await d.recordAlert(s.user_id, now)
      alerted.push(s.user_id)
      console.warn(`[revanote-stall-alert] alerted user=${s.user_id}: ${detail}`)
    } catch (err: any) {
      console.warn(`[revanote-stall-alert] alert failed for user=${s.user_id}: ${err?.message ?? err}`)
    }
  }

  return alerted
}

let sweepTimer: ReturnType<typeof setInterval> | null = null

/**
 * Start the periodic revanote-stall sweep (idempotent). No-op when
 * REMO_REVANOTE_STALL_DISABLED is set (1|true|yes|on).
 */
export function startRevanoteStallSweep(): void {
  if (envFlagOn(process.env.REMO_REVANOTE_STALL_DISABLED)) {
    console.log('[revanote-stall-alert] disabled via REMO_REVANOTE_STALL_DISABLED — sweep not started')
    return
  }
  if (sweepTimer) return
  sweepTimer = setInterval(() => {
    sweepRevanoteStalls().catch((err) =>
      console.warn(`[revanote-stall-alert] sweep pass failed: ${err?.message ?? err}`),
    )
  }, STALL_SWEEP_INTERVAL_MS)
  ;(sweepTimer as any)?.unref?.()
}

/** Stop the periodic sweep (test hook / graceful shutdown). */
export function stopRevanoteStallSweep(): void {
  if (sweepTimer) {
    clearInterval(sweepTimer)
    sweepTimer = null
  }
}

// Re-exported so callers/tests can type deps without importing notify.ts directly.
export type { NotifyDeps }
