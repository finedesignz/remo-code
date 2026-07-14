import type { ServerWebSocket } from 'bun'
import { AgentInbound } from './agent-protocol'
import { TermFrame, isTermFrameType, isAgentToHubTermType } from './term-protocol'
import { verifyApiKeyWithScope, verifyApiKey, findOrCreateAgentSession, findOrCreateAgentSessionV2, findOrCreateRootlessSession, updateSessionStatus as setSessionStatus, insertMessage, insertAssistantPlaceholder, appendToMessage, finalizeMessage, listSessions, getUserSystemPrompt, getUserInstructions, recentlyDisconnectedForProjectDir, updateSessionAgentInfo, getSessionHostname, getSupervisorHostnameForApiKey, backfillSessionHostname } from '../db/dal'
import { createHash } from 'crypto'
import { hashToken } from '../lib/crypto'
import { generateToken } from '../utils/token'
import { registerChannel, unregisterChannel, getChannel, broadcastToSubscribers, broadcastToUser } from './registry'
import { verifyApiKeyWithCapability, upsertSupervisor, endRun, replaceSupervisorCommands, cleanupStaleSupervisorRows, finalizeOrphanedRunsForSupervisor } from '../db/supervisor-dal'
import { ensureSupervisorProject } from '../db/error-capture-dal'
import { getCapacitySnapshot } from '../sessions/budget'
import {
  registerSupervisor, unregisterSupervisor, resolveRequest, rejectRequest,
  updateSupervisorState, heartbeatSupervisor, getSupervisor,
  setSupervisorSessionInventory,
  setSupervisorCircuitBreakers,
} from './supervisor-registry'
import { log } from '../observability/logger'

const AUTH_TIMEOUT_MS = 5_000
const HEARTBEAT_INTERVAL_MS = 30_000
const RATE_LIMIT = { max: 120, windowMs: 10_000 }

/**
 * fix/supervisor-hostname-required — hostname is REQUIRED on a `/ws/agent` auth
 * frame. A hostname-less auth mints a live phantom channel behind a
 * `status='online', hostname=NULL` row (a ghost): `getChannel() != null` so the
 * orchestrator dispatches into the void and autospawn never fires. The
 * ghost-reaper mops these up, but the tap keeps running.
 *
 * COMPAT: the supervisor ships as a signed MSI on user machines. Hard-rejecting
 * today would lock out any installed build that doesn't send a hostname, so the
 * default is LOG-AND-ACCEPT (after the hub's own hostname-resolution fallback
 * chain, which is what actually prevents the ghost row). Flip
 * `REMO_WS_REQUIRE_HOSTNAME=1` (accepts 1|true|yes|on) once every installed
 * supervisor is known to be ≥ the release that guarantees a hostname; the hub
 * then closes the socket with 4001 `hostname_required` instead of guessing.
 */
export function isHostnameRequiredOnAgentAuth(
  env: Record<string, string | undefined> = process.env as any,
): boolean {
  const raw = env.REMO_WS_REQUIRE_HOSTNAME
  if (raw == null) return false
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase())
}

/**
 * Set of `last_exit.reason` values that supervisor's `process-manager.ts`
 * emits when it REJECTS a start request (the run never began). Kept in lock-
 * step with `supervisor/src/process-manager.ts` `StartRejection.reason`.
 *
 * Supervisor wraps each rejection in `onStateChange('stopped', { lastExit })`
 * — but that 'stopped' is per-rejected-run, not a supervisor-wide state. If
 * the hub blindly persists it, a single stale-slot rejection marks the whole
 * supervisor row as `state='stopped'`, breaking every subsequent launch path
 * (`launchSessionForUser`, web start, scheduler) because the row no longer
 * looks "idle/online" to downstream consumers. Symptom seen in prod
 * 2026-05-28: `/doctor` retries each create a `session_runs` row that ends
 * 200ms later with `exit_reason='concurrency_cap'` and the supervisor row
 * stays at `state='stopped'` until something else writes idle.
 */
export const SUPERVISOR_START_REJECT_REASONS: ReadonlySet<string> = new Set([
  'concurrency_cap',
  'duplicate_run',
  'sandbox_escape',
  'not_git_repo',
  'legacy_agent_spawn_disabled',
  // fix/stop-the-bleed — the supervisor's spawn circuit-breaker refused THIS run
  // (the repo is crash-looping). Per-run, not a supervisor-wide 'stopped'.
  'circuit_open',
])

/**
 * Returns true when a `supervisor.state` payload represents a per-run start
 * rejection (and therefore must NOT overwrite the supervisor's aggregate
 * `state` column with `'stopped'`).
 */
export function isStartRejectStateMessage(msg: {
  state?: string
  last_exit?: { code: number | null; reason: string } | null
}): boolean {
  return (
    !!msg.last_exit &&
    msg.state === 'stopped' &&
    SUPERVISOR_START_REJECT_REASONS.has(msg.last_exit.reason)
  )
}

// Per-session streaming assistant message state. Created lazily on first
// text_delta of a turn, finalized on assistant_message. Survives hub restart
// because every flush persists to Postgres.
const STREAM_FLUSH_INTERVAL_MS = 500
const STREAM_FLUSH_BYTES = 1024
interface StreamingMessageState {
  id: string
  buffer: string
  flushTimer: ReturnType<typeof setTimeout> | null
  flushing: Promise<void> | null
}
const streamingBySession = new Map<string, StreamingMessageState>()

async function flushStreaming(sessionId: string): Promise<void> {
  const st = streamingBySession.get(sessionId)
  if (!st || !st.buffer) return
  const chunk = st.buffer
  st.buffer = ''
  st.flushing = appendToMessage(st.id, chunk).catch((err: any) => {
    log.error('agent.flush_streaming_failed', { session_id: sessionId, error: err.message })
  })
  await st.flushing
  st.flushing = null
}

function scheduleStreamFlush(sessionId: string) {
  const st = streamingBySession.get(sessionId)
  if (!st) return
  if (st.buffer.length >= STREAM_FLUSH_BYTES) {
    if (st.flushTimer) { clearTimeout(st.flushTimer); st.flushTimer = null }
    void flushStreaming(sessionId)
    return
  }
  if (st.flushTimer) return
  st.flushTimer = setTimeout(() => {
    const s = streamingBySession.get(sessionId)
    if (s) s.flushTimer = null
    void flushStreaming(sessionId)
  }, STREAM_FLUSH_INTERVAL_MS)
}

export interface AgentWsData {
  authenticated: boolean
  role: 'agent' | 'supervisor'
  sessionId: string | null
  supervisorId: string | null
  userId: string | null
  apiKeyId: string | null
  authTimer: ReturnType<typeof setTimeout> | null
  heartbeatTimer: ReturnType<typeof setInterval> | null
  messageCount: number
  windowStart: number
}

export function createAgentWsData(): AgentWsData {
  return {
    authenticated: false,
    role: 'agent',
    sessionId: null,
    supervisorId: null,
    userId: null,
    apiKeyId: null,
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
  const now = Date.now()
  if (now - ws.data.windowStart > RATE_LIMIT.windowMs) {
    ws.data.messageCount = 0
    ws.data.windowStart = now
  }
  if (++ws.data.messageCount > RATE_LIMIT.max) return

  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch (e: any) {
    console.error('[agent] JSON parse error:', e.message)
    return
  }

  // --- Raw-terminal channel (Phase 15 R-PTY-02/03; Phase 16 hardening) ---
  // term.* frames from the agent/supervisor are relayed byte-faithfully to the
  // subscribed clients and MUST NOT enter the structured agent-protocol path
  // (no RunnerEvent translation, no `messages` persistence). Short-circuit
  // BEFORE AgentInbound.safeParse. Phase-16 guards (composed here):
  //   - DIRECTION ALLOWLIST (NH-2): /ws/agent is OUTPUT-ONLY — only term.data is
  //     accepted. A term.input injected on /ws/agent is rejected before any
  //     forward (an inventory-valid supervisor socket cannot become an unguarded
  //     input path into a human PTY).
  //   - INVENTORY + DB CROSS-VALIDATION (H3/NH-1): the frame's session_id must be
  //     advertised by THIS connection (its own bound session, or — for a
  //     multiplexed supervisor — present in its session_inventory) AND, per the
  //     DB, legitimately owned by this host (sessions.hostname). A host claiming
  //     a session it does not own per the DB is DROPPED even if it self-asserts
  //     it in its inventory.
  if (isTermFrameType(parsed)) {
    if (!ws.data.authenticated) return
    const tf = TermFrame.safeParse(parsed)
    if (!tf.success) return
    const frame = tf.data
    // DIRECTION ALLOWLIST (NH-2/R-PTY-33): /ws/agent relays OUTPUT only.
    if (!isAgentToHubTermType(frame.type)) return

    // INVENTORY authz (H3/R-PTY-30): the session must be advertised by THIS
    // connection. Plain agent socket → its own bound sessionId. Supervisor
    // socket → its advertised session_inventory.
    let advertised = false
    let advertisedHostname: string | null = null
    if (ws.data.role === 'supervisor' && ws.data.supervisorId) {
      const entry = getSupervisor(ws.data.supervisorId)
      advertised = !!entry?.sessionInventory.some((s) => s.session_id === frame.session_id)
      advertisedHostname = entry?.hostname ?? null
    } else if (ws.data.sessionId) {
      advertised = frame.session_id === ws.data.sessionId
    }
    if (!advertised) return // cross-host injection rejected

    // DB HOST-OWNERSHIP CROSS-VALIDATION (NH-1/R-PTY-35): defeat a spoofed
    // inventory entry. For a supervisor socket, the DB-recorded session hostname
    // must match this supervisor's hostname. (Plain agent sockets are bound to a
    // single session at auth time, so the inventory check already pins them; the
    // cross-validation is the supervisor-multiplex hardening.)
    if (ws.data.role === 'supervisor') {
      try {
        const dbHost = await getSessionHostname(frame.session_id)
        // Only enforce when BOTH sides record a hostname; a null on either side
        // means the session predates host-keying — fall back to the inventory
        // check already passed (don't hard-drop a legitimate legacy session).
        if (dbHost && advertisedHostname && dbHost !== advertisedHostname) {
          log.warn('term.agent_host_mismatch', {
            session_id: frame.session_id,
            db_host: dbHost,
            claimed_host: advertisedHostname,
            supervisor_id: ws.data.supervisorId,
          })
          return // host claiming a session it does not own per the DB → dropped
        }
      } catch {
        // DB error — fail closed for the cross-validation path: drop.
        return
      }
    }

    broadcastToSubscribers(frame.session_id, frame)
    return
  }

  const result = AgentInbound.safeParse(parsed)
  if (!result.success) {
    // Surface schema rejections so silent drops don't masquerade as connection
    // failures. Truncate payload preview to keep logs readable.
    const t = (parsed as any)?.type ?? 'unknown'
    const preview = JSON.stringify(parsed).slice(0, 200)
    log.warn('agent.schema_reject', {
      msg_type: t,
      authenticated: ws.data.authenticated,
      role: ws.data.role,
      errors: result.error.issues.map(i => `${i.path.join('.')}:${i.message}`).join('; '),
      payload_preview: preview,
    })
    return
  }
  const msg = result.data

  // --- Auth ---
  if (msg.type === 'auth') {
    if (ws.data.authenticated) return
    const keyHash = await hashToken(msg.api_key)

    // Milestone SKEY — /ws/agent (both roles) is the HOST-SPAWN surface and
    // requires the `agent` scope. NULL/empty scopes = legacy full access, so
    // every pre-existing key keeps working with zero migration. A scoped
    // external key (ext:read / ext:ask only) is rejected here by construction.
    const scoped = await verifyApiKeyWithScope(keyHash, 'agent')
    if ('error' in scoped && scoped.error === 'missing_scope') {
      log.warn('agent.auth_fail', { reason: 'missing_agent_scope', hash_prefix: keyHash.slice(0, 8) })
      ws.send(JSON.stringify({ type: 'auth_error', error: 'missing scope: agent', reason: 'missing_scope' }))
      ws.close(4001, 'missing_agent_scope')
      return
    }

    if (msg.role === 'supervisor') {
      const verified = await verifyApiKeyWithCapability(keyHash, 'supervisor')
      if (!verified.ok) {
        // Map disambiguated reasons → close-code reason text + log line.
        let closeReason: string
        let errorMsg: string
        switch (verified.reason) {
          case 'not_found':
            closeReason = 'api_key_not_found'
            errorMsg = 'invalid api key'
            log.warn('supervisor.auth_fail', { reason: 'not_found', hash_prefix: keyHash.slice(0,8) })
            break
          case 'revoked':
            closeReason = 'api_key_revoked'
            errorMsg = 'api key revoked'
            log.warn('supervisor.auth_fail', { reason: 'revoked', hash_prefix: keyHash.slice(0,8) })
            break
          case 'deleted':
            closeReason = 'api_key_not_found'
            errorMsg = 'api key not found'
            log.warn('supervisor.auth_fail', { reason: 'deleted', hash_prefix: keyHash.slice(0,8) })
            break
          case 'missing_capability':
            closeReason = 'missing_supervisor_capability'
            errorMsg = `missing capability: need=${verified.need} have=${JSON.stringify(verified.have)}`
            log.warn('supervisor.auth_fail', { reason: 'missing_capability', need: verified.need, have: verified.have })
            break
        }
        ws.send(JSON.stringify({ type: 'auth_error', error: errorMsg, reason: verified.reason }))
        ws.close(4001, closeReason)
        return
      }
      ws.data.authenticated = true
      ws.data.role = 'supervisor'
      ws.data.userId = verified.userId
      ws.data.apiKeyId = verified.apiKeyId
      if (ws.data.authTimer) clearTimeout(ws.data.authTimer)
      console.log(`[supervisor] authenticated user=${verified.userId}`)
      ws.send(JSON.stringify({ type: 'auth_ok', role: 'supervisor' }))
      ws.data.heartbeatTimer = setInterval(() => {
        try { ws.send(JSON.stringify({ type: 'ping' })) } catch {}
      }, HEARTBEAT_INTERVAL_MS)
      return
    }

    const userId = await verifyApiKey(keyHash)
    if (!userId) {
      // Surface silent auth failures — without this log the only signal a
      // misconfigured/stale agent leaves on the hub is a bare `[agent]
      // connection opened` with no follow-up, which is indistinguishable from
      // a network blip. Hash prefix is safe to log (one-way SHA-256).
      log.warn('agent.auth_fail', { reason: 'invalid_api_key', hash_prefix: keyHash.slice(0, 8), hostname: msg.hostname ?? 'unknown' })
      ws.send(JSON.stringify({ type: 'auth_error', error: 'invalid api key' }))
      ws.close(4001, 'auth failed')
      return
    }
    // Plan 05-002 made `project_dir` optional in the schema (rootless-only
    // agents). Reject explicitly when BOTH project_dir AND rootless_sessions
    // are missing — without this guard `msg.project_dir.replace(...)` below
    // would throw and the connection would close with no diagnostic.
    const rootlessAdvertised = Array.isArray((msg as any).rootless_sessions)
      && (msg as any).rootless_sessions.length > 0
    if (!msg.project_dir && !rootlessAdvertised) {
      log.warn('agent.auth_fail', { reason: 'no_project_or_rootless', user_id: userId, hostname: msg.hostname ?? 'unknown' })
      ws.send(JSON.stringify({ type: 'auth_error', error: 'missing project_dir or rootless_sessions' }))
      ws.close(4001, 'auth failed')
      return
    }
    const projectDir = (msg.project_dir ?? '').replace(/\\/g, '/')

    // Refuse stale reconnects: if the user just clicked "Disconnect" in the UI,
    // any agent process that was alive at that moment will try to reconnect.
    // Tell it to give up so it exits cleanly instead of recreating the session.
    const recentlyDisconnected = await recentlyDisconnectedForProjectDir(userId, projectDir, 30)
    if (recentlyDisconnected) {
      console.log(`[agent] refusing reconnect — session ${recentlyDisconnected.id} was disconnected by user`)
      ws.send(JSON.stringify({ type: 'auth_error', error: 'session_disconnected' }))
      ws.close(4002, 'session disconnected')
      return
    }

    const rawToken = generateToken('remo_')
    const tokenHash = await hashToken(rawToken)
    const cliKind: 'claude' | 'codex' = (msg as any).cli_kind ?? 'claude'
    const gitInput = (msg as any).git as Parameters<typeof findOrCreateAgentSessionV2>[4]
    // Resolve a non-null hostname for the session. An online session with a NULL
    // hostname is a ghost: pickSupervisorForSession can't map it (autospawn
    // refuses `supervisor_offline`) and the ghost-reaper's grace keeps resetting.
    // Fallback chain: auth frame → agent_info → the supervisor bound to this
    // api_key (an agent shares its host supervisor's key). Never invent one.
    const advertisedHostname = (msg.hostname || (msg as any).agent_info?.hostname || '').toString().trim()
    let effectiveHostname = advertisedHostname
    if (!effectiveHostname) {
      // Contract violation: every supported supervisor sends a hostname. Emit a
      // metric-able warn on EVERY such frame so the compat window is
      // observable (count → 0 means it's safe to flip REMO_WS_REQUIRE_HOSTNAME).
      log.warn('agent.auth_hostname_missing', {
        user_id: userId,
        project_dir: projectDir,
        hash_prefix: keyHash.slice(0, 8),
        enforced: isHostnameRequiredOnAgentAuth(),
      })
      if (isHostnameRequiredOnAgentAuth()) {
        ws.send(JSON.stringify({ type: 'auth_error', error: 'hostname required on /ws/agent auth', reason: 'hostname_required' }))
        ws.close(4001, 'hostname_required')
        return
      }
      try { effectiveHostname = (await getSupervisorHostnameForApiKey(keyHash)) ?? '' } catch { effectiveHostname = '' }
      if (effectiveHostname) {
        console.warn(`[agent] auth omitted hostname; resolved '${effectiveHostname}' from api_key supervisor to avoid a ghost session`)
      }
    }
    const session = await findOrCreateAgentSessionV2(
      userId,
      projectDir,
      tokenHash,
      cliKind,
      gitInput,
      effectiveHostname || null,
    )

    if (!session.created) {
      unregisterChannel(session.id)
      // Clear any in-flight streaming state from a prior (now-closing) channel
      // for this session. Without this, a half-finalized streaming message
      // from the previous socket can collide with the new socket's first
      // text_delta, double-broadcasting placeholders.
      streamingBySession.delete(session.id)
    }

    ws.data.authenticated = true
    ws.data.role = 'agent'
    ws.data.sessionId = session.id
    ws.data.userId = userId
    if (ws.data.authTimer) clearTimeout(ws.data.authTimer)

    console.log(`[agent] authenticated session=${session.id} user=${userId} project=${projectDir} cli=${cliKind} reused=${!session.created} repo_keyed=${session.repo_keyed} migrated=${session.migrated ?? false}`)
    registerChannel(session.id, userId, ws as any)

    // Persist the resolved hostname BEFORE flipping the session online so it is
    // never observable as online+NULL-hostname (a ghost). agent_info (when sent)
    // carries the richer host detail for the Settings UI; either way the
    // hostname column is backfilled from effectiveHostname.
    if ((msg as any).agent_info) {
      const info = { ...(msg as any).agent_info, hostname: (msg as any).agent_info.hostname || effectiveHostname || undefined }
      try { await updateSessionAgentInfo(session.id, info) } catch (e: any) {
        console.error('[agent] failed to persist agent_info', e?.message)
      }
    }
    // Chokepoint: guarantee the row carries a hostname before it flips online,
    // so it is never observable as a routable-but-unroutable ghost. Backfill
    // only (COALESCE) — never clobber an existing host.
    try { await backfillSessionHostname(session.id, effectiveHostname || null) } catch {}

    await setSessionStatus(session.id, 'online')

    // Phase 05: handle rootless ambient-session advertisement.
    // The agent sends `rootless_sessions: ['claude','codex'?]` to opt-in to
    // ambient (project-less) sessions per host per CLI.
    const rootlessRequested: Array<'claude' | 'codex'> = Array.isArray((msg as any).rootless_sessions)
      ? ((msg as any).rootless_sessions as string[]).filter((k): k is 'claude' | 'codex' => k === 'claude' || k === 'codex')
      : []
    const rootlessSessionIds: { claude?: string; codex?: string } = {}
    if (rootlessRequested.length > 0) {
      const hostname = (msg.hostname || (msg as any).agent_info?.hostname || '').toString()
      if (!hostname) {
        console.warn(`[agent] rootless_sessions advertised without hostname; ignoring`)
      } else {
        for (const k of rootlessRequested) {
          try {
            const rawTok = generateToken('remo_')
            const hash = await hashToken(rawTok)
            const row = await findOrCreateRootlessSession(
              userId, hostname, k, hash,
              `${k === 'claude' ? 'Claude' : 'Codex'} (ambient — ${hostname})`,
            )
            rootlessSessionIds[k] = row.id
          } catch (e: any) {
            console.error(`[agent] rootless ${k} create failed`, e?.message)
          }
        }
      }
    }

    // Phase 05: compute seed_files from user instruction blobs scoped to the CLIs we host.
    const cliKindsHosted = new Set<'claude' | 'codex'>([cliKind])
    for (const k of rootlessRequested) cliKindsHosted.add(k)
    const inst = await getUserInstructions(userId)
    const seedCatalog: Array<{ cli: 'claude' | 'codex'; path: string; blob: string | null }> = [
      { cli: 'claude', path: '~/.claude/CLAUDE.md', blob: inst.claude_global_md },
      { cli: 'codex',  path: '~/.codex/AGENTS.md', blob: inst.codex_agents_md },
      { cli: 'codex',  path: '~/.codex/config.toml', blob: inst.codex_config_toml },
    ]
    const seedFiles = seedCatalog
      .filter((e) => cliKindsHosted.has(e.cli) && e.blob && e.blob.length > 0)
      .map((e) => ({
        path: e.path,
        content: e.blob as string,
        sha256: createHash('sha256').update(e.blob as string).digest('hex'),
        mode: 'create_if_absent' as const,
      }))

    const systemPrompt = await getUserSystemPrompt(userId)
    ws.send(JSON.stringify({
      type: 'auth_ok',
      session_id: session.id,
      system_prompt: systemPrompt,
      cli_kind: cliKind,
      ...(Object.keys(rootlessSessionIds).length > 0 ? { rootless_session_ids: rootlessSessionIds } : {}),
      ...(seedFiles.length > 0 ? { seed_files: seedFiles } : {}),
    }))

    ws.data.heartbeatTimer = setInterval(() => {
      try { ws.send(JSON.stringify({ type: 'ping' })) } catch {}
    }, HEARTBEAT_INTERVAL_MS)

    broadcastToUser(userId, { type: 'session_list', sessions: await listSessionsForUser(userId) })
    broadcastToSubscribers(session.id, {
      type: 'session_status',
      session_id: session.id,
      status: 'online',
    })
    // W2/T12 + W3/T4 — drain everything parked for this session on reconnect.
    // Round-2 migration: scheduled session runs, error-capture, AND revanote all
    // park in the shared dispatch grace buffer keyed by sessionId; one drain
    // replays them all. (The legacy scheduler/grace.ts + revanote/grace.ts
    // buffers are retired.)
    try {
      const { getGraceBuffer } = await import('../dispatch/grace.ts')
      void getGraceBuffer().drain(session.id)
    } catch {}
    return
  }

  if (!ws.data.authenticated) return

  // --- Supervisor messages ---
  if (ws.data.role === 'supervisor') {
    await handleSupervisorMessage(ws, msg)
    return
  }

  if (!ws.data.sessionId) return
  const { sessionId } = ws.data

  // --- Agent activity events ---
  if (msg.type === 'thinking' || msg.type === 'tool_use' || msg.type === 'tool_result') {
    broadcastToSubscribers(sessionId, { ...msg })
    // Fan tool_use out to server-side consumers (Telegram summarized streaming).
    // tool_use ONLY — thinking/tool_result are intentionally not surfaced. A
    // listener throw is isolated by the emitter so it can't tear down this WS
    // handler. Dynamic import mirrors the assistant/permission emits below.
    if (msg.type === 'tool_use') {
      try {
        const { emitSessionActivity } = await import('../events/session-activity-events.ts')
        const input = (msg as any).input
        let detail = ''
        if (input && typeof input === 'object') {
          const o = input as Record<string, unknown>
          const v = o.command ?? o.file_path ?? o.path ?? o.url ?? o.pattern
          if (typeof v === 'string') detail = v
        }
        emitSessionActivity({
          sessionId,
          userId: ws.data.userId!,
          kind: 'tool_use',
          toolName: (msg as any).tool ?? 'tool',
          detail,
        })
      } catch (err: any) {
        console.warn('[agent] emitSessionActivity failed', err?.message)
      }
    }
  }

  if (msg.type === 'text_delta') {
    // Lazily create a streaming assistant placeholder on the first delta of a
    // turn. Broadcast an empty `message` event so the UI shows an assistant
    // bubble immediately; subsequent text_delta events carry the message_id
    // so the client appends content to the right bubble.
    let st = streamingBySession.get(sessionId)
    if (!st) {
      try {
        const placeholder = await insertAssistantPlaceholder(sessionId)
        st = { id: placeholder.id, buffer: '', flushTimer: null, flushing: null }
        streamingBySession.set(sessionId, st)
        broadcastToSubscribers(sessionId, {
          type: 'message',
          session_id: sessionId,
          message: placeholder,
        })
      } catch (err: any) {
        console.error(`[agent] failed to create assistant placeholder session=${sessionId}`, err.message)
      }
    }
    // Tag the delta with message_id so the UI can append to the correct bubble.
    broadcastToSubscribers(sessionId, { ...msg, message_id: st?.id })
    if (st) {
      st.buffer += msg.content
      scheduleStreamFlush(sessionId)
    }
  }

  if (msg.type === 'agent_log') {
    broadcastToSubscribers(sessionId, { type: 'agent_log', session_id: sessionId, message: msg.message })
  }

  if (msg.type === 'permission_request') {
    console.log(`[agent] permission_request session=${sessionId} tool=${msg.tool_name} req=${msg.request_id}`)
    broadcastToSubscribers(sessionId, {
      type: 'permission_request',
      session_id: sessionId,
      request_id: msg.request_id,
      tool_name: msg.tool_name,
      tool_input: msg.tool_input,
    })
    // Mark the session blocked on a pending prompt so idle-teardown won't kill
    // it while it waits for a user decision (TG isn't a persistent subscriber).
    try {
      const { markPromptPending } = await import('./pending-prompts.ts')
      markPromptPending(sessionId, msg.request_id)
    } catch {}
    // Surface the prompt to server-side consumers (Telegram inline-approval
    // bridge). Dynamic import + try/catch mirrors the assistant-events emit
    // below; a listener throw can't tear down this WS handler.
    try {
      const { emitPermissionPending } = await import('../events/permission-events.ts')
      emitPermissionPending({
        sessionId,
        userId: ws.data.userId!,
        requestId: msg.request_id,
        toolName: msg.tool_name,
        toolInput: msg.tool_input,
      })
    } catch (err: any) {
      console.warn('[agent] emitPermissionPending failed', err?.message)
    }
  }

  if (msg.type === 'user_question') {
    console.log(`[agent] user_question session=${sessionId} req=${msg.request_id}`)
    broadcastToSubscribers(sessionId, {
      type: 'user_question',
      session_id: sessionId,
      request_id: msg.request_id,
      question: msg.question,
      ...(msg.options ? { options: msg.options } : {}),
      ...(msg.is_multi_select ? { is_multi_select: msg.is_multi_select } : {}),
    })
    // Mark the session blocked on a pending prompt (idle-teardown exemption).
    try {
      const { markPromptPending } = await import('./pending-prompts.ts')
      markPromptPending(sessionId, msg.request_id)
    } catch {}
    // Bridge the question to Telegram (one inline button per option). Dynamic
    // import + try/catch mirrors the permission bridge above; a listener throw
    // can't tear down this WS handler.
    try {
      const { emitQuestionPending } = await import('../events/question-events.ts')
      emitQuestionPending({
        sessionId,
        userId: ws.data.userId!,
        requestId: msg.request_id,
        question: msg.question,
        options: msg.options ?? [],
        isMultiSelect: msg.is_multi_select === true,
      })
    } catch (err: any) {
      console.warn('[agent] emitQuestionPending failed', err?.message)
    }
  }

  if (msg.type === 'status') {
    const dbStatus = msg.state === 'idle' ? 'online' : 'thinking'
    await setSessionStatus(sessionId, dbStatus as any)
    broadcastToSubscribers(sessionId, msg)
    broadcastToUser(ws.data.userId!, { type: 'session_status', session_id: sessionId, status: dbStatus })
    // Round-2 collapse (final): scheduled-run waiter promotion does NOT fire on
    // the thinking→idle status transition. All four inbound subsystems
    // (error-capture, revanote, scheduler, telegram) run on the shared dispatch
    // pipeline (hub/src/dispatch/). The pipeline promotes the queued waiter when
    // the agent's assistant_message lands (onSessionReply → SessionQueue
    // .markFinished → re-dispatch through the gate list) — the correct
    // completion signal, since a status:idle can precede the final
    // assistant_message. The old scheduler/session-queue.ts shim and its
    // setOnPromote/onSessionIdleAndPromote callback seam are gone.
  }

  if (msg.type === 'assistant_message') {
    console.log(`[agent] assistant_message session=${sessionId} len=${msg.content.length}`)
    // Phase 12 W3 — emit final-message event for server-side consumers
    // (Telegram bridge etc.). FINAL only — text_delta/thinking are NEVER
    // forwarded. Errors inside listeners are isolated by the emitter helper
    // so they cannot tear down the WS handler.
    let finalEventMessageId: string | undefined
    const st = streamingBySession.get(sessionId)
    if (st) {
      // Cancel any pending throttled flush and overwrite with the fully
      // assembled final text from the agent. This covers any deltas dropped
      // during throttling and guarantees the persisted content matches.
      if (st.flushTimer) { clearTimeout(st.flushTimer); st.flushTimer = null }
      st.buffer = ''
      if (st.flushing) { try { await st.flushing } catch {} }
      const message = await finalizeMessage(st.id, msg.content)
      streamingBySession.delete(sessionId)
      if (message) {
        finalEventMessageId = (message as any).id
        broadcastToSubscribers(sessionId, {
          type: 'message',
          session_id: sessionId,
          message,
        })
      }
    } else {
      // No prior text_delta (e.g. agent reconnect between Claude's response
      // and the result event). Fall back to a one-shot insert.
      const message = await insertMessage(sessionId, 'assistant', msg.content)
      finalEventMessageId = (message as any)?.id
      broadcastToSubscribers(sessionId, {
        type: 'message',
        session_id: sessionId,
        message,
      })
    }
    // Phase 12 W3 — fan out to server-side subscribers (Telegram bridge etc.)
    try {
      const { emitAssistantMessageFinal } = await import('../events/assistant-events.ts')
      emitAssistantMessageFinal({
        sessionId,
        userId: ws.data.userId!,
        text: msg.content,
        messageId: finalEventMessageId,
      })
    } catch (err: any) {
      console.warn('[agent] emitAssistantMessageFinal failed', err?.message)
    }
    // Phase 06 plan 008 — finalize a SUPERVISOR-SPAWNED triage run for this
    // session. The supervisor-spawn triage path is NOT a per-session-queue
    // dispatch (it spawns a fresh session via the supervisor, parallel to
    // sendSupervisorTask), so it stays on the legacy `pending` map +
    // onTriageAssistantMessage hook. triageActiveForSession is true only for
    // those spawned sessions; LOCAL-AGENT triage finalizes via onSessionReply
    // below. Telegram's outbound bridge is also unmigrated (subsystem 4).
    try {
      const tri = await import('../scheduler/senders/triage.ts')
      if (tri.triageActiveForSession(sessionId)) {
        void tri.onTriageAssistantMessage(sessionId, msg.content)
      }
    } catch {}
    // Round-2: scheduler (session sends + local-agent triage), error-capture, and
    // revanote ALL finalize via the shared dispatch pipeline's finalize hook
    // (RunStore.onFinalize) + waiter promotion. onSessionReply no-ops for any
    // session without an active pipeline hook, so it is safe to call alongside
    // the supervisor-spawned triage hook above.
    // TODO(round2): subsystem 4 (Telegram outbound bridge) is the last legacy
    // finalize path; it forwards assistant_message:final via the assistant-events
    // bus, not a run row, so it does not route through onSessionReply.
    try {
      const { onSessionReply } = await import('../dispatch/pipeline.ts')
      void onSessionReply(sessionId, msg.content)
    } catch {}
    // Turn finished — clear any pending-prompt marks so idle-teardown is no
    // longer suppressed for this session (a prompt answered mid-turn already
    // cleared its own requestId; this is a belt-and-suspenders sweep).
    try {
      const { clearAllPromptsPending } = await import('./pending-prompts.ts')
      clearAllPromptsPending(sessionId)
    } catch {}
  }

  if (msg.type === 'usage_report') {
    if (!ws.data.userId) return
    try {
      const { setUsage } = await import('../usage/store')
      const snap = setUsage(ws.data.userId, msg.usage as any)
      broadcastToUser(ws.data.userId, {
        type: 'subscription_usage',
        usage: snap.usage,
        updated_at: snap.updated_at,
      })
    } catch (err: any) {
      console.error('[agent] usage_report handler failed', err?.message)
    }
    return
  }

  // P2 usage ledger — persist per-turn token + cost from the supervisor bridge.
  // RECORD only; the cost cap (P3) is intentionally NOT consulted here.
  if (msg.type === 'usage_event') {
    if (!ws.data.userId) return
    try {
      const { recordTokenUsage } = await import('../db/token-usage-dal.ts')
      const { estimateCostUsd } = await import('../usage/pricing.ts')
      // SDK total_cost_usd is authoritative. Only estimate when the supervisor
      // flagged the cost as missing (cost_source='estimated').
      let costUsd = msg.cost_usd
      let costSource: 'sdk' | 'estimated' = msg.cost_source
      if (costSource === 'estimated' || !(costUsd > 0)) {
        if (costSource !== 'sdk') {
          costUsd = estimateCostUsd(msg.model ?? null, {
            input_tokens: msg.input_tokens,
            output_tokens: msg.output_tokens,
            cache_creation_input_tokens: msg.cache_creation_input_tokens,
            cache_read_input_tokens: msg.cache_read_input_tokens,
          })
          costSource = 'estimated'
        }
      }
      await recordTokenUsage({
        userId: ws.data.userId,
        sessionId: ws.data.sessionId ?? null,
        model: msg.model ?? null,
        inputTokens: msg.input_tokens,
        outputTokens: msg.output_tokens,
        cacheCreationInputTokens: msg.cache_creation_input_tokens,
        cacheReadInputTokens: msg.cache_read_input_tokens,
        costUsd,
        costSource,
      })
    } catch (err: any) {
      console.error('[agent] usage_event handler failed', err?.message)
    }
    return
  }

  if (msg.type === 'pong') return
}

/**
 * B6: seed the per-supervisor self-capture error_projects row and build the
 * `supervisor.hello_ack` payload carrying its sentry creds.
 *
 * The rootless session is created via the 5-arg `findOrCreateRootlessSession`
 * DAL — `(userId, hostname, cliKind, tokenHashIfCreating, nameIfCreating)`. The
 * token hash is only consumed when the row is first inserted; reusing an
 * existing rootless row ignores it. The hash is derived from a freshly minted
 * `remo_` token via the same `hashToken` helper the Phase-05 rootless-advertise
 * flow uses — never an invented/insecure constant.
 *
 * Guard: a NULL/undefined rootless session id would bind into the NOT-NULL
 * `error_projects.session_id` INSERT and make postgres.js throw
 * `UNDEFINED_VALUE` (the exact regression a prior 2-arg call introduced). When
 * the id is missing we log + return `null` rather than poison the insert.
 *
 * Returns the hello_ack object on success, or `null` when the project can't be
 * seeded (caller skips the ack — crash capture is strictly additive).
 */
export async function seedSupervisorSelfCaptureProject(
  args: { userId: string; hostname: string; supervisorId: string },
  // Deps are injectable so the arity-guard unit test can spy on the exact calls
  // WITHOUT a process-global `mock.module` (which pollutes sibling test files —
  // see hub/test mock-pollution hygiene). Defaults are the real DAL imports.
  deps: {
    findOrCreateRootlessSession?: typeof findOrCreateRootlessSession
    ensureSupervisorProject?: typeof ensureSupervisorProject
  } = {},
): Promise<{ type: 'supervisor.hello_ack'; supervisor_id: string; sentry_key: string; sentry_project_id: string } | null> {
  const { userId, hostname, supervisorId } = args
  const findRootless = deps.findOrCreateRootlessSession ?? findOrCreateRootlessSession
  const ensureProject = deps.ensureSupervisorProject ?? ensureSupervisorProject
  const rawTok = generateToken('remo_')
  const tokenHash = await hashToken(rawTok)
  const rootless = await findRootless(
    userId,
    hostname,
    'claude',
    tokenHash,
    `${hostname} (claude ambient)`,
  )
  if (!rootless?.id) {
    console.warn(`[supervisor] skip ensureSupervisorProject host=${hostname} reason=rootless_session_id_missing`)
    return null
  }
  const proj = await ensureProject(userId, hostname, rootless.id)
  return {
    type: 'supervisor.hello_ack',
    supervisor_id: supervisorId,
    sentry_key: proj.sentry_key,
    sentry_project_id: proj.id,
  }
}

async function handleSupervisorMessage(ws: ServerWebSocket<AgentWsData>, msg: any) {
  const userId = ws.data.userId!
  const apiKeyId = ws.data.apiKeyId!

  if (msg.type === 'supervisor.hello') {
    const row = await upsertSupervisor({
      userId,
      apiKeyId,
      hostname: msg.hostname,
      version: msg.version,
      os: msg.os,
      roots: msg.roots,
    })
    ws.data.supervisorId = row.id
    registerSupervisor({ ws, supervisorId: row.id, userId, apiKeyId, roots: msg.roots, hostname: msg.hostname })
    // Reset state to idle on (re)connect — any previously running session was
    // owned by the supervisor process which has since restarted.
    await updateSupervisorState(row.id, 'idle', null)
    console.log(`[supervisor] hello supervisor=${row.id} host=${msg.hostname} roots=${msg.roots.length}`)

    // B6: seed the per-supervisor self-capture project + ack with the
    // sentry creds so the supervisor's uncaughtException handler can post
    // crash envelopes back to the hub's intake. Best-effort — if either
    // step fails the supervisor just doesn't get crash capture, which is
    // strictly additive and must never tear down the hello flow.
    try {
      const ack = await seedSupervisorSelfCaptureProject({ userId, hostname: msg.hostname, supervisorId: row.id })
      if (ack) {
        try { ws.send(JSON.stringify(ack)) } catch {}
      }
    } catch (err: any) {
      console.warn(`[supervisor] ensureSupervisorProject failed host=${msg.hostname} err=${err?.message ?? err}`)
    }

    // Stale-row reap: each MSI install/upgrade rotates the api_key → new
    // supervisors row. Old rows from prior installs of the SAME host pile up
    // in Settings → Connections. Delete siblings for (user_id, hostname)
    // whose last_seen_at is older than 5 min, excluding the row we just
    // upserted. CASCADE FKs handle dependents.
    try {
      const purged = await cleanupStaleSupervisorRows(userId, msg.hostname, row.id, 5)
      if (purged.deleted_ids.length > 0) {
        console.log(`[supervisor] purged ${purged.deleted_ids.length} stale rows for host=${msg.hostname}`)
      }
    } catch (e) {
      console.error(`[supervisor] stale-row cleanup failed host=${msg.hostname}`, e)
    }

    // Auto-resume: respawn any session_runs that were open (ended_at IS NULL).
    // These were orphaned by a reboot/restart. We end the old run row and send a
    // fresh session.start to the now-online supervisor. The new run reuses the
    // same project_dir, so the UI session row is reused and history persists.
    //
    // Logic is in `hub/src/orchestrator/orphan-resume.ts` — shared with the
    // client-side resume path (web client connect / page refresh).
    // Sacred invariant: sessions whose last finalized run carries
    // `exit_reason='user_stopped'` (Stop button) are NEVER resumed.
    try {
      const { resumeOrphansForSupervisor } = await import('../orchestrator/orphan-resume')
      const r = await resumeOrphansForSupervisor({ userId, supervisorId: row.id })
      if (r.finalized_stale.length > 0) {
        console.log(`[supervisor] auto-resume finalized ${r.finalized_stale.length} stale run(s) older than 24h`)
      }
      if (r.resumed.length > 0) {
        console.log(`[supervisor] auto-resumed ${r.resumed.length} orphan session(s)`)
      }
      if (r.skipped_user_stopped.length > 0) {
        console.log(`[supervisor] auto-resume skipped ${r.skipped_user_stopped.length} user_stopped session(s)`)
      }
      if (r.skipped_max_restarts.length > 0) {
        console.warn(`[supervisor] auto-resume skipped ${r.skipped_max_restarts.length} run(s) reason=max_restarts_exceeded`)
      }
      if (r.skipped_capacity.length > 0) {
        console.warn(`[supervisor] auto-resume skipped ${r.skipped_capacity.length} run(s) reason=capacity`)
      }
    } catch (err: any) {
      console.error('[supervisor] auto-resume failed', err.message)
    }

    // orchestrator-autolaunch: AFTER orphan-resume (which respawns an existing
    // orphaned orchestrator run) auto-launch the orchestrator if the user has
    // it enabled and NO open orchestrator session row exists yet. Idempotent +
    // race-safe (one row per user via idx_sessions_orchestrator_unique). Best-
    // effort — must never tear down the hello flow.
    try {
      const { maybeAutoLaunchOrchestrator } = await import('../orchestrator/auto-launch')
      await maybeAutoLaunchOrchestrator({ userId, supervisorId: row.id })
    } catch (err: any) {
      console.error('[supervisor] orchestrator auto-launch failed', err?.message ?? err)
    }

    broadcastToUser(userId, {
      type: 'supervisor_update',
      supervisor_id: row.id,
      state: 'idle',
      hostname: msg.hostname,
      version: msg.version,
      os: msg.os,
      roots: msg.roots,
    })
    // W2/T12 — drain any scheduled runs parked for this supervisor.
    // Round-2 migration: supervisor-targeted scheduled runs now park in the
    // shared dispatch grace buffer keyed by supervisorId (the dispatcher
    // registers a runNow replay thunk); one drain re-runs them. Replaces the
    // deleted scheduler/grace.ts drainForTarget.
    try {
      const { getGraceBuffer } = await import('../dispatch/grace.ts')
      void getGraceBuffer().drain(row.id)
    } catch {}
    return
  }

  if (!ws.data.supervisorId) return
  const supervisorId = ws.data.supervisorId

  await heartbeatSupervisor(supervisorId)

  if (msg.type === 'supervisor.state') {
    // Plan 04-003 belt-and-suspenders: when the supervisor announces a new
    // running session, the corresponding session_runs row should already exist
    // (the REST/auto-resume paths create it inside the reserveSessionSlot
    // window). Log a warning if it's missing — the gate has been bypassed.
    if (msg.run_id && msg.state !== 'idle' && msg.state !== 'offline') {
      try {
        const { sql } = await import('../db/postgres')
        const rows = await sql`
          SELECT 1 FROM session_runs
          WHERE id = ${msg.run_id} AND supervisor_id = ${supervisorId}
          LIMIT 1
        `
        if (rows.length === 0) {
          console.warn(`[supervisor] state announcement for unreserved run=${msg.run_id} supervisor=${supervisorId}`)
        }
      } catch {}
    }
    // Per-run start-rejection reasons: the SUPERVISOR refused to spawn THIS
    // run (concurrency_cap from its in-process maxConcurrent gate,
    // sandbox_escape, not_git_repo, duplicate_run,
    // legacy_agent_spawn_disabled). The supervisor process itself is still
    // alive and reachable — the failure is scoped to the run, not the
    // supervisor lifecycle. If we propagate `state='stopped'` to the
    // supervisors row, the UI shows the supervisor as down and the row
    // sticks at `stopped` until the next hello/reconnect, even though zero
    // session_runs are actually open. Force state back to 'idle' +
    // clear current_run_id so the row reflects reality.
    //
    // The `SUPERVISOR_START_REJECT_REASONS` / `isStartRejectStateMessage`
    // helpers at the top of this file are the canonical contract — kept in
    // lock-step with `supervisor/src/process-manager.ts` `StartRejection`
    // and asserted in `hub/test/supervisor-stopped-recovery.test.ts`.
    if (msg.last_exit && SUPERVISOR_START_REJECT_REASONS.has(msg.last_exit.reason)) {
      log.warn('supervisor.start_reject', {
        supervisor_id: supervisorId,
        reason: msg.last_exit.reason,
        run_id: msg.run_id ?? null,
      })
      await updateSupervisorState(supervisorId, 'idle', null)
    } else {
      await updateSupervisorState(supervisorId, msg.state, msg.run_id ?? null)
    }
    if (msg.last_exit && msg.run_id) {
      await endRun(msg.run_id, msg.last_exit.code, msg.last_exit.reason)
      // Plan 04-003: a run just ended → recompute capacity + broadcast so the
      // UI re-renders without polling.
      try {
        const snap = await getCapacitySnapshot(userId, supervisorId)
        if (snap) {
          broadcastToUser(userId, {
            type: 'supervisor_capacity_changed',
            supervisor_id: supervisorId,
            running: snap.running,
            cap: snap.cap,
          })
        }
      } catch {}
    }
    return
  }

  if (msg.type === 'supervisor.log') {
    broadcastToUser(userId, {
      type: 'supervisor_log',
      supervisor_id: supervisorId,
      level: msg.level,
      message: msg.message,
      run_id: msg.run_id,
      ts: msg.ts || new Date().toISOString(),
    })
    return
  }

  if (msg.type === 'repo.scan_result' || msg.type === 'repo.op_result') {
    resolveRequest(supervisorId, msg.req_id, msg)
    return
  }

  // Phase 12 W2 — set_roots ack from supervisor → resolve the pending request
  // that the PATCH /api/supervisors/:id/roots handler is awaiting.
  if (msg.type === 'supervisor.set_roots_ack') {
    if (msg.ok) {
      resolveRequest(supervisorId, msg.req_id, msg)
    } else {
      rejectRequest(supervisorId, msg.req_id, msg.error || 'set_roots_failed')
    }
    return
  }

  if (msg.type === 'supervisor.repo_inventory') {
    // Phase 08 §15 (Plan 003 T4): fan inventory into sessions + pending_local_repos.
    try {
      const { findOrCreateAgentSessionV2, upsertPendingLocalRepoBatch } = await import('../db/dal')
      const { setUserInventory } = await import('./supervisor-registry')
      const entry = getSupervisor(supervisorId)
      const hostname = entry?.hostname || ''

      // 1. Cache the inventory so Plan 005's launch/clone-here resolver can read it.
      setUserInventory(userId, {
        scanned_at: msg.scanned_at,
        supervisor_id: supervisorId,
        repos: msg.repos,
        roots: entry?.roots ?? [],
      })

      // 2. Partition: github-keyed → session upsert; everything else → pending_local_repos.
      const githubEntries: any[] = []
      const pendingRows: Array<{ user_id: string; hostname: string; project_dir: string; is_git_repo: boolean }> = []
      for (const repo of msg.repos) {
        if (repo.git_origin_github) {
          githubEntries.push(repo)
        } else if (hostname) {
          pendingRows.push({
            user_id: userId,
            hostname,
            project_dir: repo.local_path,
            is_git_repo: repo.is_git_repo,
          })
        }
      }

      let sessionsTouched = 0
      for (const repo of githubEntries) {
        try {
          // tokenHash=null → no runner bound; session lives in 'offline' until Launch.
          await findOrCreateAgentSessionV2(
            userId,
            repo.local_path,
            null,
            'claude',
            {
              is_git_repo: true,
              is_worktree: repo.is_worktree,
              worktree_parent_path: repo.worktree_parent_path,
              git_remote: repo.git_remote,
              git_origin_github: repo.git_origin_github,
            },
            hostname || null,
          )
          sessionsTouched++
        } catch (err: any) {
          console.warn(`[supervisor] repo_inventory v2 upsert failed local=${repo.local_path} err=${err?.message}`)
        }
      }

      let pendingTouched = 0
      if (pendingRows.length > 0) {
        try {
          pendingTouched = await upsertPendingLocalRepoBatch(pendingRows)
        } catch (err: any) {
          console.warn(`[supervisor] pending_local_repos batch failed err=${err?.message}`)
        }
      }

      console.log(`[supervisor] repo_inventory received supervisor=${supervisorId} repos=${msg.repos.length} sessions=${sessionsTouched} pending=${pendingTouched}`)

      // 3. Push a fresh session_list to the user's connected web clients.
      try {
        const { listSessions } = await import('../db/dal')
        const sessions = await listSessions(userId)
        broadcastToUser(userId, { type: 'session_list', sessions })
      } catch {}
    } catch (err: any) {
      console.error('[supervisor] repo_inventory handler failed', err?.message)
    }
    return
  }

  // Bug A (2026-05-28) — supervisor's live runner inventory. Stored in-memory
  // keyed by supervisor; `GET /api/sessions` folds this into the `active` flag
  // and we broadcast `session_inventory_changed` to the user's web clients so
  // the sidebar refreshes without polling. Empty / pre-0.5.7 supervisors never
  // send this; back-compat path is to fall back to `sessions.status`.
  if (msg.type === 'session_inventory') {
    try {
      const scannedAt = new Date().toISOString()
      const { changedSessionIds, userId: ownerId } = setSupervisorSessionInventory(
        supervisorId,
        msg.sessions,
        scannedAt,
      )
      if (ownerId && changedSessionIds.length > 0) {
        broadcastToUser(ownerId, {
          type: 'session_inventory_changed',
          supervisor_id: supervisorId,
          changed_session_ids: changedSessionIds,
          scanned_at: scannedAt,
        })
      }
      // Ghost-run reconciliation: the inventory we just received is the live
      // runner set. Close any open `session_runs` for this supervisor whose
      // session is no longer hosted, so the Connections "running" dot stops
      // diverging from the (inventory-driven) Sessions list. See
      // finalizeOrphanedRunsForSupervisor for the race-grace rationale.
      const liveIds = msg.sessions.map((s) => s.session_id)
      const closed = await finalizeOrphanedRunsForSupervisor(supervisorId, liveIds)
      if (closed > 0) {
        console.log(`[supervisor] reconciled ${closed} ghost run(s) supervisor=${supervisorId}`)
      }
      // fix/stop-the-bleed — record the supervisor's spawn circuit-breaker state
      // (absent on pre-fix supervisors ⇒ treated as "healthy/unknown", the old
      // behaviour). A NEWLY-open breaker is logged loudly: prod 2026-07 the
      // breaker latched open for FOUR DAYS with zero CLI spawns while the hub
      // reported perfectly healthy. `GET /api/supervisors` surfaces it too.
      const breakers = msg.circuit_breakers ?? []
      const { newlyOpen } = setSupervisorCircuitBreakers(supervisorId, breakers)
      for (const b of newlyOpen) {
        console.error(
          `[supervisor] CIRCUIT BREAKER ${b.state.toUpperCase()} supervisor=${supervisorId} repo=${b.repo_path} ` +
          `failed_probes=${b.failed_probes} exhausted=${b.exhausted} reason=${b.last_reason ?? 'unknown'} — ` +
          `NO CLI will spawn for this repo until it closes`,
        )
      }
    } catch (err: any) {
      console.error('[supervisor] session_inventory handler failed', err?.message)
    }
    return
  }

  if (msg.type === 'supervisor.commands_sync') {
    try {
      await replaceSupervisorCommands({ userId, supervisorId, commands: msg.commands })
      console.log(`[supervisor] commands sync supervisor=${supervisorId} count=${msg.commands.length}`)
      broadcastToUser(userId, { type: 'commands_updated', supervisor_id: supervisorId, count: msg.commands.length })
    } catch (err: any) {
      console.error('[supervisor] commands sync failed', err.message)
    }
    return
  }

  if (msg.type === 'repo.clone_progress') {
    broadcastToUser(userId, {
      type: 'repo_clone_progress',
      supervisor_id: supervisorId,
      req_id: msg.req_id,
      stage: msg.stage,
      percent: msg.percent,
    })
    return
  }

  // Phase 04 plan 002 — host_resources budget snapshot.
  // Persist to the auth'd supervisor row (NEVER trust an id in the payload)
  // and broadcast to the user's clients so the budget chip updates live.
  if (msg.type === 'host_resources') {
    try {
      const { updateSupervisorResources } = await import('../db/supervisor-dal')
      const row = await updateSupervisorResources({
        supervisorId,
        cpuCores: msg.cpu_cores,
        totalMemMb: msg.total_mem_mb,
        freeMemMb: msg.free_mem_mb,
        concurrencyBudget: msg.concurrency_budget,
        budgetSource: msg.source,
      })
      if (row) {
        broadcastToUser(userId, {
          type: 'supervisor_resources_updated',
          supervisor_id: supervisorId,
          cpu_cores: row.cpu_cores,
          total_mem_mb: row.total_mem_mb,
          free_mem_mb: row.free_mem_mb,
          concurrency_budget: row.concurrency_budget,
          concurrency_override: row.concurrency_override,
          budget_source: row.budget_source,
          budget_updated_at: row.budget_updated_at instanceof Date
            ? row.budget_updated_at.toISOString()
            : String(row.budget_updated_at),
        })
      }
    } catch (err: any) {
      console.error('[supervisor] host_resources persist failed', err?.message)
    }
    return
  }

  // Phase 08 §6 — create-local-repo-and-push progress/failure from supervisor.
  // Map supervisor stages onto the hub job model + broadcast to web clients.
  if (msg.type === 'repo_create_progress') {
    try {
      const { applySupervisorProgress } = await import('../lib/github-repo-job')
      applySupervisorProgress(msg.job_id, msg.stage)
    } catch (err: any) {
      console.error('[supervisor] repo_create_progress handler failed', err?.message)
    }
    return
  }
  if (msg.type === 'repo_create_failed') {
    try {
      const { getJob, failJob } = await import('../lib/github-repo-job')
      const job = getJob(msg.job_id)
      if (job) failJob(msg.job_id, job.stage, msg.error || `failed at ${msg.stage}`)
    } catch (err: any) {
      console.error('[supervisor] repo_create_failed handler failed', err?.message)
    }
    return
  }

  // W2/T10 — scheduled-run lifecycle from supervisor.
  if (msg.type === 'run_started' || msg.type === 'run_output' || msg.type === 'run_finished') {
    try {
      const sup = await import('../scheduler/senders/supervisor.ts')
      await sup.handleSupervisorRunEvent(supervisorId, userId, msg)
    } catch (err: any) {
      console.error('[supervisor] run event handler failed', err?.message)
    }
    // TEAB-05: the same run lifecycle drives the hub-side TEAB poll-to-terminal
    // loop. Each handler ignores run ids it doesn't own, so calling both is safe.
    try {
      const teab = await import('../scheduler/senders/teab.ts')
      await teab.handleTeabRunEvent(supervisorId, userId, msg)
    } catch (err: any) {
      console.error('[supervisor] teab run event handler failed', err?.message)
    }
    // Milestone ASK Phase 1: the same run lifecycle carries the READ-ONLY
    // session_transcript_tail / session_memory replies. Ignores foreign run ids.
    try {
      const ext = await import('../ext/supervisor-read.ts')
      ext.handleExtRunEvent(supervisorId, userId, msg)
    } catch (err: any) {
      console.error('[supervisor] ext read event handler failed', err?.message)
    }
    return
  }
}

export async function handleAgentClose(ws: ServerWebSocket<AgentWsData>) {
  log.info('agent.closed', { role: ws.data.role, session_id: ws.data.sessionId, supervisor_id: ws.data.supervisorId })
  if (ws.data.authTimer) clearTimeout(ws.data.authTimer)
  if (ws.data.heartbeatTimer) clearInterval(ws.data.heartbeatTimer)

  if (ws.data.role === 'supervisor' && ws.data.supervisorId) {
    // Drop streaming state for any session this socket was advancing (legacy
    // path where supervisor wrote ws.data.sessionId). Supervisor sockets that
    // multiplex sessions don't carry a single sessionId — those entries are
    // cleared elsewhere by the next text_delta replacing placeholder state.
    if (ws.data.sessionId) streamingBySession.delete(ws.data.sessionId)
    // Bundle 3: finalize any open session_runs for this supervisor so they
    // don't sit as zombies forever after a socket close.
    try {
      const { finalizeOpenRunsForSupervisor } = await import('../db/supervisor-dal')
      await finalizeOpenRunsForSupervisor(ws.data.supervisorId)
    } catch (err: any) {
      log.warn('agent.finalize_open_runs_failed', { supervisor_id: ws.data.supervisorId, error: err?.message })
    }
    // Pass the closing ws so unregister can ignore stale closes from sockets
    // that have already been replaced by a reconnect.
    unregisterSupervisor(ws.data.supervisorId, ws)
    return
  }

  if (ws.data.sessionId) {
    unregisterChannel(ws.data.sessionId)
    streamingBySession.delete(ws.data.sessionId)
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
      broadcastToUser(ws.data.userId, {
        type: 'session_list',
        sessions: await listSessionsForUser(ws.data.userId),
      })
    }
  }
}

async function listSessionsForUser(userId: string) {
  return listSessions(userId)
}
