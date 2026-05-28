import type { ServerWebSocket } from 'bun'
import { ClientInbound, SUBSCRIBE_MAX } from './protocol'
import { verifyJwt } from '../auth/jwt.ts'
import { verifyAuthSessionToken } from '../session.ts'
import { verifyCsrfPair } from '../csrf.ts'
import { config } from '../config.ts'
import { insertMessage, listSessions, getSession, getUserLicenseFields } from '../db/dal'
import { checkDuplicate, recordSend } from './send-dedupe.ts'
import { checkUserThreshold } from '../usage/threshold.ts'
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
  // Phase 07-C: populated by the HTTP upgrade in hub/src/index.ts so the WS
  // auth handler can do cookie-based auth without trusting the client payload.
  cookieToken?: string | null
  csrfCookie?: string | null
  // Auth method (set after auth succeeds) — drives CSRF enforcement decisions.
  authMethod?: 'session_cookie' | 'legacy_jwt' | null
  // Phase 07-D parity: license cache on the WS connection. Mirrors the HTTP
  // license-gate semantics on /api/* — mutating WS messages refuse when
  // status !== 'active'. Refreshed opportunistically when stale (TTL matches
  // config.titanium.licenseCacheTtlSeconds).
  licenseStatus?: string | null
  licenseCheckedAt?: number | null
}

export function createClientWsData(): ClientWsData {
  return {
    authenticated: false,
    userId: null,
    clientEntry: null,
    authTimer: null,
    msgCount: 0,
    msgWindowStart: Date.now(),
    cookieToken: null,
    csrfCookie: null,
    authMethod: null,
    licenseStatus: null,
    licenseCheckedAt: null,
  }
}

// Mutating WS handlers that require an active license. Mirrors the HTTP
// gate's "not readOnlyOk" rule — `subscribe`, `unsubscribe`, and `pong` are
// read-only and always allowed.
const LICENSE_GATED_WS_TYPES = new Set([
  'send_message',
  'permission_response',
  'question_response',
])

/**
 * Returns true when the WS connection's user has an active license. When the
 * cached value is stale (older than the configured TTL), refreshes via the
 * DAL so a user who renews mid-session is unblocked without reconnecting.
 *
 * Fail-open on DAL errors — matches `license-gate.ts` decoupled-for-read
 * principle: a Postgres blip should NOT lock out a previously-active user.
 * The HTTP gate is still the authoritative ban for new requests.
 */
async function isLicenseActive(data: ClientWsData): Promise<boolean> {
  // Permissive mode — TITANIUM_BYPASS or LICENSE_REQUIRED=false. Matches the
  // HTTP gate's escape hatch. Prod currently runs with bypass=true.
  if (config.titaniumBypass || !config.licenseRequired) return true

  if (!data.userId) return false

  const ttlMs = config.titanium.licenseCacheTtlSeconds * 1000
  const checkedAt = data.licenseCheckedAt ?? 0
  const stale = Date.now() - checkedAt >= ttlMs

  if (stale) {
    try {
      const fields = await getUserLicenseFields(data.userId)
      data.licenseStatus = (fields?.license_status ?? 'NONE').toLowerCase()
      data.licenseCheckedAt = Date.now()
    } catch {
      // DAL unreachable — fail open if we had a prior active read.
      return (data.licenseStatus ?? '').toLowerCase() === 'active'
    }
  }

  return (data.licenseStatus ?? '').toLowerCase() === 'active'
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

    // Phase 07-C: cookie wins. If the upgrade carried a valid session cookie,
    // resolve identity from it and ignore any token in the auth payload.
    let resolvedUserId: string | null = null
    if (data.cookieToken) {
      try {
        const ctx = await verifyAuthSessionToken(data.cookieToken)
        if (ctx) {
          resolvedUserId = ctx.userId
          data.authMethod = 'session_cookie'
        }
      } catch {
        // fall through to bearer
      }
    }

    if (!resolvedUserId) {
      // Legacy bearer path — gated by soak flag.
      if (!config.allowLegacyLogin || !msg.token) {
        ws.close(4001, 'Unauthorized')
        return
      }
      try {
        const payload = verifyJwt(msg.token)
        resolvedUserId = payload.sub
        data.authMethod = 'legacy_jwt'
      } catch {
        ws.close(4001, 'Unauthorized')
        return
      }
    }

    data.userId = resolvedUserId
    data.authenticated = true

    // Phase 07-D WS parity: seed license cache from DAL at auth time. Failures
    // are non-fatal — the per-message gate will re-query on next mutation.
    try {
      const fields = await getUserLicenseFields(resolvedUserId)
      data.licenseStatus = (fields?.license_status ?? 'NONE').toLowerCase()
      data.licenseCheckedAt = Date.now()
    } catch {
      data.licenseStatus = null
      data.licenseCheckedAt = null
    }

    if (data.authTimer) clearTimeout(data.authTimer)

    data.clientEntry = registerClient(data.userId!, ws)
    console.log(`[client] authenticated user=${data.userId} method=${data.authMethod}`)
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

  // Phase 07-C: CSRF on mutating message types when authed via cookie.
  // Legacy bearer connections (during soak) are exempt — no csrf cookie was
  // ever set for them. `subscribe` is read-only and is exempt.
  const MUTATING_WS_TYPES = new Set(['send_message', 'permission_response', 'question_response'])
  if (data.authMethod === 'session_cookie' && MUTATING_WS_TYPES.has(msg.type)) {
    const supplied = (msg as any).csrf_token as string | undefined
    if (!verifyCsrfPair(data.csrfCookie ?? null, supplied ?? null)) {
      console.log(`[client] csrf_failed type=${msg.type} user=${data.userId}`)
      ws.send(JSON.stringify({ type: 'auth_error', error: 'csrf_failed' }))
      return
    }
  }

  // Phase 07-D WS parity: refuse mutating messages when license !== 'active'.
  // Mirrors the HTTP `requireActiveLicense` gate. Read-only ops (subscribe,
  // unsubscribe, pong) are always allowed. Connection stays open.
  if (LICENSE_GATED_WS_TYPES.has(msg.type)) {
    const ok = await isLicenseActive(data)
    if (!ok) {
      console.log(
        `[license-gate] WS mutation refused user=${data.userId} handler=${msg.type} status=${data.licenseStatus ?? 'unknown'}`,
      )
      try {
        ws.send(JSON.stringify({ type: 'send_refused', reason: 'license_inactive' }))
      } catch {}
      return
    }
  }

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

    // Dedupe retries on (session_id, client_msg_id). A duplicate within the
    // 5-min TTL replays the original ack and SKIPS the supervisor forward so
    // the runner doesn't see the same prompt twice.
    const replayed = checkDuplicate(msg.session_id, msg.id)
    if (replayed) {
      console.log(`[client] duplicate send_message client_id=${msg.id} — replaying ack`)
      try { ws.send(JSON.stringify(replayed)) } catch {}
      return
    }

    // Verify ownership
    const session = await getSession(msg.session_id, data.userId!)
    if (!session) {
      console.log(`[client] session not found or not owned: ${msg.session_id}`)
      return
    }

    // Claude usage threshold gate — refuses NEW manual dispatches when the
    // user is over their configured cap. Send a structured refusal back so
    // the UI can surface the "paused" banner inline.
    const threshold = await checkUserThreshold(data.userId!)
    if (!threshold.allowed) {
      try {
        ws.send(JSON.stringify({
          type: 'send_refused',
          client_id: msg.id,
          session_id: msg.session_id,
          error: 'quota_threshold_reached',
          reason: threshold.reason,
          utilization_pct: threshold.utilization_pct,
          threshold_pct: threshold.threshold_pct,
          resets_at: threshold.resets_at,
        }))
      } catch {}
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
    const ack = {
      type: 'send_ack' as const,
      client_id: msg.id,
      session_id: msg.session_id,
      message_id: message.id,
    }
    recordSend(msg.session_id, msg.id, ack)
    try {
      ws.send(JSON.stringify(ack))
    } catch {
      // socket closed mid-handle; client will resend on reconnect
    }

    // Broadcast to all subscribed clients (including sender for confirmation)
    broadcastToSubscribers(msg.session_id, {
      type: 'message',
      session_id: msg.session_id,
      message,
    })

    // Forward to channel or agent (Claude Code session).
    // Detect three failure modes so the UI never silently swallows a send:
    //   (a) no channel registered for this session (agent never connected, or
    //       was cleaned up by a close handler)
    //   (b) channel's underlying socket is not OPEN (readyState !== 1) — a
    //       half-open TCP connection where the agent process is gone but the
    //       hub hasn't observed the close yet
    //   (c) ws.send returns -1 (Bun backpressure / closed) — existing path
    // In all three cases: clean up registry (if stale), broadcast offline,
    // and emit a structured `send_refused` to the SENDER so the chat UI can
    // surface "session offline — no runner connected" instead of spinning.
    const channel = getChannel(msg.session_id)
    const readyState = channel ? (channel.ws as any).readyState : undefined
    const channelLive = !!channel && readyState === 1 // 1 = WebSocket.OPEN

    if (!channelLive) {
      const reason = !channel
        ? 'no_channel'
        : `socket_not_open(readyState=${readyState})`
      console.log(`[client] cannot forward session=${msg.session_id} reason=${reason}`)
      if (channel && readyState !== 1) {
        // Stale half-open entry — purge it so the next reconnect can register
        // cleanly and existing clients re-render as offline.
        unregisterChannel(msg.session_id)
      }
      broadcastToSubscribers(msg.session_id, {
        type: 'session_status',
        session_id: msg.session_id,
        status: 'offline',
      })
      try {
        ws.send(JSON.stringify({
          type: 'send_refused',
          client_id: msg.id,
          session_id: msg.session_id,
          error: 'session_offline',
          reason: 'No live runner is attached to this session. Start `claude-remote` in the project directory to reconnect.',
        }))
      } catch {}
      return
    }

    const forwardPayload: Record<string, unknown> = {
      type: 'user_message',
      id: message.id,
      content: msg.content,
      ts: message.created_at,
    }
    // Include images/attachments if present (used by agent connections)
    if (msg.images) forwardPayload.images = msg.images
    if (msg.attachments) forwardPayload.attachments = msg.attachments
    const sent = channel!.ws.send(JSON.stringify(forwardPayload))
    if (sent === -1) {
      // Socket reported OPEN moments ago but send failed — backpressure or
      // a race with close. Treat as offline and notify the sender.
      console.log(`[client] channel send failed (sent=-1), unregistering session=${msg.session_id}`)
      unregisterChannel(msg.session_id)
      broadcastToSubscribers(msg.session_id, { type: 'session_status', session_id: msg.session_id, status: 'offline' })
      try {
        ws.send(JSON.stringify({
          type: 'send_refused',
          client_id: msg.id,
          session_id: msg.session_id,
          error: 'session_offline',
          reason: 'Send to runner failed (socket closed mid-send). Reconnect your agent and retry.',
        }))
      } catch {}
    } else {
      console.log(`[client] forwarding to channel session=${msg.session_id} bytes=${sent}`)
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
