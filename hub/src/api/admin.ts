import { Hono } from 'hono'
import { z } from 'zod'
import { supabaseAdmin } from '../db/supabase'

const admin = new Hono()

// List all users with profiles
admin.get('/users', async (c) => {
  const { data, error } = await supabaseAdmin
    .from('profiles')
    .select('id, email, display_name, role, tier, stripe_customer_id, created_at, updated_at')
    .order('created_at', { ascending: false })

  if (error) return c.json({ error: 'failed to fetch users' }, 500)

  // Get session counts per user
  const { data: sessionCounts } = await supabaseAdmin
    .from('sessions')
    .select('user_id')

  const countMap: Record<string, number> = {}
  for (const s of sessionCounts || []) {
    countMap[s.user_id] = (countMap[s.user_id] || 0) + 1
  }

  const users = (data || []).map(u => ({
    ...u,
    session_count: countMap[u.id] || 0,
  }))

  return c.json(users)
})

// Get dashboard stats
admin.get('/stats', async (c) => {
  const { count: totalUsers } = await supabaseAdmin
    .from('profiles')
    .select('id', { count: 'exact', head: true })

  const { count: totalSessions } = await supabaseAdmin
    .from('sessions')
    .select('id', { count: 'exact', head: true })

  const { count: onlineSessions } = await supabaseAdmin
    .from('sessions')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'online')

  const { count: totalMessages } = await supabaseAdmin
    .from('messages')
    .select('id', { count: 'exact', head: true })

  // Tier distribution
  const { data: tierData } = await supabaseAdmin
    .from('profiles')
    .select('tier')

  const tiers: Record<string, number> = { free: 0, pro: 0, max: 0 }
  for (const p of tierData || []) {
    tiers[p.tier] = (tiers[p.tier] || 0) + 1
  }

  return c.json({
    total_users: totalUsers || 0,
    total_sessions: totalSessions || 0,
    online_sessions: onlineSessions || 0,
    total_messages: totalMessages || 0,
    tiers,
  })
})

// Update user role or tier
const UpdateUser = z.object({
  role: z.enum(['user', 'admin']).optional(),
  tier: z.enum(['free', 'pro', 'max']).optional(),
})

admin.patch('/users/:id', async (c) => {
  const id = c.req.param('id')
  const parsed = UpdateUser.safeParse(await c.req.json())
  if (!parsed.success) return c.json({ error: 'invalid input' }, 400)

  const updates: Record<string, any> = { updated_at: new Date().toISOString() }
  if (parsed.data.role) updates.role = parsed.data.role
  if (parsed.data.tier) updates.tier = parsed.data.tier

  const { error } = await supabaseAdmin
    .from('profiles')
    .update(updates)
    .eq('id', id)

  if (error) return c.json({ error: 'update failed' }, 500)
  return c.json({ ok: true })
})

// Delete user
admin.delete('/users/:id', async (c) => {
  const id = c.req.param('id')
  const adminId = c.get('userId')

  if (id === adminId) {
    return c.json({ error: 'cannot delete yourself' }, 400)
  }

  const { error } = await supabaseAdmin.auth.admin.deleteUser(id)
  if (error) return c.json({ error: 'delete failed' }, 500)

  return c.json({ ok: true })
})

export { admin }
