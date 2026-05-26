import { Hono } from 'hono'
import { z } from 'zod'
import { createSession, listSessions, getSession, deleteSession, updateSessionToken, markSessionDisconnected } from '../db/dal'
import { getMessagesForSessions } from '../db/chat-tabs-dal.ts'
import { hashToken } from '../lib/crypto'
import { getChannel } from '../ws/registry'
import { generateToken } from '../utils/token'
import { pickSessionTarget } from '../sessions/routing.ts'
import { createRun } from '../db/supervisor-dal.ts'
import { sendToSupervisor, updateSupervisorState } from '../ws/supervisor-registry.ts'
import { releaseSessionSlot } from '../sessions/budget.ts'

const CreateSessionBody = z.object({
  name: z.string().min(1).max(100).trim(),
  project_dir: z.string().max(500).optional(),
})

// Hard cap on the number of session ids a single batch-messages request can
// fetch. Matches the WS subscribe cap (PLAN-002, SUBSCRIBE_MAX=12).
const BATCH_MESSAGES_MAX_IDS = 12
const BATCH_MESSAGES_DEFAULT_LIMIT = 30
const BATCH_MESSAGES_MAX_LIMIT = 100

const sessions = new Hono()

// List all sessions for the authenticated user
sessions.get('/', async (c) => {
  const userId = c.get('userId') as string
  const data = await listSessions(userId)
  return c.json(data)
})

// Batch-fetch messages for up to 12 sessions at once. Used by the multichat
// grid view to hydrate every cell with one round-trip per tab activation.
// MUST be declared BEFORE the `/:id` GET so it isn't captured as a session id.
sessions.get('/messages', async (c) => {
  const userId = c.get('userId') as string
  const idsParam = c.req.query('ids') ?? ''
  const limitParam = c.req.query('limit')
  const ids = idsParam.split(',').map((s) => s.trim()).filter(Boolean)
  if (ids.length === 0) return c.json({})
  if (ids.length > BATCH_MESSAGES_MAX_IDS) {
    return c.json({ error: 'too_many_sessions', max: BATCH_MESSAGES_MAX_IDS }, 400)
  }
  let limit = BATCH_MESSAGES_DEFAULT_LIMIT
  if (limitParam !== undefined) {
    const n = Number(limitParam)
    if (!Number.isInteger(n) || n < 1) {
      return c.json({ error: 'invalid_limit' }, 400)
    }
    limit = Math.min(n, BATCH_MESSAGES_MAX_LIMIT)
  }
  // DAL filters by user_id — sessions not owned by the caller are silently
  // dropped, so the response simply omits them (no existence leak).
  const grouped = await getMessagesForSessions(userId, ids, limit)
  return c.json(grouped)
})

// Get a single session
sessions.get('/:id', async (c) => {
  const userId = c.get('userId') as string
  const session = await getSession(c.req.param('id'), userId)
  if (!session) return c.json({ error: 'not found' }, 404)
  return c.json(session)
})

// Create a new session — returns the raw token ONCE
sessions.post('/', async (c) => {
  const userId = c.get('userId') as string
  const parsed = CreateSessionBody.safeParse(await c.req.json())
  if (!parsed.success) {
    return c.json({ error: 'invalid input' }, 400)
  }

  const rawToken = generateToken('remo_')
  const tokenHash = await hashToken(rawToken)

  const session = await createSession(userId, parsed.data.name, parsed.data.project_dir || null, tokenHash)

  return c.json({ ...session, token: rawToken }, 201)
})

// Disconnect / delete a session.
// 1. Tell the connected agent to shut down (kill Claude subprocess + close WS + exit).
// 2. Soft-delete the row so the agent cannot resurrect it via findOrCreateAgentSession.
// 3. Close the channel.
sessions.delete('/:id', async (c) => {
  const userId = c.get('userId') as string
  const sessionId = c.req.param('id')
  try {
    const channel = getChannel(sessionId)
    if (channel) {
      try { channel.ws.send(JSON.stringify({ type: 'shutdown', reason: 'user_disconnect' })) } catch {}
    }
    await markSessionDisconnected(sessionId, userId)
    // Give the agent ~5s to gracefully exit before forcibly closing the socket.
    setTimeout(() => {
      const ch = getChannel(sessionId)
      if (ch) {
        try { ch.ws.close(4010, 'session disconnected') } catch {}
      }
    }, 5_000)
    return c.json({ ok: true })
  } catch {
    return c.json({ error: 'not found' }, 404)
  }
})

// Rotate session token — returns new raw token, invalidates old
sessions.post('/:id/rotate-token', async (c) => {
  const userId = c.get('userId') as string
  const sessionId = c.req.param('id')

  // Verify ownership
  const session = await getSession(sessionId, userId)
  if (!session) return c.json({ error: 'not found' }, 404)

  const rawToken = generateToken('remo_')
  const tokenHash = await hashToken(rawToken)
  await updateSessionToken(sessionId, tokenHash)

  // Close existing channel connection
  const channel = getChannel(sessionId)
  if (channel) {
    try { channel.ws.close(4004, 'token rotated') } catch {}
  }

  return c.json({ token: rawToken })
})

// ── Phase 04 plan 008 — POST /api/sessions/heal ──────────────────────────────
// The external claude-code-self-heal service (port 9114) calls this to launch
// a fresh session on whatever target is available, deterministically. See
// docs/self-heal-integration.md for the consumer contract.
const HealBody = z.object({
  repo: z.string().min(1).max(500),
  branch: z.string().min(1).max(200),
  prompt: z.string().min(1).max(20_000),
  model: z.string().max(120).optional(),
  exclude_supervisor_ids: z.array(z.string()).max(20).optional(),
})

const HEAL_MAX_HOPS = 3

sessions.post('/heal', async (c) => {
  const userId = c.get('userId') as string
  const parsed = HealBody.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) {
    return c.json({ error: 'invalid_input', detail: parsed.error.issues[0]?.message }, 400)
  }
  const { repo, branch, prompt, model } = parsed.data

  // Build a mutable exclude list so we can extend it on WS dispatch failure
  // and re-route to the next supervisor (up to HEAL_MAX_HOPS attempts).
  const exclude = new Set<string>(parsed.data.exclude_supervisor_ids ?? [])

  for (let hop = 0; hop < HEAL_MAX_HOPS; hop++) {
    const pick = await pickSessionTarget(userId, {
      excludeSupervisorIds: Array.from(exclude),
    })

    if (pick.kind === 'quota_blocked') {
      return c.json({
        error: 'quota_threshold_reached',
        reason: pick.reason,
        utilization_pct: pick.utilization_pct,
        threshold_pct: pick.threshold_pct,
        resets_at: pick.resets_at,
      }, 503)
    }

    if (pick.kind === 'none') {
      return c.json({ error: 'no_target_available' }, 503)
    }

    if (pick.kind === 'supervisor') {
      // Reservation is held — must release on dispatch failure.
      let run: { id: string }
      try {
        run = await createRun({
          userId,
          sessionId: null,
          supervisorId: pick.supervisor_id,
          repoPath: repo,
          branch,
          pulled: false,
          initialPrompt: prompt,
        }) as { id: string }
      } catch (err: any) {
        await releaseSessionSlot(userId, pick.supervisor_id)
        return c.json({ error: 'run_insert_failed', detail: err?.message ?? String(err) }, 500)
      }

      try {
        sendToSupervisor(pick.supervisor_id, {
          type: 'session.start',
          req_id: run.id,
          run_id: run.id,
          repo_path: repo,
          branch,
          pull: false,
          initial_prompt: prompt,
          api_key: '__use_local__',
          hub_url: '__same__',
          ...(model ? { model } : {}),
        } as any)
      } catch (err: any) {
        // WS write failed — release the slot and the run row, then exclude
        // this supervisor from the next hop and retry.
        try {
          const { endRun } = await import('../db/supervisor-dal.ts')
          await endRun(run.id, null, `dispatch_failed: ${err?.message ?? 'unknown'}`)
        } catch {}
        await releaseSessionSlot(userId, pick.supervisor_id)
        exclude.add(pick.supervisor_id)
        continue
      }

      try { await updateSupervisorState(pick.supervisor_id, 'starting', run.id) } catch {}

      return c.json({
        session_id: run.id,
        target_kind: 'supervisor' as const,
        supervisor_id: pick.supervisor_id,
        url: `/s/${run.id}`,
      }, 202)
    }

    // pick.kind === 'local_agent'
    return c.json({
      session_id: pick.agent_session_id,
      target_kind: 'local_agent' as const,
      url: `/s/${pick.agent_session_id}`,
    }, 202)
  }

  // Exhausted hop budget — every supervisor we tried failed to dispatch.
  return c.json({ error: 'no_target_available', reason: 'all_dispatches_failed' }, 503)
})

export { sessions }
