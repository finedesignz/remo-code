import { Hono } from 'hono'
import { z } from 'zod'
import { createSession, listSessions, getSession, deleteSession, updateSessionToken, markSessionDisconnected } from '../db/dal'
import { hashToken } from '../lib/crypto'
import { getChannel } from '../ws/registry'
import { generateToken } from '../utils/token'

const CreateSessionBody = z.object({
  name: z.string().min(1).max(100).trim(),
  project_dir: z.string().max(500).optional(),
})

const sessions = new Hono()

// List all sessions for the authenticated user
sessions.get('/', async (c) => {
  const userId = c.get('userId') as string
  const data = await listSessions(userId)
  return c.json(data)
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
