import { createClient } from '@supabase/supabase-js'
import { config } from '../config'

// Service role client — bypasses RLS, used for server-side operations
// (channel token verification, status updates from channel WS)
export const supabaseAdmin = createClient(config.supabaseUrl, config.supabaseServiceKey)

// Create a per-request client authenticated with the user's JWT
// RLS policies apply automatically
export function supabaseForUser(jwt: string) {
  return createClient(config.supabaseUrl, config.supabaseAnonKey, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
  })
}
