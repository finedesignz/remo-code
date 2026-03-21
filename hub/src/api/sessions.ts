import { Hono } from 'hono'
import { createSession, listSessions, getSession, deleteSession, updateSessionToken } from '../db/dal'
import { hashToken } from '../ws/channel'
import { getChannel } from '../ws/registry'

const sessions = new Hono()

function generateToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  const b64 = btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  return `remo_${b64}`
}

// List all sessions for the authenticated user
sessions.get('/', async (c) => {
  const sb = c.get('supabase')
  const data = await listSessions(sb)
  return c.json(data)
})

// Get a single session
sessions.get('/:id', async (c) => {
  const sb = c.get('supabase')
  try {
    const session = await getSession(sb, c.req.param('id'))
    return c.json(session)
  } catch {
    return c.json({ error: 'not found' }, 404)
  }
})

// Create a new session — returns the raw token ONCE
sessions.post('/', async (c) => {
  const sb = c.get('supabase')
  const userId = c.get('userId')
  const body = await c.req.json<{ name: string; project_dir?: string }>()

  if (!body.name || typeof body.name !== 'string') {
    return c.json({ error: 'name is required' }, 400)
  }

  const rawToken = generateToken()
  const tokenHash = await hashToken(rawToken)

  const session = await createSession(sb, userId, body.name, body.project_dir || null, tokenHash)

  return c.json({ ...session, token: rawToken }, 201)
})

// Delete a session
sessions.delete('/:id', async (c) => {
  const sb = c.get('supabase')
  try {
    await deleteSession(sb, c.req.param('id'))
    return c.json({ ok: true })
  } catch {
    return c.json({ error: 'not found' }, 404)
  }
})

// Rotate session token — returns new raw token, invalidates old
sessions.post('/:id/rotate-token', async (c) => {
  const sb = c.get('supabase')
  const sessionId = c.req.param('id')

  // Verify ownership
  try {
    await getSession(sb, sessionId)
  } catch {
    return c.json({ error: 'not found' }, 404)
  }

  const rawToken = generateToken()
  const tokenHash = await hashToken(rawToken)
  await updateSessionToken(sb, sessionId, tokenHash)

  // Close existing channel connection
  const channel = getChannel(sessionId)
  if (channel) {
    try { channel.ws.close(4004, 'token rotated') } catch {}
  }

  return c.json({ token: rawToken })
})

export { sessions }
