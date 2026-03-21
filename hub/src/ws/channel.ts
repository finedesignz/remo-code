import type { ServerWebSocket } from 'bun'
import { ChannelInbound } from './protocol'
import { verifyChannelToken, setSessionStatus, insertMessage } from '../db/dal'
import { registerChannel, unregisterChannel, broadcastToSubscribers } from './registry'

const AUTH_TIMEOUT_MS = 5_000
const HEARTBEAT_INTERVAL_MS = 30_000

interface ChannelWsData {
  authenticated: boolean
  sessionId: string | null
  userId: string | null
  authTimer: ReturnType<typeof setTimeout> | null
  heartbeatTimer: ReturnType<typeof setInterval> | null
}

export function createChannelWsData(): ChannelWsData {
  return {
    authenticated: false,
    sessionId: null,
    userId: null,
    authTimer: null,
    heartbeatTimer: null,
  }
}

export async function hashToken(token: string): Promise<string> {
  const encoder = new TextEncoder()
  const data = encoder.encode(token)
  const hash = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('')
}

export function handleChannelOpen(ws: ServerWebSocket<ChannelWsData>) {
  const data = ws.data
  // Require auth within 5 seconds
  data.authTimer = setTimeout(() => {
    if (!data.authenticated) {
      ws.close(4000, 'auth timeout')
    }
  }, AUTH_TIMEOUT_MS)
}

export async function handleChannelMessage(ws: ServerWebSocket<ChannelWsData>, raw: string) {
  const data = ws.data

  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { return }

  const result = ChannelInbound.safeParse(parsed)
  if (!result.success) return

  const msg = result.data

  if (msg.type === 'auth') {
    if (data.authenticated) return

    const session = await verifyChannelToken(msg.session_id)
    if (!session) {
      ws.send(JSON.stringify({ type: 'auth_error', error: 'invalid' }))
      ws.close(4001, 'auth failed')
      return
    }

    const tokenHash = await hashToken(msg.token)
    if (tokenHash !== session.token_hash) {
      ws.send(JSON.stringify({ type: 'auth_error', error: 'invalid' }))
      ws.close(4001, 'auth failed')
      return
    }

    // Authenticated
    data.authenticated = true
    data.sessionId = session.id
    data.userId = session.user_id
    if (data.authTimer) clearTimeout(data.authTimer)

    registerChannel(session.id, session.user_id, ws)
    await setSessionStatus(session.id, 'online')

    ws.send(JSON.stringify({ type: 'auth_ok' }))

    // Broadcast status to subscribed clients
    broadcastToSubscribers(session.id, {
      type: 'session_status',
      session_id: session.id,
      status: 'online',
    })

    // Start heartbeat
    data.heartbeatTimer = setInterval(() => {
      try { ws.send(JSON.stringify({ type: 'ping' })) } catch {}
    }, HEARTBEAT_INTERVAL_MS)

    return
  }

  if (!data.authenticated || !data.sessionId) return

  if (msg.type === 'assistant_message') {
    // Store message and broadcast to subscribed clients
    const message = await insertMessage(data.sessionId, 'assistant', msg.content)
    broadcastToSubscribers(data.sessionId, {
      type: 'message',
      session_id: data.sessionId,
      message,
    })
  }

  if (msg.type === 'status') {
    const status = msg.status === 'thinking' ? 'thinking' : 'online'
    await setSessionStatus(data.sessionId, status as any)
    broadcastToSubscribers(data.sessionId, {
      type: 'session_status',
      session_id: data.sessionId,
      status,
    })
  }
}

export async function handleChannelClose(ws: ServerWebSocket<ChannelWsData>) {
  const data = ws.data
  if (data.authTimer) clearTimeout(data.authTimer)
  if (data.heartbeatTimer) clearInterval(data.heartbeatTimer)

  if (data.sessionId) {
    unregisterChannel(data.sessionId)
    await setSessionStatus(data.sessionId, 'offline')
    broadcastToSubscribers(data.sessionId, {
      type: 'session_status',
      session_id: data.sessionId,
      status: 'offline',
    })
  }
}
