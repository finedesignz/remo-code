import type { ServerWebSocket } from 'bun'
import { AgentInbound } from './agent-protocol'
import { verifyApiKey, findOrCreateAgentSession, findOrCreateAgentSessionV2, findOrCreateRootlessSession, updateSessionStatus as setSessionStatus, insertMessage, insertAssistantPlaceholder, appendToMessage, finalizeMessage, listSessions, getUserSystemPrompt, getUserInstructions, recentlyDisconnectedForProjectDir, updateSessionAgentInfo } from '../db/dal'
import { createHash } from 'crypto'
import { hashToken } from '../lib/crypto'
import { generateToken } from '../utils/token'
import { registerChannel, unregisterChannel, getChannel, broadcastToSubscribers, broadcastToUser } from './registry'
import { verifyApiKeyWithCapability, upsertSupervisor, endRun, replaceSupervisorCommands } from '../db/supervisor-dal'
import { reserveSessionSlot, getCapacitySnapshot } from '../sessions/budget'
import {
  registerSupervisor, unregisterSupervisor, resolveRequest, rejectRequest,
  updateSupervisorState, heartbeatSupervisor, getSupervisor,
} from './supervisor-registry'

const AUTH_TIMEOUT_MS = 5_000
const HEARTBEAT_INTERVAL_MS = 30_000
const RATE_LIMIT = { max: 120, windowMs: 10_000 }

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
    console.error(`[agent] flushStreaming error session=${sessionId}`, err.message)
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

  const result = AgentInbound.safeParse(parsed)
  if (!result.success) {
    // Surface schema rejections so silent drops don't masquerade as connection
    // failures. Truncate payload preview to keep logs readable.
    const t = (parsed as any)?.type ?? 'unknown'
    const preview = JSON.stringify(parsed).slice(0, 200)
    console.warn(`[agent] schema reject type=${t} authenticated=${ws.data.authenticated} role=${ws.data.role} errors=${result.error.issues.map(i => `${i.path.join('.')}:${i.message}`).join('; ')} payload=${preview}`)
    return
  }
  const msg = result.data

  // --- Auth ---
  if (msg.type === 'auth') {
    if (ws.data.authenticated) return
    const keyHash = await hashToken(msg.api_key)

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
            console.warn(`[supervisor] auth fail reason=not_found hash=${keyHash.slice(0,8)}...`)
            break
          case 'revoked':
            closeReason = 'api_key_revoked'
            errorMsg = 'api key revoked'
            console.warn(`[supervisor] auth fail reason=revoked hash=${keyHash.slice(0,8)}...`)
            break
          case 'deleted':
            closeReason = 'api_key_not_found'
            errorMsg = 'api key not found'
            console.warn(`[supervisor] auth fail reason=deleted hash=${keyHash.slice(0,8)}...`)
            break
          case 'missing_capability':
            closeReason = 'missing_supervisor_capability'
            errorMsg = `missing capability: need=${verified.need} have=${JSON.stringify(verified.have)}`
            console.warn(`[supervisor] auth fail reason=missing_capability need=${verified.need} have=${JSON.stringify(verified.have)}`)
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
      console.warn(`[agent] auth fail reason=invalid_api_key hash=${keyHash.slice(0, 8)}... host=${msg.hostname ?? 'unknown'}`)
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
      console.warn(`[agent] auth fail reason=no_project_or_rootless user=${userId} host=${msg.hostname ?? 'unknown'}`)
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
    const session = await findOrCreateAgentSessionV2(
      userId,
      projectDir,
      tokenHash,
      cliKind,
      gitInput,
      msg.hostname ?? null,
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
    await setSessionStatus(session.id, 'online')

    // Persist agent host info (OS, CPU, RAM, runtime versions) for the Settings UI.
    if ((msg as any).agent_info) {
      const info = { ...(msg as any).agent_info, hostname: (msg as any).agent_info.hostname || msg.hostname }
      try { await updateSessionAgentInfo(session.id, info) } catch (e: any) {
        console.error('[agent] failed to persist agent_info', e?.message)
      }
    } else if (msg.hostname) {
      try { await updateSessionAgentInfo(session.id, { hostname: msg.hostname }) } catch {}
    }

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
    // W2/T12 — drain any scheduled runs parked for this session.
    try {
      const g = await import('../scheduler/grace.ts')
      void g.drainForTarget(session.id, userId)
    } catch {}
    // W3/T4 — drain any error-capture errors parked for this session.
    try {
      const eg = await import('../error-capture/grace.ts')
      void eg.drainForSession(session.id)
    } catch {}
    // Phase 08 — drain any revanote annotations parked for this session.
    try {
      const rg = await import('../revanote/grace.ts')
      void rg.drainForSession(session.id)
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
  }

  if (msg.type === 'status') {
    const dbStatus = msg.state === 'idle' ? 'online' : 'thinking'
    await setSessionStatus(sessionId, dbStatus as any)
    broadcastToSubscribers(sessionId, msg)
    broadcastToUser(ws.data.userId!, { type: 'session_status', session_id: sessionId, status: dbStatus })
    // W2/T6 — promote a waiting scheduled run on thinking→idle transition.
    if (msg.state === 'idle') {
      try {
        const { onSessionIdleAndPromote } = await import('../scheduler/session-queue.ts')
        onSessionIdleAndPromote(sessionId)
      } catch {}
    }
  }

  if (msg.type === 'assistant_message') {
    console.log(`[agent] assistant_message session=${sessionId} len=${msg.content.length}`)
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
      broadcastToSubscribers(sessionId, {
        type: 'message',
        session_id: sessionId,
        message,
      })
    }
    // V2 — finalize any pending scheduled run for this session.
    try {
      const mod = await import('../scheduler/senders/agent.ts')
      void mod.onAssistantMessage(sessionId, msg.content)
    } catch {}
    // Phase 06 plan 008 — finalize any pending triage run for this session.
    try {
      const tri = await import('../scheduler/senders/triage.ts')
      if (tri.triageActiveForSession(sessionId)) {
        void tri.onTriageAssistantMessage(sessionId, msg.content)
      }
    } catch {}
    // W3 — finalize any in-flight error-capture run for this session.
    try {
      const ec = await import('../error-capture/run-lifecycle.ts')
      if (ec.errorRunActiveForSession(sessionId)) {
        void ec.onAgentReply(sessionId, msg.content)
      }
    } catch {}
    // Phase 08 — finalize any in-flight revanote annotation run for this session.
    try {
      const rev = await import('../revanote/run-lifecycle.ts')
      if (rev.annotationRunActiveForSession(sessionId)) {
        void rev.onAgentReply(sessionId, msg.content)
      }
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

  if (msg.type === 'pong') return
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

    // Auto-resume: respawn any session_runs that were open (ended_at IS NULL).
    // These were orphaned by a reboot/restart. We end the old run row and send a
    // fresh session.start to the now-online supervisor. The new run reuses the
    // same project_dir, so the UI session row is reused and history persists.
    //
    // Guards added 2026-05-27 after the autonomous-loop RCA:
    //   1. AGE CAP — only resume runs that started in the last 24h. Older
    //      open rows are stale carryovers from a long-gone session; replaying
    //      them produces zombie sessions the user has forgotten about.
    //   2. RESTART CAP — when restart_count >= 10, finalize the run as
    //      `max_restarts_exceeded` and skip the replay. Prevents the hub from
    //      feeding the same broken spawn back into the supervisor over and
    //      over after a reconnect.
    try {
      const { sql } = await import('../db/postgres')
      const MAX_RESTART_COUNT = 10
      const orphans = await sql`
        SELECT id, repo_path, branch, initial_prompt, restart_count, started_at
        FROM session_runs
        WHERE supervisor_id = ${row.id}
          AND ended_at IS NULL
          AND started_at > now() - interval '24 hours'
        ORDER BY started_at ASC
      `
      // Sweep any open rows that fell outside the 24h window — finalize them
      // as `stale` so they don't reappear on the next reconnect.
      const staleSweep = await sql`
        UPDATE session_runs
        SET ended_at = now(), exit_reason = 'stale'
        WHERE supervisor_id = ${row.id}
          AND ended_at IS NULL
          AND started_at <= now() - interval '24 hours'
        RETURNING id
      `
      if (staleSweep.length > 0) {
        console.log(`[supervisor] auto-resume finalized ${staleSweep.length} stale run(s) older than 24h`)
      }
      if (orphans.length > 0) {
        console.log(`[supervisor] auto-resuming ${orphans.length} orphan session(s)`)
        for (const o of orphans) {
          // Restart-count cap — if this run has already been restarted too
          // many times, finalize it instead of replaying. Stops runaway loops.
          if (typeof o.restart_count === 'number' && o.restart_count >= MAX_RESTART_COUNT) {
            await sql`
              UPDATE session_runs
              SET ended_at = now(), exit_reason = 'max_restarts_exceeded'
              WHERE id = ${o.id}
            `
            console.warn(`[supervisor] auto-resume skipped run=${o.id} reason=max_restarts_exceeded restart_count=${o.restart_count}`)
            continue
          }
          // End the orphan FIRST so it doesn't count against the cap when we
          // reserve a slot for its replacement.
          await sql`UPDATE session_runs SET ended_at = now(), exit_reason = 'reboot' WHERE id = ${o.id}`
          // Plan 04-003: hub-authoritative gate. Skip auto-resume when at cap
          // (a paused override or budget reduction since last boot). The orphan
          // already ended above so the user can manually start it later.
          const reservation = await reserveSessionSlot(userId, row.id)
          if (!reservation.ok) {
            console.warn(`[supervisor] auto-resume skipped run=${o.id} reason=${reservation.reason}`)
            continue
          }
          const newRun = await sql`
            INSERT INTO session_runs (user_id, supervisor_id, repo_path, branch, pulled, initial_prompt, restart_of)
            VALUES (${userId}, ${row.id}, ${o.repo_path}, ${o.branch}, false, ${null}, ${o.id})
            RETURNING id
          `
          const newRunId = newRun[0].id
          try {
            ws.send(JSON.stringify({
              type: 'session.start',
              req_id: newRunId,
              run_id: newRunId,
              repo_path: o.repo_path,
              branch: o.branch ?? undefined,
              pull: false,
              api_key: '__use_local__',
              hub_url: '__same__',
            }))
          } catch (err: any) {
            console.error('[supervisor] auto-resume send failed', err.message)
          }
        }
      }
    } catch (err: any) {
      console.error('[supervisor] auto-resume query failed', err.message)
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
    try {
      const g = await import('../scheduler/grace.ts')
      void g.drainForTarget(row.id, userId)
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
    await updateSupervisorState(supervisorId, msg.state, msg.run_id ?? null)
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

  // W2/T10 — scheduled-run lifecycle from supervisor.
  if (msg.type === 'run_started' || msg.type === 'run_output' || msg.type === 'run_finished') {
    try {
      const sup = await import('../scheduler/senders/supervisor.ts')
      await sup.handleSupervisorRunEvent(supervisorId, userId, msg)
    } catch (err: any) {
      console.error('[supervisor] run event handler failed', err?.message)
    }
    return
  }
}

export async function handleAgentClose(ws: ServerWebSocket<AgentWsData>) {
  console.log(`[agent] closed role=${ws.data.role} session=${ws.data.sessionId} supervisor=${ws.data.supervisorId}`)
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
      console.warn(`[agent] finalizeOpenRunsForSupervisor failed supervisor=${ws.data.supervisorId} err=${err?.message}`)
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
