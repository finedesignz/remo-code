import { Hono } from 'hono'
import { createApiKey, listApiKeys, revokeApiKey } from '../db/dal'
import { hashToken } from '../ws/channel'

const apiKeys = new Hono()

function generateApiKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  const b64 = btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  return `remokey_${b64}`
}

// List API keys (never returns raw key)
apiKeys.get('/', async (c) => {
  const sb = c.get('supabase')
  const keys = await listApiKeys(sb)
  return c.json(keys)
})

// Generate new API key (revokes existing active key)
apiKeys.post('/', async (c) => {
  const userId = c.get('userId')
  const rawKey = generateApiKey()
  const keyHash = await hashToken(rawKey)
  const key = await createApiKey(userId, keyHash)
  return c.json({ ...key, key: rawKey }, 201)
})

// Revoke a key
apiKeys.delete('/:id', async (c) => {
  const sb = c.get('supabase')
  try {
    await revokeApiKey(sb, c.req.param('id'))
    return c.json({ ok: true })
  } catch {
    return c.json({ error: 'not found' }, 404)
  }
})

export { apiKeys }
