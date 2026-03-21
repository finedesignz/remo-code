import { Hono } from 'hono'
import { z } from 'zod'
import { createSession, listSessions, getSession, deleteSession, updateSessionToken } from '../db/dal'
import { generateSecureToken, hashToken } from '../lib/crypto'
import { getChannel } from '../ws/registry'
import { supabaseAdmin } from '../db/supabase'
import { TIER_LIMITS } from '../config'

const CreateSessionBody = z.object({
  name: z.string().min(1).max(100).trim(),
  project_dir: z.string().max(500).optional(),
})

const sessions = new Hono()

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
  const parsed = CreateSessionBody.safeParse(await c.req.json())
  if (!parsed.success) {
    return c.json({ error: 'invalid input' }, 400)
  }

  // Check session limit based on tier
  const [{ data: prof }, { count }] = await Promise.all([
    supabaseAdmin.from('profiles').select('tier').eq('id', userId).single(),
    supabaseAdmin.from('sessions').select('id', { count: 'exact', head: true }).eq('user_id', userId),
  ])
  const tier = prof?.tier || 'free'
  const limit = TIER_LIMITS[tier] || 1

  if (limit !== -1 && (count || 0) >= limit) {
    return c.json({ error: 'session limit reached', tier, limit, current: count }, 403)
  }

  const rawToken = generateSecureToken('remo_')
  const tokenHash = await hashToken(rawToken)

  const session = await createSession(sb, userId, parsed.data.name, parsed.data.project_dir || null, tokenHash)

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

  const rawToken = generateSecureToken('remo_')
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
