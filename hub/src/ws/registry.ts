import type { ServerWebSocket } from 'bun'

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
