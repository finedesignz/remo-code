import type { ServerWebSocket } from 'bun'
import { ScheduledRunEvent } from './protocol'

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
  }
  channels.set(sessionId, { ws, userId, sessionId })
}

export function unregisterChannel(sessionId: string) {
  channels.delete(sessionId)
}

export function getChannel(sessionId: string) {
  return channels.get(sessionId)
}

export function isSessionOnline(sessionId: string) {
  return channels.has(sessionId)
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
  return entry
}

export function unregisterClient(entry: ClientEntry) {
  clients.delete(entry)
}

export function subscribeClient(entry: ClientEntry, sessionIds: string[]) {
  entry.subscriptions = new Set(sessionIds) // Replace, don't accumulate (M6 fix)
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
