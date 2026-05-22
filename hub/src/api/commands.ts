import { Hono } from 'hono'
import { listCommandsForUser } from '../db/supervisor-dal'

export const commands = new Hono()

commands.get('/', async (c) => {
  const userId = c.get('userId') as string
  const rows = await listCommandsForUser(userId)
  return c.json({ commands: rows })
})
