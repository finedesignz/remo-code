import { Hono } from 'hono'
import { createApiKey, listApiKeys, revokeApiKey, recordAuthEvent } from '../db/dal'
import { hashToken } from '../lib/crypto'
import { generateToken } from '../utils/token'
import { pushKeyRotatedToUser } from '../ws/supervisor-registry'

const apiKeys = new Hono()

function ipOf(c: any): string | null {
  return c.req.header('cf-connecting-ip') || c.req.header('x-real-ip') || c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || null
}

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
  // Phase 07-G: audit token_create (createApiKey also revokes prior — token_rotate semantics).
  try {
    await recordAuthEvent({
      userId,
      eventType: 'token_create',
      ip: ipOf(c),
      userAgent: c.req.header('user-agent') ?? null,
      metadata: { key_id: key.id, name: 'default' },
    })
  } catch {}
  // v0.5.4 — push the new plaintext to every supervisor socket owned by this
  // user so the tray app can hot-swap the key without the user re-pasting.
  // Best-effort; offline supervisors are caught by the user re-pasting via
  // the Tauri Update API Key dialog.
  try { pushKeyRotatedToUser(userId, rawKey, key.id) } catch {}
  return c.json({ ...key, key: rawKey }, 201)
})

// Revoke all active keys for the user
apiKeys.delete('/:id', async (c) => {
  const userId = c.get('userId') as string
  try {
    await revokeApiKey(userId)
    try {
      await recordAuthEvent({
        userId,
        eventType: 'token_delete',
        ip: ipOf(c),
        userAgent: c.req.header('user-agent') ?? null,
        metadata: { key_id: c.req.param('id') },
      })
    } catch {}
    return c.json({ ok: true })
  } catch {
    return c.json({ error: 'not found' }, 404)
  }
})

export { apiKeys }
