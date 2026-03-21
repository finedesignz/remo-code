import { Hono } from 'hono'
import { z } from 'zod'
import { supabaseAdmin } from '../db/supabase'

const setup = new Hono()

const SetupBody = z.object({
  email: z.string().email().max(255),
  password: z.string().min(8).max(128),
})

// Check if setup is needed (no users exist yet)
setup.get('/status', async (c) => {
  const { count, error } = await supabaseAdmin.auth.admin.listUsers({ page: 1, perPage: 1 })
  if (error) return c.json({ error: 'failed to check setup status' }, 500)
  const needsSetup = !count || count === 0
  return c.json({ needs_setup: needsSetup })
})

// Create the first superadmin user (only works when no users exist)
setup.post('/create-admin', async (c) => {
  // Verify no users exist
  const { data: { users }, error: listError } = await supabaseAdmin.auth.admin.listUsers({ page: 1, perPage: 1 })
  if (listError) return c.json({ error: 'failed to check users' }, 500)
  if (users && users.length > 0) {
    return c.json({ error: 'setup already completed' }, 403)
  }

  const parsed = SetupBody.safeParse(await c.req.json())
  if (!parsed.success) {
    return c.json({ error: 'invalid input — email and password (min 8 chars) required' }, 400)
  }

  const { data, error } = await supabaseAdmin.auth.admin.createUser({
    email: parsed.data.email,
    password: parsed.data.password,
    email_confirm: true, // Auto-confirm the first admin
  })

  if (error) {
    return c.json({ error: error.message }, 400)
  }

  return c.json({ ok: true, user_id: data.user.id }, 201)
})

export { setup }
