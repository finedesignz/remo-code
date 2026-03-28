import type { ServerWebSocket } from 'bun'
import { timingSafeEqual } from 'crypto'
import { ChannelInbound } from './protocol'
import { verifyChannelToken, setSessionStatus, insertMessage } from '../db/dal'
import { registerChannel, unregisterChannel, broadcastToSubscribers, broadcastToUser } from './registry'
import { listSessions } from '../db/dal'
import { supabaseAdmin } from '../db/supabase'

const AUTH_TIMEOUT_MS = 5_000
const HEARTBEAT_INTERVAL_MS = 30_000
const MSG_RATE_WINDOW_MS = 10_000
const MSG_RATE_MAX = 60 // channels send more (assistant messages can be frequent)

interface ChannelWsData {
  authenticated: boolean
  sessionId: string | null
  userId: string | null
  authTimer: ReturnType<typeof setTimeout> | null
  heartbeatTimer: ReturnType<typeof setInterval> | null
  msgCount: number
  msgWindowStart: number
}

export function createChannelWsData(): ChannelWsData {
  return {
    authenticated: false,
    sessionId: null,
    userId: null,
    authTimer: null,
    heartbeatTimer: null,
    msgCount: 0,
    msgWindowStart: Date.now(),
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
  console.log('[channel] connection opened')
  // Require auth within 5 seconds
  data.authTimer = setTimeout(() => {
    if (!data.authenticated) {
      console.log('[channel] auth timeout, closing')
      ws.close(4000, 'auth timeout')
    }
  }, AUTH_TIMEOUT_MS)
}

export async function handleChannelMessage(ws: ServerWebSocket<ChannelWsData>, raw: string) {
  const data = ws.data

  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch (e: any) {
    console.error('[channel] JSON parse error:', e.message, '| raw:', raw.slice(0, 200))
    return
  }

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
    // Timing-safe comparison to prevent side-channel attacks (H1 fix)
    const a = Buffer.from(tokenHash, 'utf8')
    const b = Buffer.from(session.token_hash, 'utf8')
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      ws.send(JSON.stringify({ type: 'auth_error', error: 'invalid' }))
      ws.close(4001, 'auth failed')
      return
    }

    // Authenticated
    data.authenticated = true
    data.sessionId = session.id
    data.userId = session.user_id
    if (data.authTimer) clearTimeout(data.authTimer)

    console.log(`[channel] authenticated session=${session.id} user=${session.user_id}`)
    registerChannel(session.id, session.user_id, ws)
    await setSessionStatus(session.id, 'online')

    ws.send(JSON.stringify({ type: 'auth_ok' }))

    // Broadcast status to subscribed clients
    broadcastToSubscribers(session.id, {
      type: 'session_status',
      session_id: session.id,
      status: 'online',
    })

    // Push updated session list to all browser clients for this user
    // (handles new sessions the client hasn't seen yet)
    pushSessionList(session.user_id)

    // Start heartbeat
    data.heartbeatTimer = setInterval(() => {
      try { ws.send(JSON.stringify({ type: 'ping' })) } catch {}
    }, HEARTBEAT_INTERVAL_MS)

    return
  }

  if (!data.authenticated || !data.sessionId) return

  // Per-connection message rate limiting
  const now = Date.now()
  if (now - data.msgWindowStart > MSG_RATE_WINDOW_MS) {
    data.msgCount = 0
    data.msgWindowStart = now
  }
  data.msgCount++
  if (data.msgCount > MSG_RATE_MAX) return // silently drop

  if (msg.type === 'assistant_message') {
    console.log(`[channel] assistant_message session=${data.sessionId} len=${msg.content.length}`)
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
  console.log(`[channel] closed session=${data.sessionId}`)
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
    // Push updated session list to user's browser clients
    if (data.userId) pushSessionList(data.userId)
  }
}

// Fetch and broadcast the full session list to all browser clients for a user
async function pushSessionList(userId: string) {
  try {
    const { data, error } = await supabaseAdmin
      .from('sessions')
      .select('id, name, project_dir, status, last_activity, created_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
    if (!error && data) {
      broadcastToUser(userId, { type: 'session_list', sessions: data })
    }
  } catch {}
}
