import { Hono } from 'hono'
import { createApiKey, listApiKeys, revokeApiKey } from '../db/dal'
import { hashToken } from '../ws/channel'
import { generateToken } from '../utils/token'

const apiKeys = new Hono()

// List API keys (never returns raw key)
apiKeys.get('/', async (c) => {
  const userId = c.get('userId') as string
  const keys = await listApiKeys(userId)
  return c.json(keys)
})

// Generate new API key (revokes existing active key)
apiKeys.post('/', async (c) => {
  const userId = c.get('userId') as string
  const rawKey = generateToken('remokey_')
  const keyHash = await hashToken(rawKey)
  const key = await createApiKey(userId, keyHash, 'default')
  return c.json({ ...key, key: rawKey }, 201)
})

// Revoke all active keys for the user
apiKeys.delete('/:id', async (c) => {
  const userId = c.get('userId') as string
  try {
    await revokeApiKey(userId)
    return c.json({ ok: true })
  } catch {
    return c.json({ error: 'not found' }, 404)
  }
})

export { apiKeys }
