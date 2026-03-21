import type { Context, Next } from 'hono'
import { supabaseForUser } from '../db/supabase'
import { supabaseAdmin } from '../db/supabase'

// Extracts and verifies the Supabase JWT from the Authorization header.
// Sets userId and a user-scoped Supabase client on the context.
export async function authMiddleware(c: Context, next: Next) {
  const authHeader = c.req.header('Authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return c.json({ error: 'unauthorized' }, 401)
  }

  const jwt = authHeader.slice(7)
  const { data: { user }, error } = await supabaseAdmin.auth.getUser(jwt)

  if (error || !user) {
    return c.json({ error: 'unauthorized' }, 401)
  }

  c.set('userId', user.id)
  c.set('jwt', jwt)
  c.set('supabase', supabaseForUser(jwt))

  await next()
}
