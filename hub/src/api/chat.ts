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
// the lookup and the set). States:
//   pending   dispatch in flight; a concurrent duplicate AWAITS this entry's promise and gets the
//             same outcome (success -> 202 duplicate:true, refusal -> the same refusal)
//   delivered the runner accepted the frame; replays return 202 duplicate:true
//   failed    the message row was persisted but delivery failed; a retry with the same id REUSES the
//             persisted row (never inserts a second copy) and re-dispatches
// A refusal before persistence deletes the entry. Pending entries are never swept or evicted, and a
// finishing dispatch only touches the entry it still owns (token compare).
const DEDUPE_TTL_MS = 5 * 60_000
const DEDUPE_MAX = 5000

type SendResult = { status: number; body: Record<string, unknown> }
interface LedgerEntry {
  token: symbol
  state: 'pending' | 'delivered' | 'failed'
  message: any | null
  promise: Promise<SendResult> | null
  expiresAt: number
}
const sendLedger = new Map<string, LedgerEntry>()

function ledgerKey(sessionId: string, id: string) { return `${sessionId}\u0000${id}` }
function ledgerSweep(now: number) {
  for (const [k, v] of sendLedger) { if (v.state !== 'pending' && v.expiresAt <= now) sendLedger.delete(k) }
  if (sendLedger.size > DEDUPE_MAX) {
    for (const [k, v] of sendLedger) {
      if (sendLedger.size <= DEDUPE_MAX) break
      if (v.state !== 'pending') sendLedger.delete(k)
    }
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

  // Atomic section: no await between the lookup and the set.
  const now = Date.now()
  ledgerSweep(now)
  const lk = ledgerKey(sessionId, clientId)
  const existing = sendLedger.get(lk)
  let reuse: any | null = null
  if (existing) {
    if (existing.state === 'pending') {
      const r = await existing.promise!
      return r.status === 202
        ? c.json({ ...r.body, duplicate: true }, 202)
        : c.json(r.body, r.status as any)
    }
    if (existing.state === 'delivered') {
      return c.json({ id: existing.message?.id ?? null, client_id: clientId, duplicate: true }, 202)
    }
    reuse = existing.message // 'failed': reuse the persisted row
  }
  const entry: LedgerEntry = { token: Symbol('send'), state: 'pending', message: reuse, promise: null, expiresAt: now + DEDUPE_TTL_MS }
  entry.promise = dispatchSend(userId, session, sessionId, clientId, body, reuse, (m) => { entry.message = m })
  sendLedger.set(lk, entry)

  let result: SendResult
  try {
    result = await entry.promise
  } catch (err) {
    if (sendLedger.get(lk)?.token === entry.token) {
      if (entry.message) { entry.state = 'failed'; entry.promise = null } else sendLedger.delete(lk)
    }
    throw err
  }
  if (sendLedger.get(lk)?.token === entry.token) {
    entry.expiresAt = Date.now() + DEDUPE_TTL_MS
    if (result.status === 202) { entry.state = 'delivered'; entry.promise = null }
    else if (entry.message) { entry.state = 'failed'; entry.promise = null }
    else sendLedger.delete(lk)
  }
  return c.json(result.body, result.status as any)
})

async function dispatchSend(
  userId: string, session: any, sessionId: string, clientId: string,
  body: z.infer<typeof SendBody>, reuse: any | null, notePersisted: (m: any) => void,
): Promise<SendResult> {
  const refuse = (status: number, b: Record<string, unknown>): SendResult => ({ status, body: b })

  if (!(await licenseActive(userId))) {
    broadcastToSubscribers(sessionId, { type: 'send_refused', client_id: clientId, session_id: sessionId, reason: 'license_inactive' })
    return refuse(402, { error: 'license_required', reason: 'license_inactive' })
  }

  // Automation never drives a human's pty-interactive session (same decision the PTY relay uses).
  const runnerType = String(session.runner_type ?? 'stream-json')
  if (humanOnlyRejectsActor(CHAT_ACTOR, runnerType)) {
    const reason = `automation_blocked_on_pty:${CHAT_ACTOR}`
    broadcastToSubscribers(sessionId, { type: 'send_refused', client_id: clientId, session_id: sessionId, error: 'automation_blocked_on_pty', reason })
    return refuse(409, { error: 'send_refused', reason })
  }

  if (session.cloud_session_id) return refuse(409, { error: 'send_refused', reason: 'cloud_session_unsupported' })

  for (const gate of SPEND_GATES) {
    const r = await gate.check({ userId, sessionId, token: `chat:${clientId}`, prompt: body.content })
    if (!r.ok) {
      broadcastToSubscribers(sessionId, { type: 'send_refused', client_id: clientId, session_id: sessionId, error: gate.name, reason: r.reason })
      return refuse(429, { error: 'send_refused', reason: r.reason })
    }
  }

  if (isScheduledRunActive(sessionId)) {
    broadcastToSubscribers(sessionId, { type: 'send_refused', client_id: clientId, session_id: sessionId, reason: 'scheduled_run_active' })
    return refuse(409, { error: 'send_refused', reason: 'scheduled_run_active' })
  }

  const offline = (reason: string, id?: string): SendResult => {
    broadcastToSubscribers(sessionId, { type: 'session_status', session_id: sessionId, status: 'offline' })
    broadcastToSubscribers(sessionId, { type: 'send_refused', client_id: clientId, session_id: sessionId, error: 'session_offline', reason })
    return refuse(409, { error: 'send_refused', reason: 'session_offline', ...(id ? { id } : {}) })
  }
  // Liveness BEFORE persisting: an offline session must not leave a user message row behind.
  const channel0 = getChannel(sessionId)
  if (!channel0 || (channel0.ws as any).readyState !== 1) {
    if (channel0) unregisterChannel(sessionId)
    return offline('No live runner is attached to this session.', reuse?.id)
  }

  let message = reuse
  if (!message) {
    let stored = body.content
    if (body.images?.length) {
      const md = body.images.map((img, i) => `![image-${i + 1}](data:${img.media_type};base64,${img.data})`).join('\n')
      stored = md + '\n\n' + stored
    }
    message = await insertMessage(sessionId, 'user', stored)
    notePersisted(message)
    broadcastToSubscribers(sessionId, { type: 'message', session_id: sessionId, message })
  }

  // Re-resolve at send time: the channel may have changed across the insert await.
  const channel = getChannel(sessionId)
  if (!channel || (channel.ws as any).readyState !== 1) {
    if (channel) unregisterChannel(sessionId)
    return offline('Session went offline before delivery.', message.id)
  }
  const payload: Record<string, unknown> = { type: 'user_message', id: message.id, content: body.content, ts: message.created_at }
  if (body.images) payload.images = body.images
  // Bun ws.send: >0 bytes sent, -1 queued under backpressure (still accepted), 0 dropped (failure).
  const sent = channel.ws.send(JSON.stringify(payload))
  if (sent === 0) {
    unregisterChannel(sessionId)
    return offline('Send to runner failed (message dropped).', message.id)
  }
  try { await updateSessionStatus(sessionId, 'thinking') } catch {}
  return refuse(202, { id: message.id, client_id: clientId })
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
