/**
 * /api/ext/* auth (milestone ASK).
 *
 * Reuses the EXISTING `api_keys` credential (the same table `/ws/agent` and
 * `/api/plugin` use) and layers the additive, NULLABLE `scopes` column on top:
 *
 *   scopes IS NULL            → legacy full access (every pre-existing key)
 *   scopes @> {'ext:read'}    → may use the read surface (transcript/memory/state/list)
 *   scopes @> {'ext:ask'}     → may ALSO spend tokens via POST …/ask
 *
 * The ACTOR is SERVER-INFERRED: an api-key-authenticated request is automation
 * (`external-ask`), never a client-asserted field. Nothing in the request body can
 * make it a `human`, so `humanOnlyPtyGate` can never be talked out of rejecting a
 * pty-interactive target.
 */
import type { Context, Next } from 'hono'
import { hashToken } from '../lib/crypto'
import { verifyApiKeyForExt, hasScope } from '../db/ask-dal.ts'

/** The actor name every /api/ext dispatch carries. Automation, by construction. */
export const EXT_ACTOR = 'external-ask'

export const SCOPE_READ = 'ext:read'
export const SCOPE_ASK = 'ext:ask'

export async function extApiKeyMiddleware(c: Context, next: Next) {
  const authHeader = c.req.header('Authorization') ?? ''
  if (!authHeader.startsWith('Bearer ')) {
    return c.json({ error: 'unauthorized' }, 401)
  }
  const rawKey = authHeader.slice(7).trim()
  if (!/^(remokey_|remo_)[A-Za-z0-9_-]+$/.test(rawKey)) {
    return c.json({ error: 'unauthorized' }, 401)
  }

  // FAIL CLOSED: a DAL/DB failure must never authenticate the request.
  let key: Awaited<ReturnType<typeof verifyApiKeyForExt>> = null
  try {
    key = await verifyApiKeyForExt(await hashToken(rawKey))
  } catch (err: any) {
    console.warn(`[ext-auth] key lookup failed: ${err?.message ?? err}`)
    return c.json({ error: 'unauthorized' }, 401)
  }
  if (!key) return c.json({ error: 'unauthorized' }, 401)

  // Every /api/ext route is at least a read.
  if (!hasScope(key.scopes, SCOPE_READ)) {
    return c.json({ error: 'insufficient_scope', required: SCOPE_READ }, 403)
  }
  // Spending tokens needs the explicit ask scope.
  if (c.req.method === 'POST' && c.req.path.endsWith('/ask') && !hasScope(key.scopes, SCOPE_ASK)) {
    return c.json({ error: 'insufficient_scope', required: SCOPE_ASK }, 403)
  }

  c.set('userId', key.user_id)
  c.set('apiKeyId', key.id)
  c.set('actor', EXT_ACTOR)

  await next()
}
