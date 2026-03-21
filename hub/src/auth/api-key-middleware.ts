import type { Context, Next } from 'hono'
import { verifyApiKey } from '../db/dal'
import { hashToken } from '../lib/crypto'

export async function apiKeyMiddleware(c: Context, next: Next) {
  const authHeader = c.req.header('Authorization')
  if (!authHeader?.startsWith('Bearer remokey_')) {
    return c.json({ error: 'unauthorized' }, 401)
  }

  const rawKey = authHeader.slice(7) // "remokey_..."
  const keyHash = await hashToken(rawKey)
  const keyData = await verifyApiKey(keyHash)

  if (!keyData) {
    return c.json({ error: 'unauthorized' }, 401)
  }

  c.set('userId', keyData.user_id)
  c.set('apiKeyId', keyData.id)

  await next()
}
