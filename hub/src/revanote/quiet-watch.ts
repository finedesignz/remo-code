// hub/src/revanote/quiet-watch.ts
// fix/revanote-quiet-alert — tell the owner when every client site goes quiet.
//
// Incident (2026-09): client comments stopped getting deployed for days. Busy
// slots, dead sessions and unpushed "resolved" replies each stalled the
// pipeline, and nothing said so: from the outside every client site simply
// went quiet. This watchdog looks at the whole Revanote pipeline per user,
// across ALL enabled site mappings, and alerts on two shapes:
//
//   stalled — comments are waiting (pending / dispatched / failed_offline, older
//             than REMO_REVANOTE_QUIET_BACKLOG_MIN_AGE_MS) and NOT ONE comment
//             from any site was resolved in the window. The pipeline is stuck.
//   silent  — no comment was received AND none resolved from any site in the
//             window, although sites sent comments in the 7 days before it.
//             Intake itself has stopped (webhook, mapping, or Revanote side).
//
// Any resolved comment on any site clears both, so one noisy site can't page.
// Alerts go through the shared notify fan-out (telegram + in-app + email) and
// are deduped per (user, kind) with a cooldown.

import { fanOutNotify } from '../orchestrator/notify.ts'

function parsePositiveIntEnv(raw: string | undefined, fallback: number): number {
  if (raw == null || raw === '') return fallback
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

function envFlagOn(raw: string | undefined): boolean {
  if (raw == null) return false
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase())
}

/** Quiet window. Default 24h. */
export const QUIET_WINDOW_MS = parsePositiveIntEnv(process.env.REMO_REVANOTE_QUIET_WINDOW_MS, 24 * 3_600_000)
/** A waiting comment counts toward "stalled" only once it's this old. Default 1h. */
export const QUIET_BACKLOG_MIN_AGE_MS = parsePositiveIntEnv(
  process.env.REMO_REVANOTE_QUIET_BACKLOG_MIN_AGE_MS,
  3_600_000,
)
/** Look-back before the window that proves sites were active ("silent" baseline). Default 7d. */
export const QUIET_BASELINE_MS = parsePositiveIntEnv(process.env.REMO_REVANOTE_QUIET_BASELINE_MS, 7 * 86_400_000)
/** Min gap between repeat alerts of the same kind for a user. Default 12h. */
export const QUIET_ALERT_COOLDOWN_MS = parsePositiveIntEnv(
  process.env.REMO_REVANOTE_QUIET_ALERT_COOLDOWN_MS,
  12 * 3_600_000,
)
/** Check cadence. Default 15min. */
export const QUIET_CHECK_INTERVAL_MS = parsePositiveIntEnv(
  process.env.REMO_REVANOTE_QUIET_CHECK_INTERVAL_MS,
  15 * 60_000,
)

export interface QuietStats {
  userId: string
  /** enabled site mappings for this user */
  sites: number
  resolvedInWindow: number
  receivedInWindow: number
  receivedInBaseline: number
  /** comments waiting longer than QUIET_BACKLOG_MIN_AGE_MS */
  backlog: number
  oldestBacklogAt: Date | null
}

export type QuietKind = 'stalled' | 'silent'

/** Pure classifier. `null` = healthy (or nothing to watch). */
export function classifyQuiet(s: QuietStats): QuietKind | null {
  if (s.sites === 0) return null
  if (s.resolvedInWindow > 0) return null
  if (s.backlog > 0) return 'stalled'
  if (s.receivedInWindow === 0 && s.receivedInBaseline > 0) return 'silent'
  return null
}

export function describeQuiet(kind: QuietKind, s: QuietStats): string {
  const hours = Math.round(QUIET_WINDOW_MS / 3_600_000)
  if (kind === 'stalled') {
    const oldest = s.oldestBacklogAt ? `, oldest since ${s.oldestBacklogAt.toISOString()}` : ''
    return (
      `Revanote: ${s.backlog} client comment(s) waiting and none resolved on any of ${s.sites} site(s) ` +
      `in ${hours}h${oldest}. The pipeline is stuck — check busy slots and offline sessions.`
    )
  }
  return (
    `Revanote: no comments received or resolved from any of ${s.sites} client site(s) in ${hours}h ` +
    `(${s.receivedInBaseline} in the week before). Intake may be broken — check the Revanote webhook and site mappings.`
  )
}

export interface QuietWatchDeps {
  loadStats: (now: number) => Promise<QuietStats[]>
  notify: typeof fanOutNotify
}

const REAL_DEPS: QuietWatchDeps = {
  loadStats: async (now) => {
    const { sql } = await import('../db/postgres.ts')
    const windowStart = new Date(now - QUIET_WINDOW_MS)
    const baselineStart = new Date(now - QUIET_WINDOW_MS - QUIET_BASELINE_MS)
    const backlogCutoff = new Date(now - QUIET_BACKLOG_MIN_AGE_MS)
    const rows = await sql<
      {
        user_id: string
        sites: string
        resolved_in_window: string
        received_in_window: string
        received_in_baseline: string
        backlog: string
        oldest_backlog_at: Date | null
      }[]
    >`
      SELECT m.user_id,
             m.sites,
             (SELECT COUNT(*) FROM annotations a
               WHERE a.user_id = m.user_id AND a.status = 'resolved'
                 AND a.resolved_at >= ${windowStart}) AS resolved_in_window,
             (SELECT COUNT(*) FROM annotations a
               WHERE a.user_id = m.user_id AND a.received_at >= ${windowStart}) AS received_in_window,
             (SELECT COUNT(*) FROM annotations a
               WHERE a.user_id = m.user_id AND a.received_at >= ${baselineStart}
                 AND a.received_at < ${windowStart}) AS received_in_baseline,
             (SELECT COUNT(*) FROM annotations a
               WHERE a.user_id = m.user_id
                 AND a.status IN ('pending', 'dispatched', 'failed_offline')
                 AND a.received_at < ${backlogCutoff}) AS backlog,
             (SELECT MIN(a.received_at) FROM annotations a
               WHERE a.user_id = m.user_id
                 AND a.status IN ('pending', 'dispatched', 'failed_offline')
                 AND a.received_at < ${backlogCutoff}) AS oldest_backlog_at
      FROM (
        SELECT user_id, COUNT(*) AS sites FROM revanote_app_mappings
        WHERE enabled = true GROUP BY user_id
      ) m
    `
    return rows.map((r) => ({
      userId: r.user_id,
      sites: Number(r.sites),
      resolvedInWindow: Number(r.resolved_in_window),
      receivedInWindow: Number(r.received_in_window),
      receivedInBaseline: Number(r.received_in_baseline),
      backlog: Number(r.backlog),
      oldestBacklogAt: r.oldest_backlog_at ? new Date(r.oldest_backlog_at) : null,
    }))
  },
  notify: fanOutNotify,
}

/** `${userId}\0${kind}` → last alert epoch ms. In-memory; a restart re-alerts once. */
const lastAlertAt = new Map<string, number>()

export function _resetQuietWatchState(): void {
  lastAlertAt.clear()
}

/** One check pass. Returns the alerts fired. Never throws. */
export async function checkRevanoteQuiet(
  now: number = Date.now(),
  deps?: Partial<QuietWatchDeps>,
): Promise<Array<{ userId: string; kind: QuietKind }>> {
  const d: QuietWatchDeps = { ...REAL_DEPS, ...deps }
  const fired: Array<{ userId: string; kind: QuietKind }> = []

  let stats: QuietStats[] = []
  try {
    stats = await d.loadStats(now)
  } catch (err: any) {
    console.warn(`[revanote.quiet] stats load failed: ${err?.message ?? err}`)
    return fired
  }

  for (const s of stats) {
    const kind = classifyQuiet(s)
    if (!kind) {
      // Healthy again: clear both so the next stall alerts immediately.
      lastAlertAt.delete(`${s.userId}\0stalled`)
      lastAlertAt.delete(`${s.userId}\0silent`)
      continue
    }
    const key = `${s.userId}\0${kind}`
    const last = lastAlertAt.get(key)
    if (last !== undefined && now - last < QUIET_ALERT_COOLDOWN_MS) continue
    lastAlertAt.set(key, now)
    const detail = describeQuiet(kind, s)
    console.error(`[revanote.quiet] ALERT user=${s.userId} kind=${kind} — ${detail}`)
    try {
      await d.notify({
        userId: s.userId,
        sessionId: '',
        event: 'failure',
        level: 'blocking',
        detail,
        channels: ['telegram', 'inapp', 'email'],
      })
    } catch (err: any) {
      console.warn(`[revanote.quiet] notify failed user=${s.userId}: ${err?.message ?? err}`)
    }
    fired.push({ userId: s.userId, kind })
  }
  return fired
}

let timer: ReturnType<typeof setInterval> | null = null

/** Start the periodic check (idempotent). No-op when REMO_REVANOTE_QUIET_ALERT_DISABLED. */
export function startRevanoteQuietWatch(): void {
  if (envFlagOn(process.env.REMO_REVANOTE_QUIET_ALERT_DISABLED)) {
    console.log('[revanote.quiet] disabled via REMO_REVANOTE_QUIET_ALERT_DISABLED — watch not started')
    return
  }
  if (timer) return
  timer = setInterval(() => {
    void checkRevanoteQuiet()
  }, QUIET_CHECK_INTERVAL_MS)
  ;(timer as any)?.unref?.()
}

export function stopRevanoteQuietWatch(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}
