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
import { getChannel, unregisterChannel, broadcastToSubscribers, tapSessionEvents } from '../ws/registry.ts'
import { CHAT_ACTOR } from '../auth/chat-api-key.ts'
import { verifyApiKeyForExt } from '../db/ask-dal.ts'
import { hasExplicitScope, SCOPE_CHAT_SESSION } from '../auth/scopes.ts'

export const chat = new Hono()

const MESSAGES_DEFAULT_LIMIT = 50
const MESSAGES_MAX_LIMIT = 200
const HEARTBEAT_MS = 15_000

/** Same bounds as ClientSendMessage in ws/protocol.ts. */
const SendBody = z.object({
  content: z.string().trim().min(1).max(1_000_000),
  id: z.string().uuid().optional(),
  images: z.array(z.object({
    media_type: z.string().regex(/^image\/[\w.+-]+$/),
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

// Idempotency ledger for POST .../messages. The id is RESERVED synchronously (no await between
// the check and the set) so two concurrent POSTs with the same id cannot both dispatch.
// States: 'pending' (dispatch in flight) | 'delivered'. A refused / failed dispatch RELEASES the
// reservation, so a retry with the same id re-sends; a delivered id is only ever replayed.
const DEDUPE_TTL_MS = 5 * 60_000
const DEDUPE_MAX = 5000
const sendLedger = new Map<string, { state: 'pending' | 'delivered'; messageId: string | null; expiresAt: number }>()

function ledgerKey(sessionId: string, id: string) { return `${sessionId}\u0000${id}` }
function ledgerSweep(now: number) {
  for (const [k, v] of sendLedger) { if (v.expiresAt <= now) sendLedger.delete(k) }
  while (sendLedger.size > DEDUPE_MAX) {
    const first = sendLedger.keys().next()
    if (first.done) break
    sendLedger.delete(first.value)
  }
}
export function __resetChatSendLedgerForTests() { sendLedger.clear() }

/** Max raw request body (5 x 10MB base64 images + 1MB text, plus JSON overhead). */
export const MAX_SEND_BODY_CHARS = 52_000_000

chat.post('/sessions/:id/messages', async (c) => {
  const { userId, session } = await ownedSession(c)
  if (!session) return c.json({ error: 'not_found' }, 404)
  const declared = Number(c.req.header('content-length') ?? '0')
  if (declared > MAX_SEND_BODY_CHARS) return c.json({ error: 'payload_too_large' }, 413)
  const rawText = await c.req.text().catch(() => '')
  if (rawText.length > MAX_SEND_BODY_CHARS) return c.json({ error: 'payload_too_large' }, 413)
  let json: unknown = null
  try { json = JSON.parse(rawText) } catch {}
  const parsed = SendBody.safeParse(json)
  if (!parsed.success) return c.json({ error: 'invalid_input', detail: parsed.error.issues[0]?.message }, 400)
  const body = parsed.data
  const sessionId = session.id as string
  const clientId = body.id ?? crypto.randomUUID()

  // Atomic reserve: nothing awaits between the lookup and the set.
  const now = Date.now()
  ledgerSweep(now)
  const lk = ledgerKey(sessionId, clientId)
  const existing = sendLedger.get(lk)
  if (existing) return c.json({ id: existing.messageId, client_id: clientId, duplicate: true }, 202)
  const reservation = { state: 'pending' as const, messageId: null as string | null, expiresAt: now + DEDUPE_TTL_MS }
  sendLedger.set(lk, reservation)

  let res: Response
  try {
    res = await dispatchSend(c, userId, session, sessionId, clientId, body, (id) => { reservation.messageId = id })
  } catch (err) {
    sendLedger.delete(lk)
    throw err
  }
  if (res.status === 202) sendLedger.set(lk, { state: 'delivered', messageId: reservation.messageId, expiresAt: Date.now() + DEDUPE_TTL_MS })
  else sendLedger.delete(lk) // refused: release so a retry with the same id re-sends
  return res
})

async function dispatchSend(
  c: any, userId: string, session: any, sessionId: string, clientId: string,
  body: z.infer<typeof SendBody>, noteMessageId: (id: string) => void,
): Promise<Response> {
  if (!(await licenseActive(userId))) {
    broadcastToSubscribers(sessionId, { type: 'send_refused', client_id: clientId, session_id: sessionId, reason: 'license_inactive' })
    return c.json({ error: 'license_required', reason: 'license_inactive' }, 402)
  }

  // Automation never drives a human's pty-interactive session (same decision the PTY relay uses).
  const runnerType = String(session.runner_type ?? 'stream-json')
  if (humanOnlyRejectsActor(CHAT_ACTOR, runnerType)) {
    const reason = `automation_blocked_on_pty:${CHAT_ACTOR}`
    broadcastToSubscribers(sessionId, { type: 'send_refused', client_id: clientId, session_id: sessionId, error: 'automation_blocked_on_pty', reason })
    return c.json({ error: 'send_refused', reason }, 409)
  }

  if (session.cloud_session_id) return c.json({ error: 'send_refused', reason: 'cloud_session_unsupported' }, 409)

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

  // Liveness BEFORE persisting: an offline session must not leave a user message row behind
  // (a same-id retry would otherwise store it twice).
  const offline = (reason: string, id?: string) => {
    broadcastToSubscribers(sessionId, { type: 'session_status', session_id: sessionId, status: 'offline' })
    broadcastToSubscribers(sessionId, { type: 'send_refused', client_id: clientId, session_id: sessionId, error: 'session_offline', reason })
    return c.json({ error: 'send_refused', reason: 'session_offline', ...(id ? { id } : {}) }, 409)
  }
  const channel0 = getChannel(sessionId)
  if (!channel0 || (channel0.ws as any).readyState !== 1) {
    if (channel0) unregisterChannel(sessionId)
    return offline('No live runner is attached to this session.')
  }

  let stored = body.content
  if (body.images?.length) {
    const md = body.images.map((img, i) => `![image-${i + 1}](data:${img.media_type};base64,${img.data})`).join('\n')
    stored = md + '\n\n' + stored
  }
  const message = await insertMessage(sessionId, 'user', stored)
  noteMessageId(message.id)
  broadcastToSubscribers(sessionId, { type: 'message', session_id: sessionId, message })

  // Re-resolve at send time: the channel may have changed across the insert await.
  const channel = getChannel(sessionId)
  if (!channel || (channel.ws as any).readyState !== 1) {
    if (channel) unregisterChannel(sessionId)
    return offline('Session went offline before delivery.', message.id)
  }
  const payload: Record<string, unknown> = { type: 'user_message', id: message.id, content: body.content, ts: message.created_at }
  if (body.images) payload.images = body.images
  if (channel.ws.send(JSON.stringify(payload)) === -1) {
    unregisterChannel(sessionId)
    return offline('Send to runner failed (socket closed mid-send).', message.id)
  }
  try { await updateSessionStatus(sessionId, 'thinking') } catch {}
  return c.json({ id: message.id, client_id: clientId }, 202)
}

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

/** SSE limits. Mutable so tests can shrink them. */
export const chatSseConfig = {
  heartbeatMs: HEARTBEAT_MS,
  maxLifetimeMs: 30 * 60_000,
  maxStreamsPerKey: 4,
  queueMax: 256,
}
const streamsPerKey = new Map<string, number>()
export function __chatStreamCountForTests(keyId: string) { return streamsPerKey.get(keyId) ?? 0 }

chat.get('/sessions/:id/events', async (c) => {
  const { session } = await ownedSession(c)
  if (!session) return c.json({ error: 'not_found' }, 404)
  const sessionId = session.id as string
  const keyId = (c.get('apiKeyId') as string | undefined) ?? 'unknown'
  const keyHash = c.get('apiKeyHash') as string | undefined
  if ((streamsPerKey.get(keyId) ?? 0) >= chatSseConfig.maxStreamsPerKey) {
    return c.json({ error: 'too_many_streams', max: chatSseConfig.maxStreamsPerKey }, 429)
  }
  streamsPerKey.set(keyId, (streamsPerKey.get(keyId) ?? 0) + 1)
  const enc = new TextEncoder()
  let cleanup = () => {}
  const stream = new ReadableStream<Uint8Array>({
    start(ctrl) {
      let closed = false
      cleanup = () => {
        if (closed) return
        closed = true
        clearInterval(hb)
        clearTimeout(life)
        untap()
        const n = (streamsPerKey.get(keyId) ?? 1) - 1
        if (n > 0) streamsPerKey.set(keyId, n)
        else streamsPerKey.delete(keyId)
        try { ctrl.close() } catch {}
      }
      // Backpressure: a consumer that stops reading is dropped (it refetches /messages on reconnect).
      const send = (s: string) => {
        if (closed) return
        if (ctrl.desiredSize !== null && ctrl.desiredSize <= 0) { cleanup(); return }
        try { ctrl.enqueue(enc.encode(s)) } catch { cleanup() }
      }
      const untap = tapSessionEvents(sessionId, (json) => send(`data: ${json}\n\n`))
      // Heartbeat doubles as a revocation check: re-verify the key, close on revoked/demoted/lookup error.
      const hb = setInterval(async () => {
        if (closed) return
        if (keyHash) {
          let ok = false
          try {
            const k = await verifyApiKeyForExt(keyHash)
            ok = !!k && hasExplicitScope(k.scopes, SCOPE_CHAT_SESSION)
          } catch { ok = false }
          if (!ok) { cleanup(); return }
        }
        send(': hb\n\n')
      }, chatSseConfig.heartbeatMs)
      const life = setTimeout(cleanup, chatSseConfig.maxLifetimeMs)
      c.req.raw.signal.addEventListener('abort', cleanup)
      send(': connected\n\n')
    },
    cancel() { cleanup() },
  }, new CountQueuingStrategy({ highWaterMark: chatSseConfig.queueMax }))
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  })
})
