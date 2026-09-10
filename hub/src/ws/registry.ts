import type { ServerWebSocket } from 'bun'
import { ScheduledRunEvent, ErrorCaptureEvent, RevanoteEvent } from './protocol'
import { wsConnections } from '../observability/metrics'

interface ChannelEntry {
  ws: ServerWebSocket<any>
  userId: string
  sessionId: string
}

export interface ClientEntry {
  ws: ServerWebSocket<any>
  userId: string
  subscriptions: Set<string>
}

// In-memory registries — cleared on restart, rebuilt from connections
const channels = new Map<string, ChannelEntry>()     // sessionId -> channel ws
const clients = new Set<ClientEntry>()

// -- Channel registry --

export function registerChannel(sessionId: string, userId: string, ws: ServerWebSocket<any>) {
  // Close existing connection for this session (one connection per session)
  const existing = channels.get(sessionId)
  if (existing) {
    try { existing.ws.close(4003, 'replaced') } catch {}
    // replaced — gauge unchanged
  } else {
    wsConnections.inc({ role: 'agent' })
  }
  channels.set(sessionId, { ws, userId, sessionId })
}

export function unregisterChannel(sessionId: string) {
  if (channels.delete(sessionId)) {
    wsConnections.dec({ role: 'agent' })
  }
}

export function getChannel(sessionId: string) {
  return channels.get(sessionId)
}

export function isSessionOnline(sessionId: string) {
  return channels.has(sessionId)
}

// fix/ghost-session-reaper — enumerate all live agent-channel session IDs.
// Used by the ghost-reaper sweep to classify + reap phantom channels
// (status='online', hostname=NULL) that survive hub restarts.
export function listChannelSessionIds(): string[] {
  return Array.from(channels.keys())
}

// Plan 04-008 — list connected agent-channel session IDs for a user.
// Used by `pickSessionTarget` for the local-agent fallback (step 3).
export function listOnlineAgentSessionsForUser(userId: string): string[] {
  const out: string[] = []
  for (const [sessionId, entry] of channels) {
    if (entry.userId === userId) out.push(sessionId)
  }
  return out
}

// -- Client registry --

export function registerClient(userId: string, ws: ServerWebSocket<any>): ClientEntry {
  const entry: ClientEntry = { ws, userId, subscriptions: new Set() }
  clients.add(entry)
  wsConnections.inc({ role: 'client' })
  return entry
}

export function unregisterClient(entry: ClientEntry) {
  if (clients.delete(entry)) {
    wsConnections.dec({ role: 'client' })
  }
}

export function subscribeClient(entry: ClientEntry, sessionIds: string[]) {
  entry.subscriptions = new Set(sessionIds) // Replace, don't accumulate (M6 fix)
}

/**
 * Bug B (2026-05-28) — count distinct client connections currently subscribed
 * to a session_id. Used by the idle-teardown module to decide when the last
 * web UI walked away from a runner.
 */
export function countSubscribers(sessionId: string): number {
  let n = 0
  for (const c of clients) if (c.subscriptions.has(sessionId)) n++
  return n
}

/**
 * All session_ids any web client of any user is currently subscribed to.
 * Used after a client disconnects to recompute counts for everything that
 * client cared about.
 */
export function snapshotSubscribedSessionIds(): Set<string> {
  const out = new Set<string>()
  for (const c of clients) for (const id of c.subscriptions) out.add(id)
  return out
}

// Broadcast to all clients subscribed to a session
export function broadcastToSubscribers(sessionId: string, message: object) {
  const json = JSON.stringify(message)
  for (const client of clients) {
    if (client.subscriptions.has(sessionId)) {
      try { client.ws.send(json) } catch {}
    }
  }
}

// Broadcast to all clients of a specific user
export function broadcastToUser(userId: string, message: object) {
  const json = JSON.stringify(message)
  for (const client of clients) {
    if (client.userId === userId) {
      try { client.ws.send(json) } catch {}
    }
  }
}

/**
 * Validated broadcast for scheduled-run lifecycle events (W3/T15).
 * The dispatcher emits these via `broadcastToUser` directly today; this
 * helper validates the payload against the Zod schema before sending so
 * any shape drift is caught at dev time instead of silently shipping
 * malformed JSON to the web UI.
 *
 * Drops the message (with a logged warning) on validation failure rather
 * than throwing — the dispatcher must keep working.
 */
export function broadcastScheduledRun(userId: string, event: unknown) {
  const parsed = ScheduledRunEvent.safeParse(event)
  if (!parsed.success) {
    console.warn(
      `[ws.registry] broadcastScheduledRun dropped invalid event for user=${userId}:`,
      parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    )
    return
  }
  broadcastToUser(userId, parsed.data)
}

/**
 * Validated broadcast for error-capture lifecycle events (W3/T5). Mirrors
 * `broadcastScheduledRun`. Drops the message with a logged warning on schema
 * mismatch — never throws.
 */
export function broadcastErrorEvent(userId: string, event: unknown) {
  const parsed = ErrorCaptureEvent.safeParse(event)
  if (!parsed.success) {
    console.warn(
      `[ws.registry] broadcastErrorEvent dropped invalid event for user=${userId}:`,
      parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    )
    return
  }
  broadcastToUser(userId, parsed.data)
}

/**
 * Validated broadcast for Revanote annotation lifecycle events (Phase 08).
 * Mirrors `broadcastErrorEvent`. Drops on schema mismatch, never throws.
 */
export function broadcastRevanoteEvent(userId: string, event: unknown) {
  const parsed = RevanoteEvent.safeParse(event)
  if (!parsed.success) {
    console.warn(
      `[ws.registry] broadcastRevanoteEvent dropped invalid event for user=${userId}:`,
      parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    )
    return
  }
  broadcastToUser(userId, parsed.data)
}
