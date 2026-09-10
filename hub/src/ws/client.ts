import type { ServerWebSocket } from 'bun'
import { ClientInbound, SUBSCRIBE_MAX } from './protocol'
import { TermFrame, isTermFrameType, isClientToHubTermType } from './term-protocol'
import { verifyJwt } from '../auth/jwt.ts'
import { verifyAuthSessionToken } from '../session.ts'
import { verifyCsrfPair } from '../csrf.ts'
import { config } from '../config.ts'
import { insertMessage, getSession, getUserLicenseFields, canWriteTerminal, getSessionRunnerType } from '../db/dal'
import { listSessionsForUserEnriched } from '../sessions/enrich.ts'
import { humanOnlyRejectsActor } from '../dispatch/gates.ts'
import { acquire, releaseByWriter } from '../telegram/turn-lock.ts'
import { claimTermWriter, currentTermWriter, dropTermWriter } from './term-writers.ts'
import { log } from '../observability/logger'
import { checkDuplicate, recordSend } from './send-dedupe.ts'
import { checkUserThreshold } from '../usage/threshold.ts'
import { isScheduledRunActive } from '../scheduler/senders/agent.ts'
import {
  registerClient, unregisterClient, subscribeClient,
  getChannel, unregisterChannel, broadcastToSubscribers,
  broadcastErrorEvent,
  countSubscribers,
  type ClientEntry,
} from './registry'
import { noteSubscriberCount } from './idle-teardown.ts'

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
  // Phase 20: stable per-connection writer id for the PTY turn lock. A web
  // xterm panel is one writer; Telegram injection is the other ('telegram').
  writerId?: string
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
    writerId: `client:${crypto.randomUUID()}`,
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
    log.error('client.json_parse_error', { error: e.message })
    return
  }

  // --- Raw-terminal channel (Phase 15 R-PTY-02/03; Phase 16 hardening) ---
  // term.input/resize/attach/reattach from an authorized client are forwarded
  // byte-faithfully to the session's agent channel and MUST NOT enter the
  // structured client-protocol path. Short-circuit BEFORE ClientInbound.safeParse.
  // No `messages` row is created. Phase-16 guards (composed here):
  //   - DIRECTION ALLOWLIST (NH-2): /ws/client accepts ONLY client→PTY write
  //     frames; a server→client output frame (term.data) injected by a client is
  //     rejected.
  //   - OWNERSHIP (H2): server-side subscription set + DB-backed canWriteTerminal
  //     — a forged/foreign session_id is rejected (no cross-user/cross-session
  //     hijack).
  //   - HUMAN-ONLY (H1): the actor is SERVER-INFERRED as `human` from this
  //     authenticated cookie connection (NEVER a payload field); the shared
  //     humanOnlyPtyGate decision is applied to term.input on a pty-interactive
  //     session. (A human connection always passes; this is the spoof-proof seam
  //     that also covers the relay path, not just dispatch/pipeline.ts.)
  if (isTermFrameType(parsed)) {
    if (!data.authenticated || !data.userId) return
    const tf = TermFrame.safeParse(parsed)
    if (!tf.success) return
    const frame = tf.data
    // A PTY WRITE TURN injects bytes into stdin: term.input (keystrokes) and
    // term.attach_file (writes a host temp file then types its path). Both get
    // the license + human-only + turn-lock gates below; control frames
    // (resize/attach/reattach) bypass them.
    const isWriteTurn = frame.type === 'term.input' || frame.type === 'term.attach_file'
    const _diag = frame.type === 'term.input'
    // writer_id in the rx diag: without it, prod could not tell whether a doubled
    // keystroke came from one connection sending twice or from TWO connections.
    if (_diag) log.info('term.input.diag.rx', { session_id: frame.session_id, user_id: data.userId, writer_id: data.writerId })
    // DIRECTION ALLOWLIST (NH-2/R-PTY-33): only client→hub write frames here.
    if (!isClientToHubTermType(frame.type)) return
    // OWNERSHIP (H2/R-PTY-29): the session must be in THIS connection's
    // subscribed set AND owned by this user per the DB. Both checks — the
    // subscription set is the live routing scope; canWriteTerminal is the DB
    // ground-truth that defeats a forged session_id even if mis-subscribed.
    const subscribed = data.clientEntry?.subscriptions?.has(frame.session_id) ?? false
    if (!subscribed) { if (_diag) log.warn('term.input.diag.drop', { gate: 'not_subscribed', session_id: frame.session_id }); return }
    if (!(await canWriteTerminal(data.userId, frame.session_id))) { if (_diag) log.warn('term.input.diag.drop', { gate: 'cannot_write', session_id: frame.session_id }); return }
    const session = await getSession(frame.session_id, data.userId)
    if (!session) { if (_diag) log.warn('term.input.diag.drop', { gate: 'no_session', session_id: frame.session_id }); return }
    // License gate: a write turn drives a live session (a mutation).
    if (isWriteTurn && !(await isLicenseActive(data))) {
      log.warn('term.input.diag.drop', { gate: 'license_inactive', session_id: frame.session_id, frame: frame.type })
      try { ws.send(JSON.stringify({ type: 'send_refused', reason: 'license_inactive' })) } catch {}
      return
    }
    // HUMAN-ONLY guard on the relay (H1/R-PTY-28). Actor is SERVER-INFERRED as
    // 'human' from this authenticated /ws/client cookie connection — never read
    // from the frame. Applied to term.input (the write that drives the
    // interactive entrypoint) on a pty-interactive session.
    if (isWriteTurn) {
      const runnerType = await getSessionRunnerType(frame.session_id, data.userId)
      if (humanOnlyRejectsActor('human', runnerType)) {
        log.warn('term.input.diag.drop', { gate: 'human_only', session_id: frame.session_id, runner_type: runnerType })
        // Unreachable for a human actor by construction — but keep the SAME
        // chokepoint so there is no second, ungated write route into a PTY.
        return
      }
    }
    const channel = getChannel(frame.session_id)
    if (!channel) { if (_diag) log.warn('term.input.diag.drop', { gate: 'no_channel', session_id: frame.session_id }); return }
    // PTY WRITE-ARBITRATION (Phase 20 / R-TG-10). A term.input from the xterm
    // panel is a HUMAN TURN — it must hold the per-session turn lock before its
    // bytes reach PTY stdin so it never interleaves with a Telegram-injected
    // turn. The writerId is this connection (idempotent re-acquire while the same
    // writer streams keystrokes within its turn). resize/attach/reattach are
    // control frames, not turns — they bypass the lock. The lock releases on the
    // observed transcript turn_complete (telegram/bridge → onTurnComplete).
    if (isWriteTurn) {
      const writerId = data.writerId ?? 'client:unknown'
      // SINGLE CLIENT WRITER PER SESSION (fix/dup-pty-writer). This connection
      // becomes THE client writer for the session; any earlier client connection
      // (a leaked/stale socket, or the tab the user just left) is superseded and
      // released from the turn lock. Without this, two client writers ping-pong
      // the lock, queue-spam it and starve Telegram. Telegram is never
      // superseded here — it is arbitrated by the turn lock alone.
      const superseded = claimTermWriter(frame.session_id, writerId)
      if (superseded) {
        log.warn('term.writer.superseded', { session_id: frame.session_id, superseded, writer_id: writerId })
      }
      const granted = await acquire(frame.session_id, writerId)
      if (!granted) {
        log.warn('term.input.diag.drop', { gate: 'lock_not_granted', session_id: frame.session_id, writer_id: writerId })
        // Queued waiter was dropped (overflow/reset) — drop the frame rather than
        // inject out-of-turn bytes.
        return
      }
      // ENFORCE the invariant, don't just record it. `acquire` awaits: while this
      // frame sat in the turn-lock queue another client connection may have claimed
      // the session and superseded us. Claiming alone would leave the loser's bytes
      // still reaching PTY stdin — the stale socket would be unable to WEDGE the
      // lock but would not be MUZZLED. Drop the frame when this connection is no
      // longer the session's client writer. Logged with writer_id so a recurrence
      // of the prod two-writer ingress is visible instead of silent.
      const current = currentTermWriter(frame.session_id)
      if (current !== writerId) {
        log.warn('term.input.diag.drop', {
          gate: 'not_current_writer',
          session_id: frame.session_id,
          writer_id: writerId,
          current_writer: current,
        })
        return
      }
    }
    if (_diag) log.info('term.input.diag.fwd', { session_id: frame.session_id })
    try { channel.ws.send(JSON.stringify(frame)) } catch { if (_diag) log.warn('term.input.diag.drop', { gate: 'channel_send_threw', session_id: frame.session_id }) }
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
    log.info('client.authenticated', { user_id: data.userId, auth_method: data.authMethod })
    ws.send(JSON.stringify({ type: 'auth_ok' }))

    // Send session list immediately
    const sessions = await listSessionsForUserEnriched(data.userId!)
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

    // Auto-resume orphan sessions on web client connect (page load / refresh).
    // Sacred invariant: sessions whose last finalized run carries
    // `exit_reason='user_stopped'` are NEVER resumed. Rate-limited to once per
    // (user, 60s) inside the helper to absorb rapid refresh cycles. Errors
    // swallowed — this is best-effort and must not break auth.
    void (async () => {
      try {
        const { resumeOrphanSessionsForUser } = await import('../orchestrator/orphan-resume')
        const r = await resumeOrphanSessionsForUser(data.userId!)
        if (r.resumed.length > 0) {
          log.info('client.orphan_resume', { user_id: data.userId, resumed_count: r.resumed.length })
        }
      } catch (err: any) {
        log.error('client.orphan_resume_failed', { user_id: data.userId, error: err?.message })
      }
    })()
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
      log.warn('client.csrf_failed', { msg_type: msg.type, user_id: data.userId })
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
      log.warn('client.subscribe_error', { user_id: data.userId, error: 'too_many_sessions', requested: ids.length, max: SUBSCRIBE_MAX })
      ws.send(JSON.stringify({
        type: 'subscribe_error',
        error: 'too_many_sessions',
        max: SUBSCRIBE_MAX,
      }))
      return
    }

    if (ids.length === 0) {
      // Bug B — capture pre-subscribe set so we can recompute counts for
      // sessions this client is dropping.
      const prevIds = Array.from(data.clientEntry.subscriptions)
      subscribeClient(data.clientEntry, [])
      for (const sid of prevIds) noteSubscriberCount(sid, countSubscribers(sid))
      return
    }

    // Verify EVERY id belongs to the authenticated user. If any id is foreign,
    // reject the whole call and leave the existing subscription set unchanged.
    const ownedChecks = await Promise.all(
      ids.map((id: string) => getSession(id, data.userId!))
    )
    const allOwned = ownedChecks.every((s) => s !== null)
    if (!allOwned) {
      log.warn('client.subscribe_error', { user_id: data.userId, error: 'invalid_subscribe', requested_count: ids.length })
      ws.send(JSON.stringify({
        type: 'subscribe_error',
        error: 'invalid_subscribe',
      }))
      return
    }

    // Bug B — recompute subscriber counts for sessions affected by this swap.
    // Old IDs may now have one fewer; new IDs gain one. Cancel pending
    // teardowns for the new ids; schedule for dropped ones if count hit 0.
    const prevIds = new Set(data.clientEntry.subscriptions)
    subscribeClient(data.clientEntry, ids)
    const affected = new Set<string>([...prevIds, ...ids])
    for (const sid of affected) noteSubscriberCount(sid, countSubscribers(sid))
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
      // Audit: a tool-permission grant/deny was applied + delivered to the
      // supervisor. Traceable per (session, request, decision, source).
      log.info('permission.grant_applied', {
        session_id: msg.session_id,
        request_id: msg.request_id,
        approved: msg.approved,
        source: 'web',
        user_id: data.userId,
      })
    }
    try {
      const { clearPromptPending } = await import('./pending-prompts.ts')
      clearPromptPending(msg.session_id, msg.request_id)
    } catch {}
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
    try {
      const { clearPromptPending } = await import('./pending-prompts.ts')
      clearPromptPending(msg.session_id, msg.request_id)
    } catch {}
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

    // Bundle 5 fallback (TRIAGE-2026-05-28): refuse manual sends while a
    // scheduled run is the active turn for this session. Without this fence
    // the user's reply would be processed as the scheduled run's completion
    // (cross-attribution bug). User retries after the scheduled run finishes.
    if (isScheduledRunActive(msg.session_id)) {
      try {
        ws.send(JSON.stringify({
          type: 'send_refused',
          client_id: msg.id,
          session_id: msg.session_id,
          reason: 'scheduled_run_active',
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
  log.info('client.closed', { user_id: ws.data.userId })
  if (ws.data.authTimer) clearTimeout(ws.data.authTimer)
  // PTY write-arbitration: release any turn lock this connection held (and drop its
  // queued waiters) so a closed connection can never wedge another connection's
  // term.input. writerId is unique per connection (createClientWsData).
  if (ws.data.writerId) {
    releaseByWriter(ws.data.writerId)
    // Drop this connection's single-client-writer claims (fix/dup-pty-writer).
    dropTermWriter(ws.data.writerId)
  }
  if (ws.data.clientEntry) {
    // Bug B — capture the sessions this connection was subscribed to BEFORE
    // unregistering, then recompute counts for each so idle-teardown timers
    // start for any session that lost its last subscriber.
    const dropped = Array.from(ws.data.clientEntry.subscriptions)
    unregisterClient(ws.data.clientEntry)
    for (const sid of dropped) noteSubscriberCount(sid, countSubscribers(sid))
  }
}
