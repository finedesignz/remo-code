import { Hono } from 'hono'
import { z } from 'zod'
import { findOrCreateSession } from '../db/dal'
import { hashToken } from '../ws/channel'
import { getChannel } from '../ws/registry'

const plugin = new Hono()

function generateToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  const b64 = btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  return `remo_${b64}`
}

const PluginSessionBody = z.object({
  project_dir: z.string().min(1).max(500),
})

// Verify API key is valid
plugin.get('/verify', (c) => {
  return c.json({ ok: true, user_id: c.get('userId') })
})

// Auto-create or reconnect a session
plugin.post('/sessions', async (c) => {
  const userId = c.get('userId')
  const parsed = PluginSessionBody.safeParse(await c.req.json())
  if (!parsed.success) {
    return c.json({ error: 'project_dir is required' }, 400)
  }

  try {
    const rawToken = generateToken()
    const tokenHash = await hashToken(rawToken)
    const result = await findOrCreateSession(userId, parsed.data.project_dir, tokenHash)

    // If reusing existing session, close old channel connection
    if (!result.created) {
      const channel = getChannel(result.id)
      if (channel) {
        try { channel.ws.close(4004, 'token rotated') } catch {}
      }
    }

    return c.json(
      { session_id: result.id, token: rawToken, name: result.name },
      result.created ? 201 : 200,
    )
  } catch (err: any) {
    console.error('[plugin/sessions]', err)
    return c.json({ error: 'session creation failed', detail: err.message }, 500)
  }
})

export { plugin }
