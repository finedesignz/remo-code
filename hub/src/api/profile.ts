import { Hono } from 'hono'
import { z } from 'zod'
import { supabaseAdmin } from '../db/supabase'

const profile = new Hono()

// Get current user's profile
profile.get('/', async (c) => {
  const userId = c.get('userId')
  const { data, error } = await supabaseAdmin
    .from('profiles')
    .select('id, email, display_name, role, created_at')
    .eq('id', userId)
    .single()

  if (error || !data) return c.json({ error: 'profile not found' }, 404)

  // Get session count
  const { count } = await supabaseAdmin
    .from('sessions')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)

  return c.json({
    ...data,
    session_count: count || 0,
  })
})

// Update display name
const UpdateProfile = z.object({
  display_name: z.string().min(1).max(100).optional(),
})

profile.patch('/', async (c) => {
  const userId = c.get('userId')
  const parsed = UpdateProfile.safeParse(await c.req.json())
  if (!parsed.success) return c.json({ error: 'invalid input' }, 400)

  const { error } = await supabaseAdmin
    .from('profiles')
    .update({ ...parsed.data, updated_at: new Date().toISOString() })
    .eq('id', userId)

  if (error) return c.json({ error: 'update failed' }, 500)
  return c.json({ ok: true })
})

export { profile }
