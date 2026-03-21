import { Hono } from 'hono'
import { z } from 'zod'
import { findOrCreateSession } from '../db/dal'
import { generateSecureToken, hashToken } from '../lib/crypto'
import { getChannel } from '../ws/registry'
import { supabaseAdmin } from '../db/supabase'
import { TIER_LIMITS } from '../config'

const plugin = new Hono()

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
    // Check if this is a new session (not reconnecting existing)
    const { data: existingSession } = await supabaseAdmin
      .from('sessions')
      .select('id')
      .eq('user_id', userId)
      .eq('project_dir', parsed.data.project_dir)
      .maybeSingle()

    if (!existingSession) {
      // New session — check tier limit
      const [{ data: prof }, { count }] = await Promise.all([
        supabaseAdmin.from('profiles').select('tier').eq('id', userId).single(),
        supabaseAdmin.from('sessions').select('id', { count: 'exact', head: true }).eq('user_id', userId),
      ])
      const tier = prof?.tier || 'free'
      const limit = TIER_LIMITS[tier] || 1

      if (limit !== -1 && (count || 0) >= limit) {
        return c.json({ error: 'session limit reached', tier, limit, current: count }, 403)
      }
    }

    const rawToken = generateSecureToken('remo_')
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
