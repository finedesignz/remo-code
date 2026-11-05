/**
 * /api/chat/* auth (scope `chat:session`).
 *
 * Lets a server (e.g. AgentAutofix) drive an EXISTING live session like the web chat, with a
 * Bearer api key instead of the cookie + Origin + CSRF that /ws/client requires.
 *
 * SECURITY:
 *   - EXPLICIT-only (`hasExplicitScope`): a legacy NULL-scopes key (incl. the supervisor's own
 *     spawn key) never acquires it, and no other scope implies it.
 *   - Mounted only on /api/chat/*. Other families reject this key already: /api/ext needs
 *     `ext:read` (hasScope on a non-empty list), /api/plugin needs `agent`, and the cookie
 *     catch-all (`authMiddleware`) only lets settings-scoped keys onto the settings allowlist.
 *   - The ACTOR is server-inferred `external-chat` (automation); it can never be `human`, so a
 *     pty-interactive session is refused (see api/chat.ts).
 *   - FAILS CLOSED on any key-lookup error.
 */
import type { Context, Next } from 'hono'
import { hashToken } from '../lib/crypto'
import { verifyApiKeyForExt } from '../db/ask-dal.ts'
import { hasExplicitScope, SCOPE_CHAT_SESSION } from './scopes.ts'

export const CHAT_ACTOR = 'external-chat'
export const CHAT_AUTH_METHOD = 'api_key_chat'

export async function chatApiKeyMiddleware(c: Context, next: Next) {
  const authHeader = c.req.header('Authorization') ?? ''
  if (!authHeader.startsWith('Bearer ')) return c.json({ error: 'unauthorized' }, 401)
  const rawKey = authHeader.slice(7).trim()
  if (!/^remokey_[A-Za-z0-9_-]+$/.test(rawKey)) return c.json({ error: 'unauthorized' }, 401)

  const keyHash = await hashToken(rawKey)
  let key: Awaited<ReturnType<typeof verifyApiKeyForExt>> = null
  try {
    key = await verifyApiKeyForExt(keyHash)
  } catch (err: any) {
    console.warn(`[chat-auth] key lookup failed: ${err?.message ?? err}`)
    return c.json({ error: 'unauthorized' }, 401)
  }
  if (!key) return c.json({ error: 'unauthorized' }, 401)

  if (!hasExplicitScope(key.scopes, SCOPE_CHAT_SESSION)) {
    return c.json({ error: 'insufficient_scope', required: SCOPE_CHAT_SESSION }, 403)
  }

  c.set('userId', key.user_id)
  c.set('apiKeyId', key.id)
  c.set('apiKeyHash', keyHash)
  c.set('authMethod', CHAT_AUTH_METHOD)
  c.set('actor', CHAT_ACTOR)
  await next()
}
