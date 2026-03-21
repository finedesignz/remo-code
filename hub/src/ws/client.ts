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

interface ClientWsData {
  authenticated: boolean
  userId: string | null
  jwt: string | null
  clientEntry: ClientEntry | null
  authTimer: ReturnType<typeof setTimeout> | null
}

export function createClientWsData(): ClientWsData {
  return {
    authenticated: false,
    userId: null,
    jwt: null,
    clientEntry: null,
    authTimer: null,
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
  try { parsed = JSON.parse(raw) } catch { return }

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
    ws.send(JSON.stringify({ type: 'auth_ok' }))

    // Send session list immediately
    const sb = supabaseForUser(msg.token)
    const sessions = await listSessions(sb)
    ws.send(JSON.stringify({ type: 'session_list', sessions }))
    return
  }

  if (!data.authenticated || !data.userId || !data.clientEntry) return

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

  if (msg.type === 'send_message') {
    // Verify ownership via RLS
    const sb = supabaseForUser(data.jwt!)
    const { data: session } = await sb
      .from('sessions')
      .select('id')
      .eq('id', msg.session_id)
      .single()

    if (!session) return // silently drop — session not found or not owned

    // Store the user message
    const message = await insertMessage(msg.session_id, 'user', msg.content)

    // Broadcast to all subscribed clients (including sender for confirmation)
    broadcastToSubscribers(msg.session_id, {
      type: 'message',
      session_id: msg.session_id,
      message,
    })

    // Forward to channel (Claude Code session)
    const channel = getChannel(msg.session_id)
    if (channel) {
      channel.ws.send(JSON.stringify({
        type: 'user_message',
        id: message.id,
        content: msg.content,
        ts: message.created_at,
      }))
    }
  }
}

export function handleClientClose(ws: ServerWebSocket<ClientWsData>) {
  if (ws.data.authTimer) clearTimeout(ws.data.authTimer)
  if (ws.data.clientEntry) {
    unregisterClient(ws.data.clientEntry)
  }
}
