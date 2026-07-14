import type { Context, Next } from 'hono'
import { verifyApiKeyWithScope } from '../db/dal'
import { hashToken } from '../lib/crypto'
import { SCOPE_AGENT } from './scopes'

/**
 * Api-key auth for the supervisor-facing surface (/api/plugin/*).
 *
 * Milestone SKEY: requires the `agent` scope. NULL/empty scopes = legacy full
 * access (zero-migration for keys minted before the milestone). An `ext:*`-only
 * key is rejected 403 — it must never reach a host-spawning surface.
 *
 * (Also fixes a latent bug: `verifyApiKey` returns a user-id STRING, so the old
 * `keyData.user_id` / `keyData.id` reads set `userId` to undefined.)
 */
export async function apiKeyMiddleware(c: Context, next: Next) {
  const authHeader = c.req.header('Authorization')
  if (!authHeader?.startsWith('Bearer remokey_')) {
    return c.json({ error: 'unauthorized' }, 401)
  }

  const rawKey = authHeader.slice(7) // "remokey_..."
  const keyHash = await hashToken(rawKey)

  // FAIL CLOSED — a DAL/DB failure must never authenticate the request.
  let result: Awaited<ReturnType<typeof verifyApiKeyWithScope>>
  try {
    result = await verifyApiKeyWithScope(keyHash, SCOPE_AGENT)
  } catch {
    return c.json({ error: 'unauthorized' }, 401)
  }

  if ('error' in result) {
    if (result.error === 'missing_scope') {
      return c.json({ error: 'insufficient_scope', required: SCOPE_AGENT }, 403)
    }
    return c.json({ error: 'unauthorized' }, 401)
  }

  c.set('userId', result.userId)
  c.set('apiKeyId', result.apiKeyId)

  await next()
}
