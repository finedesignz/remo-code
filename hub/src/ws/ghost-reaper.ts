// hub/src/ws/ghost-reaper.ts
// fix/ghost-session-reaper — kills "ghost sessions" that wedge the auto-dev orchestrator.
//
// BUG (verified in prod 2026-07-09): the `/ws/agent` auth path always calls
// `registerChannel` + `setSessionStatus('online')`, but only persists
// `sessions.hostname` when the auth frame carries a hostname
// (`hub/src/ws/agent.ts` ~line 363). A SessionBridge that resumes WITHOUT a
// hostname therefore yields a live phantom channel + a `status='online',
// hostname=NULL` row that survives hub restarts (the bridge re-auths). Because
// `getChannel(sessionId) != null`, the orchestrator inject treats it as online
// and dispatches into the void; autospawn (which needs getChannel==null) never
// fires, so no real build session ever spawns and no PRs are produced.
//
// Legit supervisor and rootless sessions ALWAYS carry a hostname, so
// `status='online' AND hostname IS NULL` (beyond a short grace window) is a
// clean, low-false-positive ghost signature. This module periodically scans the
// live agent channels, classifies ghosts, closes the phantom socket,
// unregisters the channel, and flips the row to `offline` — after which the next
// orchestrator tick sees `getChannel == null` and autospawns a real session.

import { getChannel, listChannelSessionIds, unregisterChannel } from './registry.ts'
import { updateSessionStatus } from '../db/dal.ts'
import { sql } from '../db/postgres.ts'

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
 * How long a `status='online', hostname=NULL` channel may persist before it's
 * classified as a ghost. Default 2min — long enough that a legit agent mid-auth
 * (which sets hostname a beat later) is never caught. Env override:
 * REMO_GHOST_GRACE_MS (non-positive / non-finite ⇒ default).
 */
export const GHOST_GRACE_MS = parsePositiveIntEnv(process.env.REMO_GHOST_GRACE_MS, 120_000)

/** Sweep cadence. Default 60s. Env override: REMO_GHOST_SWEEP_INTERVAL_MS. */
export const GHOST_SWEEP_INTERVAL_MS = parsePositiveIntEnv(
  process.env.REMO_GHOST_SWEEP_INTERVAL_MS,
  60_000,
)

/** Minimal session shape the reaper needs to classify a ghost. */
export interface GhostSessionRow {
  status: string | null
  hostname: string | null
  /** last_activity as epoch millis (null when the column is NULL). */
  last_activity_ms: number | null
  is_orchestrator: boolean
}

// Injectable seams (tests swap these; defaults are the real adapters).
export interface GhostReaperDeps {
  listChannelSessionIds: () => string[]
  loadSession: (sessionId: string) => Promise<GhostSessionRow | null>
  closeChannel: (sessionId: string) => void
  unregisterChannel: (sessionId: string) => void
  setSessionStatus: (sessionId: string, status: string) => Promise<void>
  now: () => number
}

const REAL_DEPS: GhostReaperDeps = {
  listChannelSessionIds,
  loadSession: async (sessionId) => {
    const rows = await sql<
      { status: string | null; hostname: string | null; last_activity_ms: string | null; is_orchestrator: boolean }[]
    >`
      SELECT status, hostname,
             EXTRACT(EPOCH FROM last_activity) * 1000 AS last_activity_ms,
             is_orchestrator
      FROM sessions WHERE id = ${sessionId} AND deleted_at IS NULL LIMIT 1
    `
    const r = rows[0]
    if (!r) return null
    return {
      status: r.status,
      hostname: r.hostname,
      last_activity_ms: r.last_activity_ms == null ? null : Number(r.last_activity_ms),
      is_orchestrator: r.is_orchestrator,
    }
  },
  closeChannel: (sessionId) => {
    const ch = getChannel(sessionId)
    try {
      ch?.ws.close(4004, 'ghost_reaped')
    } catch {}
  },
  unregisterChannel,
  setSessionStatus: (sessionId, status) => updateSessionStatus(sessionId, status),
  now: () => Date.now(),
}

/**
 * A row is a ghost when it is `status='online'`, `hostname IS NULL`, has aged
 * past GHOST_GRACE_MS, and is NOT the orchestrator session (never reaped — the
 * orchestrator is a legit hostname-less coordinator and its own concern).
 */
function isGhost(row: GhostSessionRow, now: number): boolean {
  if (row.is_orchestrator) return false
  if (row.status !== 'online') return false
  if (row.hostname != null) return false
  if (row.last_activity_ms == null) return false
  return now - row.last_activity_ms >= GHOST_GRACE_MS
}

/**
 * One reap pass: for every live agent channel, load its session row and — if it
 * matches the ghost signature — close the phantom socket, unregister the
 * channel, and flip the row to `offline`. Best-effort per session (a DB/socket
 * error on one session never aborts the sweep). Returns the sessionIds reaped.
 */
export async function reapGhostSessions(
  now: number = Date.now(),
  deps?: Partial<GhostReaperDeps>,
): Promise<string[]> {
  const d: GhostReaperDeps = { ...REAL_DEPS, ...deps }
  const reaped: string[] = []

  let ids: string[] = []
  try {
    ids = d.listChannelSessionIds()
  } catch (err: any) {
    console.warn(`[ghost-reaper] channel enumerate failed: ${err?.message ?? err}`)
    return reaped
  }

  for (const id of ids) {
    try {
      const row = await d.loadSession(id)
      if (!row || !isGhost(row, now)) continue

      d.closeChannel(id)
      d.unregisterChannel(id)
      await d.setSessionStatus(id, 'offline')
      reaped.push(id)
      console.warn(
        `[ghost-reaper] reaped session=${id} (online + hostname=NULL, aged past ${GHOST_GRACE_MS}ms) — flipped offline so next tick can autospawn a real session`,
      )
    } catch (err: any) {
      console.warn(`[ghost-reaper] reap failed session=${id}: ${err?.message ?? err}`)
    }
  }

  return reaped
}

let sweepTimer: ReturnType<typeof setInterval> | null = null

/**
 * Start the periodic ghost sweep (idempotent). No-op when
 * REMO_GHOST_REAPER_DISABLED is set (1|true|yes|on). Runs `reapGhostSessions`
 * every GHOST_SWEEP_INTERVAL_MS; each pass is self-contained and fail-open.
 */
export function startGhostReaperSweep(): void {
  if (envFlagOn(process.env.REMO_GHOST_REAPER_DISABLED)) {
    console.log('[ghost-reaper] disabled via REMO_GHOST_REAPER_DISABLED — sweep not started')
    return
  }
  if (sweepTimer) return
  sweepTimer = setInterval(() => {
    reapGhostSessions().catch((err) =>
      console.warn(`[ghost-reaper] sweep pass failed: ${err?.message ?? err}`),
    )
  }, GHOST_SWEEP_INTERVAL_MS)
  // Don't keep the event loop alive solely for the sweep.
  ;(sweepTimer as any)?.unref?.()
}

/** Stop the periodic sweep (test hook / graceful shutdown). */
export function stopGhostReaperSweep(): void {
  if (sweepTimer) {
    clearInterval(sweepTimer)
    sweepTimer = null
  }
}
