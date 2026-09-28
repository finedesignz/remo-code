// hub/src/ws/dead-session-reaper.ts
// fix/dead-session-online — a session whose CLI process has exited must not keep
// looking online.
//
// BUG: the supervisor's per-session SessionBridge holds the `/ws/agent` socket
// open independently of the CLI it hosts. When the CLI exited cleanly, hit the
// restart cap, or tripped the spawn circuit breaker, the supervisor stopped
// tracking the run (it drops out of `session_inventory`) but left the bridge's
// socket open. The hub kept the session `online` with a live channel, so every
// dispatch was sent into a dead runner, and because the session never looked
// offline, nothing (autospawn, spawn-on-error, grace replay) ever restarted it.
// Revanote comments bound to that session sat forever.
//
// The supervisor fix (retire the bridge with the run) needs a new signed MSI.
// This sweep closes the gap from the hub side, on POSITIVE knowledge only:
//   a channel is dead when the supervisor on its host has pushed a FRESH
//   session_inventory that does not contain it, continuously for the grace.
// A host whose supervisor is disconnected, never pushed, or stopped pushing
// contributes nothing — "unknown" is never treated as "dead".
//
// Reap = send `shutdown` (the bridge stops itself), close the socket with 4002
// (terminal for the bridge: no reconnect), unregister, flip the row `offline`,
// and release any dispatch-pipeline slot the session held so queued work
// (e.g. Revanote comments) is re-dispatched and the session gets restarted.

import { getChannel, listChannelSessionIds, unregisterChannel, broadcastToUser } from './registry.ts'
import { getFreshInventoryForHost } from './supervisor-registry.ts'
import { updateSessionStatus } from '../db/dal.ts'
import { sql } from '../db/postgres.ts'
import { releaseClosedRun } from '../dispatch/pipeline.ts'

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
 * How long a channel must be continuously absent from its host supervisor's
 * fresh inventory before it's reaped. Default 2min (inventory pushes every
 * ~10s; a just-spawned run is stamped with its session id after auth_ok).
 */
export const DEAD_SESSION_GRACE_MS = parsePositiveIntEnv(process.env.REMO_DEAD_SESSION_GRACE_MS, 120_000)

/** An inventory older than this is treated as unknown. Default 60s. */
export const DEAD_SESSION_INVENTORY_MAX_AGE_MS = parsePositiveIntEnv(
  process.env.REMO_DEAD_SESSION_INVENTORY_MAX_AGE_MS,
  60_000,
)

/** Sweep cadence. Default 30s. */
export const DEAD_SESSION_SWEEP_INTERVAL_MS = parsePositiveIntEnv(
  process.env.REMO_DEAD_SESSION_SWEEP_INTERVAL_MS,
  30_000,
)

export interface DeadSessionRow {
  user_id: string
  status: string | null
  hostname: string | null
}

export interface DeadSessionReaperDeps {
  listChannelSessionIds: () => string[]
  loadSession: (sessionId: string) => Promise<DeadSessionRow | null>
  /** Live session ids per fresh-inventory supervisor on this host (empty = unknown). */
  hostInventory: (userId: string, hostname: string, now: number) => Array<{ liveSessionIds: Set<string> }>
  shutdownChannel: (sessionId: string) => void
  unregisterChannel: (sessionId: string) => void
  setSessionStatus: (sessionId: string, status: string) => Promise<void>
  releaseSlot: (sessionId: string) => Promise<unknown>
  notifyOffline: (userId: string, sessionId: string) => void
}

const REAL_DEPS: DeadSessionReaperDeps = {
  listChannelSessionIds,
  loadSession: async (sessionId) => {
    const rows = await sql<DeadSessionRow[]>`
      SELECT user_id, status, hostname FROM sessions
      WHERE id = ${sessionId} AND deleted_at IS NULL LIMIT 1
    `
    return rows[0] ?? null
  },
  hostInventory: (userId, hostname, now) =>
    getFreshInventoryForHost(userId, hostname, DEAD_SESSION_INVENTORY_MAX_AGE_MS, now),
  shutdownChannel: (sessionId) => {
    const ch = getChannel(sessionId)
    if (!ch) return
    try {
      ch.ws.send(JSON.stringify({ type: 'shutdown', reason: 'dead_session_reaped' }))
    } catch {}
    try {
      ch.ws.close(4002, 'dead_session_reaped')
    } catch {}
  },
  unregisterChannel,
  setSessionStatus: (sessionId, status) => updateSessionStatus(sessionId, status),
  releaseSlot: (sessionId) => releaseClosedRun(sessionId, 'session_process_exited'),
  notifyOffline: (userId, sessionId) => {
    try {
      broadcastToUser(userId, { type: 'session_status', session_id: sessionId, status: 'offline' })
    } catch {}
  },
}

/** First instant each channel was seen absent from a fresh host inventory. */
const firstSeenAbsentAt = new Map<string, number>()

export function _resetDeadSessionReaperState(): void {
  firstSeenAbsentAt.clear()
}

/**
 * One pass. Returns the session ids reaped. Best-effort per session; one
 * failure never aborts the sweep.
 */
export async function reapDeadSessions(
  now: number = Date.now(),
  deps?: Partial<DeadSessionReaperDeps>,
): Promise<string[]> {
  const d: DeadSessionReaperDeps = { ...REAL_DEPS, ...deps }
  const reaped: string[] = []

  let ids: string[] = []
  try {
    ids = d.listChannelSessionIds()
  } catch (err: any) {
    console.warn(`[dead-session-reaper] channel enumerate failed: ${err?.message ?? err}`)
    return reaped
  }
  const liveChannels = new Set(ids)

  for (const id of ids) {
    try {
      const row = await d.loadSession(id)
      if (!row || !row.hostname || (row.status !== 'online' && row.status !== 'thinking')) {
        firstSeenAbsentAt.delete(id)
        continue
      }
      const inventories = d.hostInventory(row.user_id, row.hostname, now)
      // No fresh inventory for this host ⇒ we know nothing ⇒ never reap.
      if (inventories.length === 0 || inventories.some((inv) => inv.liveSessionIds.has(id))) {
        firstSeenAbsentAt.delete(id)
        continue
      }

      const firstSeen = firstSeenAbsentAt.get(id) ?? now
      firstSeenAbsentAt.set(id, firstSeen)
      if (now - firstSeen < DEAD_SESSION_GRACE_MS) continue

      d.shutdownChannel(id)
      d.unregisterChannel(id)
      await d.setSessionStatus(id, 'offline')
      d.notifyOffline(row.user_id, id)
      try {
        await d.releaseSlot(id)
      } catch (err: any) {
        console.warn(`[dead-session-reaper] slot release failed session=${id}: ${err?.message ?? err}`)
      }
      firstSeenAbsentAt.delete(id)
      reaped.push(id)
      console.warn(
        `[dead-session-reaper] reaped session=${id} host=${row.hostname} — channel open but absent from the ` +
          `host supervisor's inventory for ≥${DEAD_SESSION_GRACE_MS}ms (CLI exited); flipped offline so it restarts`,
      )
    } catch (err: any) {
      console.warn(`[dead-session-reaper] reap failed session=${id}: ${err?.message ?? err}`)
    }
  }

  for (const id of firstSeenAbsentAt.keys()) {
    if (!liveChannels.has(id)) firstSeenAbsentAt.delete(id)
  }
  return reaped
}

let sweepTimer: ReturnType<typeof setInterval> | null = null

/** Start the periodic sweep (idempotent). No-op when REMO_DEAD_SESSION_REAPER_DISABLED. */
export function startDeadSessionReaperSweep(): void {
  if (envFlagOn(process.env.REMO_DEAD_SESSION_REAPER_DISABLED)) {
    console.log('[dead-session-reaper] disabled via REMO_DEAD_SESSION_REAPER_DISABLED — sweep not started')
    return
  }
  if (sweepTimer) return
  sweepTimer = setInterval(() => {
    reapDeadSessions().catch((err) =>
      console.warn(`[dead-session-reaper] sweep pass failed: ${err?.message ?? err}`),
    )
  }, DEAD_SESSION_SWEEP_INTERVAL_MS)
  ;(sweepTimer as any)?.unref?.()
}

export function stopDeadSessionReaperSweep(): void {
  if (sweepTimer) {
    clearInterval(sweepTimer)
    sweepTimer = null
  }
}
