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

/**
 * Keys carrying the `agent` scope (or legacy NULL scopes) ARE a host-spawn
 * credential. By default that is THE supervisor key (purpose='supervisor',
 * at-most-one active, hot-swapped into the tray app). `host: true` mints an
 * ADDITIONAL host key instead (purpose='host'): N per user, never revokes or
 * replaces the tray app's key — used by a second host such as a headless
 * supervisor in a Claude Code cloud session (docs/cloud-session-supervisor.md).
 * `host: true` without the agent scope is meaningless → 400.
 */
function purposeFor(scopes: string[] | null, host: boolean): string | { error: string } {
  const agent = hasScope(scopes, SCOPE_AGENT)
  if (host) return agent ? 'host' : { error: 'host keys require the agent scope' }
  return agent ? 'supervisor' : 'external'
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

// Mint a key. Body: { name?: string, scopes?: string[] | null, host?: boolean }
// scopes omitted/null ⇒ legacy full-access key (what the supervisor gets).
// host: true ⇒ an additional agent-scoped host key (purpose='host').
apiKeys.post('/', async (c) => {
  const userId = c.get('userId') as string
  let body: any = {}
  try { body = await c.req.json() } catch { /* empty body = legacy full-access mint */ }

  const norm = normalizeScopes(body?.scopes ?? null)
  if (!norm.ok) return c.json({ error: norm.error }, 400)
  const scopes = norm.scopes

  const host = body?.host === true
  const purposeOrErr = purposeFor(scopes, host)
  if (typeof purposeOrErr !== 'string') return c.json(purposeOrErr, 400)
  const purpose = purposeOrErr

  const rawName = typeof body?.name === 'string' ? body.name.trim() : ''
  const name = (rawName || (host ? 'Cloud host' : scopes ? 'External key' : 'Supervisor')).slice(0, 64)

  // Minting a new supervisor key revokes the previous one (createApiKey). Capture
  // that key's id first so the hot-swap reaches ONLY the tray app that held it —
  // never a purpose='host' supervisor running on its own key.
  const priorSupervisorKeyIds = purpose === 'supervisor'
    ? (await listApiKeys(userId)).filter((k: any) => k.purpose === 'supervisor').map((k: any) => k.id as string)
    : []

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
  // an external (ext:*) key must never be pushed to a supervisor, and a new
  // host key never replaces another host's credential.
  if (purpose === 'supervisor') {
    try { pushKeyRotatedToUser(userId, rawKey, key.id, { onlyApiKeyIds: priorSupervisorKeyIds }) } catch {}
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

  // Hot-swap the new secret into the ONE host that authenticated with the
  // rotated key (tray app or purpose='host'), never into a sibling host.
  if (existing.purpose === 'supervisor' || existing.purpose === 'host') {
    try { pushKeyRotatedToUser(userId, rawKey, key.id, { onlyApiKeyIds: [id] }) } catch {}
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
