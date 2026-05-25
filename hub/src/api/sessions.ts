import { Hono } from 'hono'
import { z } from 'zod'
import { createSession, listSessions, getSession, deleteSession, updateSessionToken, markSessionDisconnected } from '../db/dal'
import { getMessagesForSessions } from '../db/chat-tabs-dal.ts'
import { hashToken } from '../lib/crypto'
import { getChannel } from '../ws/registry'
import { generateToken } from '../utils/token'

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

export { sessions }
