import { Hono } from 'hono'
import { z } from 'zod'
import { createPluginSession } from '../db/dal'
import { hashToken } from '../lib/crypto'
import { generateToken } from '../utils/token'

const plugin = new Hono()

const PluginSessionBody = z.object({
  project_dir: z.string().min(1).max(500),
})

// Verify API key is valid
plugin.get('/verify', (c) => {
  return c.json({ ok: true, user_id: c.get('userId') })
})

// Create a new session for this plugin connection
plugin.post('/sessions', async (c) => {
  const userId = c.get('userId')
  const parsed = PluginSessionBody.safeParse(await c.req.json())
  if (!parsed.success) {
    return c.json({ error: 'project_dir is required' }, 400)
  }

  try {
    // Normalize Windows backslashes to forward slashes for consistent storage/lookup
    const projectDir = parsed.data.project_dir.replace(/\\/g, '/')
    const rawToken = generateToken('remo_')
    const tokenHash = await hashToken(rawToken)
    const result = await createPluginSession(userId, projectDir, tokenHash)

    return c.json(
      { session_id: result.id, token: rawToken, name: result.name },
      201,
    )
  } catch (err: any) {
    console.error('[plugin/sessions]', err)
    return c.json({ error: 'session creation failed' }, 500)
  }
})

export { plugin }
