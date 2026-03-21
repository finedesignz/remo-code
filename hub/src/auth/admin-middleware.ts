import type { Context, Next } from 'hono'
import { supabaseAdmin } from '../db/supabase'

export async function adminMiddleware(c: Context, next: Next) {
  const userId = c.get('userId')
  if (!userId) return c.json({ error: 'unauthorized' }, 401)

  const { data, error } = await supabaseAdmin
    .from('profiles')
    .select('role')
    .eq('id', userId)
    .single()

  if (error || !data || data.role !== 'admin') {
    return c.json({ error: 'forbidden' }, 403)
  }

  await next()
}
