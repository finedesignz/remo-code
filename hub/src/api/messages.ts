import { Hono } from 'hono'
import { getMessages, getSession } from '../db/dal'

const messages = new Hono()

// Get paginated messages for a session
messages.get('/:sessionId', async (c) => {
  const sb = c.get('supabase')
  const sessionId = c.req.param('sessionId')
  const limit = Math.min(Number(c.req.query('limit') || 50), 100)
  const before = c.req.query('before') || undefined

  // Verify session ownership via RLS
  try {
    await getSession(sb, sessionId)
  } catch {
    return c.json({ error: 'not found' }, 404)
  }

  const data = await getMessages(sb, sessionId, limit, before)
  return c.json(data)
})

export { messages }
