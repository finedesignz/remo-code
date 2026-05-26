import type { ServerWebSocket } from 'bun'
import { ClientInbound, SUBSCRIBE_MAX } from './protocol'
import { verifyJwt } from '../auth/jwt.ts'
import { insertMessage, listSessions, getSession } from '../db/dal'
import {
  registerClient, unregisterClient, subscribeClient,
  getChannel, unregisterChannel, broadcastToSubscribers,
  broadcastErrorEvent,
  type ClientEntry,
} from './registry'

// Re-export so error-capture modules can `import { broadcastErrorEvent }
// from '../ws/client'` per the W3 contract.
export { broadcastErrorEvent }

const AUTH_TIMEOUT_MS = 5_000
const MSG_RATE_WINDOW_MS = 10_000
const MSG_RATE_MAX = 30 // max 30 messages per 10 seconds

interface ClientWsData {
  authenticated: boolean
  userId: string | null
  clientEntry: ClientEntry | null
  authTimer: ReturnType<typeof setTimeout> | null
  msgCount: number
  msgWindowStart: number
}

export function createClientWsData(): ClientWsData {
  return {
    authenticated: false,
    userId: null,
    clientEntry: null,
    authTimer: null,
    msgCount: 0,
    msgWindowStart: Date.now(),
  }
}

export function handleClientOpen(ws: ServerWebSocket<ClientWsData>) {
  ws.data.authTimer = setTimeout(() => {
    if (!ws.data.authenticated) {
      ws.close(4000, 'auth timeout')
    }
  }, AUTH_TIMEOUT_MS)
}

export async function handleClientMessage(ws: ServerWebSocket<ClientWsData>, raw: string) {
  const data = ws.data

  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch (e: any) {
    console.error('[client] JSON parse error:', e.message)
    return
  }

  const result = ClientInbound.safeParse(parsed)
  if (!result.success) return

  const msg = result.data

  if (msg.type === 'auth') {
    if (data.authenticated) return

    try {
      const payload = verifyJwt(msg.token)
      data.userId = payload.sub
      data.authenticated = true
    } catch {
      ws.close(4001, 'Unauthorized')
      return
    }

    if (data.authTimer) clearTimeout(data.authTimer)

    data.clientEntry = registerClient(data.userId!, ws)
    console.log(`[client] authenticated user=${data.userId}`)
    ws.send(JSON.stringify({ type: 'auth_ok' }))

    // Send session list immediately
    const sessions = await listSessions(data.userId!)
    ws.send(JSON.stringify({ type: 'session_list', sessions }))

    // Phase 06: send current subscription usage snapshot if any agent has
    // reported one (skipped silently when no agent has connected yet).
    try {
      const { getUsage } = await import('../usage/store')
      const snap = getUsage(data.userId!)
      if (snap) {
        ws.send(JSON.stringify({
          type: 'subscription_usage',
          usage: snap.usage,
          updated_at: snap.updated_at,
        }))
      }
    } catch {}
    return
  }

  if (!data.authenticated || !data.userId || !data.clientEntry) return

  // Per-connection message rate limiting
  const now = Date.now()
  if (now - data.msgWindowStart > MSG_RATE_WINDOW_MS) {
    data.msgCount = 0
    data.msgWindowStart = now
  }
  data.msgCount++
  if (data.msgCount > MSG_RATE_MAX) return // silently drop

  if (msg.type === 'subscribe') {
    // Overloaded: accept legacy `session_id` (singular) OR `session_ids` (multi).
    // Empty `session_ids: []` clears subscriptions. The set REPLACES on every
    // subscribe call (last-write-wins) — clients send the full active set.
    const requested: string[] = msg.session_id
      ? [msg.session_id]
      : (msg.session_ids ?? [])
    // De-dupe up-front so a client that repeats an id doesn't waste DAL calls.
    const ids = Array.from(new Set(requested))

    if (ids.length > SUBSCRIBE_MAX) {
      ws.send(JSON.stringify({
        type: 'subscribe_error',
        error: 'too_many_sessions',
        max: SUBSCRIBE_MAX,
      }))
      return
    }

    if (ids.length === 0) {
      subscribeClient(data.clientEntry, [])
      return
    }

    // Verify EVERY id belongs to the authenticated user. If any id is foreign,
    // reject the whole call and leave the existing subscription set unchanged.
    const ownedChecks = await Promise.all(
      ids.map((id: string) => getSession(id, data.userId!))
    )
    const allOwned = ownedChecks.every((s) => s !== null)
    if (!allOwned) {
      ws.send(JSON.stringify({
        type: 'subscribe_error',
        error: 'invalid_subscribe',
      }))
      return
    }

    subscribeClient(data.clientEntry, ids)
    return
  }

  if (msg.type === 'permission_response') {
    console.log(`[client] permission_response session=${msg.session_id} req=${msg.request_id} approved=${msg.approved}`)
    // Verify ownership
    const session = await getSession(msg.session_id, data.userId!)
    if (!session) return

    // Forward to agent
    const channel = getChannel(msg.session_id)
    if (channel) {
      channel.ws.send(JSON.stringify({
        type: 'permission_response',
        session_id: msg.session_id,
        request_id: msg.request_id,
        approved: msg.approved,
      }))
    }
  }

  if (msg.type === 'question_response') {
    console.log(`[client] question_response session=${msg.session_id} req=${msg.request_id}`)
    // Verify ownership
    const session = await getSession(msg.session_id, data.userId!)
    if (!session) return

    // Forward to agent
    const channel = getChannel(msg.session_id)
    if (channel) {
      channel.ws.send(JSON.stringify({
        type: 'question_response',
        session_id: msg.session_id,
        request_id: msg.request_id,
        answer: msg.answer,
      }))
    }
  }

  if (msg.type === 'send_message') {
    console.log(`[client] send_message session=${msg.session_id} user=${data.userId}`)
    // Verify ownership
    const session = await getSession(msg.session_id, data.userId!)
    if (!session) {
      console.log(`[client] session not found or not owned: ${msg.session_id}`)
      return
    }

    // Embed images as markdown data URIs so they render in the chat history
    let storedContent = msg.content
    if (msg.images?.length) {
      const imgMarkdown = msg.images.map((img: any, i: number) =>
        `![image-${i + 1}](data:${img.media_type};base64,${img.data})`
      ).join('\n')
      storedContent = imgMarkdown + '\n\n' + storedContent
    }

    // Store the user message
    const message = await insertMessage(msg.session_id, 'user', storedContent)

    // ACK to the sender so the client can clear the message from its in-flight
    // queue. Without this, a half-open socket (readyState=OPEN but TCP dead)
    // would silently lose the message — the client would never retry on
    // reconnect because it believes the send succeeded.
    try {
      ws.send(JSON.stringify({
        type: 'send_ack',
        client_id: msg.id,
        session_id: msg.session_id,
        message_id: message.id,
      }))
    } catch {
      // socket closed mid-handle; client will resend on reconnect
    }

    // Broadcast to all subscribed clients (including sender for confirmation)
    broadcastToSubscribers(msg.session_id, {
      type: 'message',
      session_id: msg.session_id,
      message,
    })

    // Forward to channel or agent (Claude Code session)
    const channel = getChannel(msg.session_id)
    if (channel) {
      const forwardPayload: Record<string, unknown> = {
        type: 'user_message',
        id: message.id,
        content: msg.content,
        ts: message.created_at,
      }
      // Include images/attachments if present (used by agent connections)
      if (msg.images) forwardPayload.images = msg.images
      if (msg.attachments) forwardPayload.attachments = msg.attachments
      const sent = channel.ws.send(JSON.stringify(forwardPayload))
      if (sent === -1) {
        // Socket is closed/dead — clean up the stale registry entry
        console.log(`[client] channel send failed (socket dead), unregistering session=${msg.session_id}`)
        unregisterChannel(msg.session_id)
        broadcastToSubscribers(msg.session_id, { type: 'session_status', session_id: msg.session_id, status: 'offline' })
      } else {
        console.log(`[client] forwarding to channel session=${msg.session_id}`)
      }
    } else {
      console.log(`[client] no channel connected for session=${msg.session_id}`)
    }
  }
}

export function handleClientClose(ws: ServerWebSocket<ClientWsData>) {
  console.log(`[client] closed user=${ws.data.userId}`)
  if (ws.data.authTimer) clearTimeout(ws.data.authTimer)
  if (ws.data.clientEntry) {
    unregisterClient(ws.data.clientEntry)
  }
}
