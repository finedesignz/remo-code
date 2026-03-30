import type { ServerWebSocket } from 'bun'
import { ClientInbound } from './protocol'
import { supabaseAdmin } from '../db/supabase'
import { insertMessage, listSessions } from '../db/dal'
import { supabaseForUser } from '../db/supabase'
import {
  registerClient, unregisterClient, subscribeClient,
  getChannel, broadcastToSubscribers,
  type ClientEntry,
} from './registry'

const AUTH_TIMEOUT_MS = 5_000
const MSG_RATE_WINDOW_MS = 10_000
const MSG_RATE_MAX = 30 // max 30 messages per 10 seconds

interface ClientWsData {
  authenticated: boolean
  userId: string | null
  jwt: string | null
  clientEntry: ClientEntry | null
  authTimer: ReturnType<typeof setTimeout> | null
  msgCount: number
  msgWindowStart: number
}

export function createClientWsData(): ClientWsData {
  return {
    authenticated: false,
    userId: null,
    jwt: null,
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

    const { data: { user }, error } = await supabaseAdmin.auth.getUser(msg.token)
    if (error || !user) {
      ws.send(JSON.stringify({ type: 'auth_error', error: 'invalid' }))
      ws.close(4001, 'auth failed')
      return
    }

    data.authenticated = true
    data.userId = user.id
    data.jwt = msg.token
    if (data.authTimer) clearTimeout(data.authTimer)

    data.clientEntry = registerClient(user.id, ws)
    console.log(`[client] authenticated user=${user.id}`)
    ws.send(JSON.stringify({ type: 'auth_ok' }))

    // Send session list immediately
    const sb = supabaseForUser(msg.token)
    const sessions = await listSessions(sb)
    ws.send(JSON.stringify({ type: 'session_list', sessions }))
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
    // Verify user owns these sessions before subscribing
    const sb = supabaseForUser(data.jwt!)
    const { data: ownedSessions } = await sb
      .from('sessions')
      .select('id')
      .in('id', msg.session_ids)
    const ownedIds = (ownedSessions || []).map((s: any) => s.id)
    subscribeClient(data.clientEntry, ownedIds)
  }

  if (msg.type === 'permission_response') {
    console.log(`[client] permission_response session=${msg.session_id} req=${msg.request_id} approved=${msg.approved}`)
    // Verify ownership
    const sb = supabaseForUser(data.jwt!)
    const { data: session } = await sb
      .from('sessions')
      .select('id')
      .eq('id', msg.session_id)
      .single()
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

  if (msg.type === 'send_message') {
    console.log(`[client] send_message session=${msg.session_id} user=${data.userId}`)
    // Verify ownership via RLS
    const sb = supabaseForUser(data.jwt!)
    const { data: session } = await sb
      .from('sessions')
      .select('id')
      .eq('id', msg.session_id)
      .single()

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

    // Broadcast to all subscribed clients (including sender for confirmation)
    broadcastToSubscribers(msg.session_id, {
      type: 'message',
      session_id: msg.session_id,
      message,
    })

    // Forward to channel or agent (Claude Code session)
    const channel = getChannel(msg.session_id)
    if (channel) {
      console.log(`[client] forwarding to channel session=${msg.session_id}`)
      const forwardPayload: Record<string, unknown> = {
        type: 'user_message',
        id: message.id,
        content: msg.content,
        ts: message.created_at,
      }
      // Include images/attachments if present (used by agent connections)
      if (msg.images) forwardPayload.images = msg.images
      if (msg.attachments) forwardPayload.attachments = msg.attachments
      channel.ws.send(JSON.stringify(forwardPayload))
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
