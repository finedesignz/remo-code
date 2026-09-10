/**
 * /api/api-keys — named, scoped, multi API keys (milestone SKEY).
 *
 * COOKIE-AUTH ONLY. This router is mounted behind the session-cookie catch-all in
 * hub/src/index.ts and MUST NEVER sit behind `apiKeyMiddleware`: an api key must
 * not be able to mint another api key (privilege escalation — an `ext:*`-only key
 * could otherwise mint itself an `agent` key and spawn CLI processes on a host).
 * Guarded by hub/test/api-keys-scopes.test.ts.
 */
import { Hono } from 'hono'
import {
  createApiKey,
  listApiKeys,
  revokeApiKeyById,
  getApiKeyById,
  recordAuthEvent,
} from '../db/dal'
import { hashToken } from '../lib/crypto'
import { generateToken } from '../utils/token'
import { normalizeScopes, hasScope, SCOPE_AGENT } from '../auth/scopes'
import { pushKeyRotatedToUser } from '../ws/supervisor-registry'

const apiKeys = new Hono()

function ipOf(c: any): string | null {
  return c.req.header('cf-connecting-ip') || c.req.header('x-real-ip') || c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || null
}

/** Keys carrying the `agent` scope (or legacy NULL scopes) ARE the supervisor credential. */
function purposeForScopes(scopes: string[] | null): string {
  return hasScope(scopes, SCOPE_AGENT) ? 'supervisor' : 'external'
}

function prefixOf(rawKey: string): string {
  return rawKey.slice(0, 14)
}

// List API keys (never returns raw key material)
apiKeys.get('/', async (c) => {
  const userId = c.get('userId') as string
  const keys = await listApiKeys(userId)
  return c.json(keys)
})

// Mint a key. Body: { name?: string, scopes?: string[] | null }
// scopes omitted/null ⇒ legacy full-access key (what the supervisor gets).
apiKeys.post('/', async (c) => {
  const userId = c.get('userId') as string
  let body: any = {}
  try { body = await c.req.json() } catch { /* empty body = legacy full-access mint */ }

  const norm = normalizeScopes(body?.scopes ?? null)
  if (!norm.ok) return c.json({ error: norm.error }, 400)
  const scopes = norm.scopes

  const rawName = typeof body?.name === 'string' ? body.name.trim() : ''
  const name = (rawName || (scopes ? 'External key' : 'Supervisor')).slice(0, 64)
  const purpose = purposeForScopes(scopes)

  const rawKey = generateToken('remokey_')
  const keyHash = await hashToken(rawKey)
  const key = await createApiKey(userId, keyHash, name, { purpose, scopes, keyPrefix: prefixOf(rawKey) })

  try {
    await recordAuthEvent({
      userId,
      eventType: 'token_create',
      ip: ipOf(c),
      userAgent: c.req.header('user-agent') ?? null,
      metadata: { key_id: key.id, name, purpose, scopes },
    })
  } catch {}

  // Only the supervisor credential is hot-swapped into connected tray apps —
  // an external (ext:*) key must never be pushed to a supervisor.
  if (purpose === 'supervisor') {
    try { pushKeyRotatedToUser(userId, rawKey, key.id) } catch {}
  }

  return c.json({ ...key, key: rawKey }, 201)
})

// Rotate ONE key in place: same name/scopes/purpose, new secret, old revoked.
apiKeys.post('/:id/rotate', async (c) => {
  const userId = c.get('userId') as string
  const id = c.req.param('id')
  const existing = await getApiKeyById(userId, id)
  if (!existing) return c.json({ error: 'not found' }, 404)

  const rawKey = generateToken('remokey_')
  const keyHash = await hashToken(rawKey)
  await revokeApiKeyById(userId, id)
  const key = await createApiKey(userId, keyHash, existing.name, {
    purpose: existing.purpose,
    scopes: existing.scopes,
    keyPrefix: prefixOf(rawKey),
  })

  try {
    await recordAuthEvent({
      userId,
      eventType: 'token_create',
      ip: ipOf(c),
      userAgent: c.req.header('user-agent') ?? null,
      metadata: { key_id: key.id, rotated_from: id, purpose: existing.purpose },
    })
  } catch {}

  if (existing.purpose === 'supervisor') {
    try { pushKeyRotatedToUser(userId, rawKey, key.id) } catch {}
  }

  return c.json({ ...key, key: rawKey }, 201)
})

// Revoke exactly ONE key (by id, owner-scoped).
apiKeys.delete('/:id', async (c) => {
  const userId = c.get('userId') as string
  const id = c.req.param('id')
  const revoked = await revokeApiKeyById(userId, id)
  if (!revoked) return c.json({ error: 'not found' }, 404)
  try {
    await recordAuthEvent({
      userId,
      eventType: 'token_delete',
      ip: ipOf(c),
      userAgent: c.req.header('user-agent') ?? null,
      metadata: { key_id: id },
    })
  } catch {}
  return c.json({ ok: true })
})

export { apiKeys }
