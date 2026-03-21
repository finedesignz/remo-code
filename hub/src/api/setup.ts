import { Hono } from 'hono'
import { z } from 'zod'
import { supabaseAdmin } from '../db/supabase'
import { rateLimit } from '../middleware/rate-limit'

const setup = new Hono()

const SetupBody = z.object({
  email: z.string().email().max(255),
  password: z.string().min(8).max(128),
})

// Strict rate limit on setup endpoints (5 req/min by IP)
setup.use('*', rateLimit({
  windowMs: 60_000,
  max: 5,
  keyFn: (c) => `setup:${c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || 'anon'}`,
}))

// Mutex to prevent race condition on admin creation
let setupInProgress = false

// Check if setup is needed (no users exist yet)
setup.get('/status', async (c) => {
  const { data, error } = await supabaseAdmin.auth.admin.listUsers({ page: 1, perPage: 1 })
  if (error) return c.json({ error: 'failed to check setup status' }, 500)
  const needsSetup = !data.users || data.users.length === 0
  return c.json({ needs_setup: needsSetup })
})

// Create the first superadmin user (only works when no users exist)
setup.post('/create-admin', async (c) => {
  // Mutex: reject concurrent setup attempts
  if (setupInProgress) {
    return c.json({ error: 'setup already in progress' }, 409)
  }
  setupInProgress = true

  try {
    const { data: listData, error: listError } = await supabaseAdmin.auth.admin.listUsers({ page: 1, perPage: 1 })
    if (listError) return c.json({ error: 'failed to check users' }, 500)
    if (listData.users && listData.users.length > 0) {
      return c.json({ error: 'setup already completed' }, 403)
    }

    const parsed = SetupBody.safeParse(await c.req.json())
    if (!parsed.success) {
      return c.json({ error: 'invalid input — email and password (min 8 chars) required' }, 400)
    }

    const { data, error } = await supabaseAdmin.auth.admin.createUser({
      email: parsed.data.email,
      password: parsed.data.password,
      email_confirm: true,
    })

    if (error) {
      return c.json({ error: error.message }, 400)
    }

    return c.json({ ok: true, user_id: data.user.id }, 201)
  } finally {
    setupInProgress = false
  }
})

export { setup }
