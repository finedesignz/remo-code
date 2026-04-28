import { Hono } from 'hono'
import { listMessages, getSession } from '../db/dal'

const messages = new Hono()

// Get messages for a session (ownership verified via userId)
messages.get('/:sessionId', async (c) => {
  const userId = c.get('userId') as string
  const sessionId = c.req.param('sessionId')

  // Verify session ownership
  const session = await getSession(sessionId, userId)
  if (!session) return c.json({ error: 'not found' }, 404)

  const data = await listMessages(sessionId, userId)
  return c.json(data)
})

export { messages }
