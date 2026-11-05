/**
 * /api/chat — Bearer-key chat surface (scope `chat:session`, see auth/chat-api-key.ts).
 *
 * Mirrors what /ws/client does for a browser, for a server holding an api key: list the
 * owner's sessions, read history, send a message, cancel, answer permission / question
 * prompts, and stream the session's events over SSE. Every session id is ownership-checked
 * (`getSession(id, userId)`, 404 otherwise). The send path is the same as the WS
 * `send_message` handler (ws/client.ts): dedupe, license, threshold, scheduled-run fence,
 * insert + broadcast, `user_message` to the agent channel. On top of that, because the actor
 * is automation (`external-chat`, server-inferred): daily cost + token caps, and a
 * pty-interactive session is refused (never driven by an automation actor).
 */
import { Hono } from 'hono'
import { z } from 'zod'
import { config } from '../config.ts'
import { getSession, insertMessage, getUserLicenseFields, updateSessionStatus } from '../db/dal.ts'
import { getMessagesForSessions } from '../db/chat-tabs-dal.ts'
import { listSessionsForUserEnriched } from '../sessions/enrich.ts'
import { humanOnlyRejectsActor, thresholdGate, dailyCostCapGate, dailyTokenCapGate } from '../dispatch/gates.ts'
import type { DispatchGate } from '../dispatch/pipeline.ts'
import { isScheduledRunActive } from '../scheduler/senders/agent.ts'
import { checkDuplicate, recordSend } from '../ws/send-dedupe.ts'
import { getChannel, unregisterChannel, broadcastToSubscribers, tapSessionEvents } from '../ws/registry.ts'
import { CHAT_ACTOR } from '../auth/chat-api-key.ts'

export const chat = new Hono()

const MESSAGES_DEFAULT_LIMIT = 50
const MESSAGES_MAX_LIMIT = 200
const HEARTBEAT_MS = 15_000

/** Same bounds as ClientSendMessage in ws/protocol.ts. */
const SendBody = z.object({
  content: z.string().trim().min(1).max(1_000_000),
  id: z.string().uuid().optional(),
  images: z.array(z.object({
    media_type: z.string(),
    data: z.string().max(10_000_000),
  })).max(5).optional(),
})
const PermissionBody = z.object({ request_id: z.string().min(1).max(256), approved: z.boolean() })
const QuestionBody = z.object({ request_id: z.string().min(1).max(256), answer: z.string().max(100_000) })

const SPEND_GATES: DispatchGate[] = [thresholdGate, dailyCostCapGate, dailyTokenCapGate]

/** Case-insensitive, separator- and trailing-slash-insensitive path key. */
export function normalizeProjectDir(p: string): string {
  return p.trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

/** Mirrors ws/client.ts isLicenseActive, fail-closed (no cached connection state here). */
async function licenseActive(userId: string): Promise<boolean> {
  if (config.titaniumBypass || !config.licenseRequired) return true
  try {
    const f = await getUserLicenseFields(userId)
    return (f?.license_status ?? 'NONE').toLowerCase() === 'active'
  } catch {
    return false
  }
}

async function ownedSession(c: any) {
  const userId = c.get('userId') as string
  return { userId, session: await getSession(c.req.param('id'), userId) }
}

chat.get('/sessions', async (c) => {
  const userId = c.get('userId') as string
  const dir = c.req.query('project_dir')
  const rows = await listSessionsForUserEnriched(userId)
  const want = dir ? normalizeProjectDir(dir) : null
  const out = (rows as any[])
    .filter((s) => want === null || (s.project_dir != null && normalizeProjectDir(String(s.project_dir)) === want))
    .map((s) => ({
      id: s.id,
      name: s.name,
      status: s.status,
      project_dir: s.project_dir ?? null,
      online: getChannel(s.id) != null,
    }))
  return c.json({ sessions: out })
})

chat.get('/sessions/:id/messages', async (c) => {
  const { userId, session } = await ownedSession(c)
  if (!session) return c.json({ error: 'not_found' }, 404)
  let limit = MESSAGES_DEFAULT_LIMIT
  const lp = c.req.query('limit')
  if (lp !== undefined) {
    const n = Number(lp)
    if (!Number.isInteger(n) || n < 1) return c.json({ error: 'invalid_limit' }, 400)
    limit = Math.min(n, MESSAGES_MAX_LIMIT)
  }
  const grouped = await getMessagesForSessions(userId, [session.id], limit)
  return c.json({ messages: grouped[session.id] ?? [] })
})

chat.post('/sessions/:id/messages', async (c) => {
  const { userId, session } = await ownedSession(c)
  if (!session) return c.json({ error: 'not_found' }, 404)
  const parsed = SendBody.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: 'invalid_input', detail: parsed.error.issues[0]?.message }, 400)
  const body = parsed.data
  const sessionId = session.id as string
  const clientId = body.id ?? crypto.randomUUID()

  if (!(await licenseActive(userId))) {
    broadcastToSubscribers(sessionId, { type: 'send_refused', client_id: clientId, session_id: sessionId, reason: 'license_inactive' })
    return c.json({ error: 'license_required', reason: 'license_inactive' }, 402)
  }

  const replayed = checkDuplicate(sessionId, clientId)
  if (replayed) return c.json({ id: (replayed as any).message_id, client_id: clientId, duplicate: true }, 202)

  // Automation never drives a human's pty-interactive session (same decision the PTY relay uses).
  const runnerType = String((session as any).runner_type ?? 'stream-json')
  if (humanOnlyRejectsActor(CHAT_ACTOR, runnerType)) {
    const reason = `automation_blocked_on_pty:${CHAT_ACTOR}`
    broadcastToSubscribers(sessionId, { type: 'send_refused', client_id: clientId, session_id: sessionId, error: 'automation_blocked_on_pty', reason })
    return c.json({ error: 'send_refused', reason }, 409)
  }

  const cloudSessionId: string | null = (session as any).cloud_session_id ?? null
  if (cloudSessionId) return c.json({ error: 'send_refused', reason: 'cloud_session_unsupported' }, 409)

  for (const gate of SPEND_GATES) {
    const r = await gate.check({ userId, sessionId, token: `chat:${clientId}`, prompt: body.content })
    if (!r.ok) {
      broadcastToSubscribers(sessionId, { type: 'send_refused', client_id: clientId, session_id: sessionId, error: gate.name, reason: r.reason })
      return c.json({ error: 'send_refused', reason: r.reason }, 429)
    }
  }

  if (isScheduledRunActive(sessionId)) {
    broadcastToSubscribers(sessionId, { type: 'send_refused', client_id: clientId, session_id: sessionId, reason: 'scheduled_run_active' })
    return c.json({ error: 'send_refused', reason: 'scheduled_run_active' }, 409)
  }

  let stored = body.content
  if (body.images?.length) {
    const md = body.images.map((img, i) => `![image-${i + 1}](data:${img.media_type};base64,${img.data})`).join('\n')
    stored = md + '\n\n' + stored
  }
  const message = await insertMessage(sessionId, 'user', stored)
  recordSend(sessionId, clientId, { type: 'send_ack', client_id: clientId, session_id: sessionId, message_id: message.id } as any)
  broadcastToSubscribers(sessionId, { type: 'message', session_id: sessionId, message })

  const channel = getChannel(sessionId)
  const readyState = channel ? (channel.ws as any).readyState : undefined
  const refuse = (reason: string) => {
    broadcastToSubscribers(sessionId, { type: 'session_status', session_id: sessionId, status: 'offline' })
    broadcastToSubscribers(sessionId, { type: 'send_refused', client_id: clientId, session_id: sessionId, error: 'session_offline', reason })
    return c.json({ error: 'send_refused', reason: 'session_offline', id: message.id }, 409)
  }
  if (!channel || readyState !== 1) {
    if (channel) unregisterChannel(sessionId)
    return refuse('No live runner is attached to this session.')
  }
  const payload: Record<string, unknown> = { type: 'user_message', id: message.id, content: body.content, ts: message.created_at }
  if (body.images) payload.images = body.images
  if (channel.ws.send(JSON.stringify(payload)) === -1) {
    unregisterChannel(sessionId)
    return refuse('Send to runner failed (socket closed mid-send).')
  }
  try { await updateSessionStatus(sessionId, 'thinking') } catch {}
  return c.json({ id: message.id, client_id: clientId }, 202)
})

chat.post('/sessions/:id/cancel', async (c) => {
  const { session } = await ownedSession(c)
  if (!session) return c.json({ error: 'not_found' }, 404)
  const channel = getChannel(session.id)
  if (!channel || (channel.ws as any).readyState !== 1) return c.json({ error: 'session_offline' }, 409)
  channel.ws.send(JSON.stringify({ type: 'cancel', session_id: session.id }))
  return c.json({ ok: true }, 202)
})

async function forwardPrompt(c: any, kind: 'permission_response' | 'question_response') {
  const { session } = await ownedSession(c)
  if (!session) return c.json({ error: 'not_found' }, 404)
  const raw = await c.req.json().catch(() => null)
  const parsed = (kind === 'permission_response' ? PermissionBody : QuestionBody).safeParse(raw)
  if (!parsed.success) return c.json({ error: 'invalid_input', detail: parsed.error.issues[0]?.message }, 400)
  if (!(await licenseActive(c.get('userId')))) return c.json({ error: 'license_required', reason: 'license_inactive' }, 402)
  const channel = getChannel(session.id)
  if (!channel || (channel.ws as any).readyState !== 1) return c.json({ error: 'session_offline' }, 409)
  channel.ws.send(JSON.stringify({ type: kind, session_id: session.id, ...parsed.data }))
  try {
    const { clearPromptPending } = await import('../ws/pending-prompts.ts')
    clearPromptPending(session.id, (parsed.data as any).request_id)
  } catch {}
  return c.json({ ok: true }, 202)
}
chat.post('/sessions/:id/permission', (c) => forwardPrompt(c, 'permission_response'))
chat.post('/sessions/:id/question', (c) => forwardPrompt(c, 'question_response'))

chat.get('/sessions/:id/events', async (c) => {
  const { session } = await ownedSession(c)
  if (!session) return c.json({ error: 'not_found' }, 404)
  const sessionId = session.id as string
  const enc = new TextEncoder()
  let cleanup = () => {}
  const stream = new ReadableStream<Uint8Array>({
    start(ctrl) {
      let closed = false
      const send = (s: string) => { if (!closed) { try { ctrl.enqueue(enc.encode(s)) } catch { cleanup() } } }
      const untap = tapSessionEvents(sessionId, (json) => send(`data: ${json}\n\n`))
      const hb = setInterval(() => send(': hb\n\n'), HEARTBEAT_MS)
      cleanup = () => {
        if (closed) return
        closed = true
        clearInterval(hb)
        untap()
        try { ctrl.close() } catch {}
      }
      c.req.raw.signal.addEventListener('abort', cleanup)
      send(': connected\n\n')
    },
    cancel() { cleanup() },
  })
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  })
})
