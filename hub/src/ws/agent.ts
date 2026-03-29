import type { ServerWebSocket } from 'bun'
import { AgentInbound } from './agent-protocol'
import { verifyApiKey, findOrCreateAgentSession, setSessionStatus, insertMessage } from '../db/dal'
import { hashToken } from './channel'
import { generateToken } from '../utils/token'
import { registerChannel, unregisterChannel, getChannel, broadcastToSubscribers, broadcastToUser } from './registry'
import { supabaseAdmin } from '../db/supabase'

const AUTH_TIMEOUT_MS = 5_000
const HEARTBEAT_INTERVAL_MS = 30_000
const RATE_LIMIT = { max: 120, windowMs: 10_000 }

export interface AgentWsData {
  authenticated: boolean
  sessionId: string | null
  userId: string | null
  authTimer: ReturnType<typeof setTimeout> | null
  heartbeatTimer: ReturnType<typeof setInterval> | null
  messageCount: number
  windowStart: number
}

export function createAgentWsData(): AgentWsData {
  return {
    authenticated: false,
    sessionId: null,
    userId: null,
    authTimer: null,
    heartbeatTimer: null,
    messageCount: 0,
    windowStart: Date.now(),
  }
}

export function handleAgentOpen(ws: ServerWebSocket<AgentWsData>) {
  console.log('[agent] connection opened')
  ws.data.authTimer = setTimeout(() => {
    if (!ws.data.authenticated) {
      console.log('[agent] auth timeout, closing')
      ws.close(4000, 'auth timeout')
    }
  }, AUTH_TIMEOUT_MS)
}

export async function handleAgentMessage(ws: ServerWebSocket<AgentWsData>, raw: string) {
  // Rate limiting
  const now = Date.now()
  if (now - ws.data.windowStart > RATE_LIMIT.windowMs) {
    ws.data.messageCount = 0
    ws.data.windowStart = now
  }
  if (++ws.data.messageCount > RATE_LIMIT.max) return

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (e: any) {
    console.error('[agent] JSON parse error:', e.message)
    return
  }

  const result = AgentInbound.safeParse(parsed)
  if (!result.success) return
  const msg = result.data

  // --- Auth ---
  if (msg.type === 'auth') {
    if (ws.data.authenticated) return

    // Hash the raw API key before verifying (same pattern as api-key-middleware)
    const keyHash = await hashToken(msg.api_key)
    const apiKeyRecord = await verifyApiKey(keyHash)
    if (!apiKeyRecord) {
      ws.send(JSON.stringify({ type: 'auth_error', error: 'invalid api key' }))
      ws.close(4001, 'auth failed')
      return
    }

    const userId = apiKeyRecord.user_id
    const projectDir = msg.project_dir.replace(/\\/g, '/')

    // Find existing session for this project or create a new one
    const rawToken = generateToken('remo_')
    const tokenHash = await hashToken(rawToken)
    const session = await findOrCreateAgentSession(userId, projectDir, tokenHash)

    // If reusing an existing session, unregister any stale channel entry
    // (don't close — the old WS may already be dead, and closing triggers
    // a reconnect loop if the agent is the same process reconnecting)
    if (!session.created) {
      unregisterChannel(session.id)
    }

    ws.data.authenticated = true
    ws.data.sessionId = session.id
    ws.data.userId = userId
    if (ws.data.authTimer) clearTimeout(ws.data.authTimer)

    console.log(`[agent] authenticated session=${session.id} user=${userId} project=${projectDir} reused=${!session.created}`)
    registerChannel(session.id, userId, ws as any)
    await setSessionStatus(session.id, 'online')

    ws.send(JSON.stringify({ type: 'auth_ok', session_id: session.id }))

    // Start heartbeat
    ws.data.heartbeatTimer = setInterval(() => {
      try { ws.send(JSON.stringify({ type: 'ping' })) } catch {}
    }, HEARTBEAT_INTERVAL_MS)

    // Notify browser clients of new session
    broadcastToUser(userId, { type: 'session_list', sessions: await listSessionsForUser(userId) })
    broadcastToSubscribers(session.id, {
      type: 'session_status',
      session_id: session.id,
      status: 'online',
    })
    return
  }

  if (!ws.data.authenticated || !ws.data.sessionId) return
  const { sessionId } = ws.data

  // --- Activity events: relay to subscribed browser clients ---
  if (msg.type === 'thinking' || msg.type === 'text_delta' || msg.type === 'tool_use' || msg.type === 'tool_result') {
    broadcastToSubscribers(sessionId, { ...msg })
  }

  // --- Status updates ---
  if (msg.type === 'status') {
    const dbStatus = msg.state === 'idle' ? 'online' : 'thinking'
    await setSessionStatus(sessionId, dbStatus as any)
    broadcastToSubscribers(sessionId, msg)
    broadcastToUser(ws.data.userId!, { type: 'session_status', session_id: sessionId, status: dbStatus })
  }

  // --- Final assistant message: persist and broadcast ---
  if (msg.type === 'assistant_message') {
    console.log(`[agent] assistant_message session=${sessionId} len=${msg.content.length}`)
    const message = await insertMessage(sessionId, 'assistant', msg.content)
    broadcastToSubscribers(sessionId, {
      type: 'message',
      session_id: sessionId,
      message,
    })
  }

  if (msg.type === 'pong') return // heartbeat response
}

export async function handleAgentClose(ws: ServerWebSocket<AgentWsData>) {
  console.log(`[agent] closed session=${ws.data.sessionId}`)
  if (ws.data.authTimer) clearTimeout(ws.data.authTimer)
  if (ws.data.heartbeatTimer) clearInterval(ws.data.heartbeatTimer)

  if (ws.data.sessionId) {
    unregisterChannel(ws.data.sessionId)
    await setSessionStatus(ws.data.sessionId, 'offline')

    broadcastToSubscribers(ws.data.sessionId, {
      type: 'session_status',
      session_id: ws.data.sessionId,
      status: 'offline',
    })

    if (ws.data.userId) {
      broadcastToUser(ws.data.userId, {
        type: 'session_status',
        session_id: ws.data.sessionId,
        status: 'offline',
      })
      // Push updated session list to user's browser clients
      broadcastToUser(ws.data.userId, {
        type: 'session_list',
        sessions: await listSessionsForUser(ws.data.userId),
      })
    }
  }
}

// Helper: list sessions using admin client (no JWT needed)
async function listSessionsForUser(userId: string) {
  const { data } = await supabaseAdmin
    .from('sessions')
    .select('id, name, project_dir, status, last_activity, created_at')
    .eq('user_id', userId)
    .order('last_activity', { ascending: false, nullsFirst: false })
  return data || []
}
