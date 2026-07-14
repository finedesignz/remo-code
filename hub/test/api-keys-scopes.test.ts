/**
 * Milestone SKEY — named, scoped, multi API keys.
 *
 * Guards the three security invariants:
 *   1. NULL/empty scopes == legacy full access (zero-migration for existing keys).
 *   2. A key WITHOUT `agent` cannot reach a host-spawning surface (/api/plugin, /ws/agent).
 *   3. An api key can NEVER mint an api key — /api/api-keys is cookie-auth only.
 */
import { describe, it, expect, afterAll, mock } from 'bun:test'
import { Hono } from 'hono'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { hasScope, normalizeScopes, SCOPE_AGENT, SCOPE_EXT_ASK, SCOPE_EXT_READ } from '../src/auth/scopes.ts'

const SRC = join(import.meta.dir, '..', 'src')

afterAll(() => { mock.restore() })

describe('scopes helper', () => {
  it('NULL scopes = legacy full access', () => {
    expect(hasScope(null, SCOPE_AGENT)).toBe(true)
    expect(hasScope(undefined, SCOPE_EXT_ASK)).toBe(true)
    expect(hasScope([], SCOPE_AGENT)).toBe(true)
  })

  it('non-empty scopes are an allowlist', () => {
    expect(hasScope([SCOPE_EXT_READ], SCOPE_EXT_READ)).toBe(true)
    expect(hasScope([SCOPE_EXT_READ], SCOPE_AGENT)).toBe(false)
    expect(hasScope([SCOPE_EXT_READ], SCOPE_EXT_ASK)).toBe(false)
    expect(hasScope([SCOPE_AGENT], SCOPE_AGENT)).toBe(true)
  })

  it('normalizeScopes rejects unknown scopes and dedupes', () => {
    expect(normalizeScopes(['ext:read', 'ext:read'])).toEqual({ ok: true, scopes: ['ext:read'] })
    expect(normalizeScopes([])).toEqual({ ok: true, scopes: null })
    expect(normalizeScopes(null)).toEqual({ ok: true, scopes: null })
    const bad = normalizeScopes(['admin'])
    expect(bad.ok).toBe(false)
  })
})

describe('apiKeyMiddleware scope enforcement', () => {
  async function appWithKey(scopes: string[] | null) {
    mock.module(join(SRC, 'db/dal.ts'), () => ({
      verifyApiKeyWithScope: async (_hash: string, scope: string) => {
        if (!hasScope(scopes, scope)) return { error: 'missing_scope' }
        return { userId: 'u1', apiKeyId: 'k1' }
      },
    }))
    const { apiKeyMiddleware } = await import(`../src/auth/api-key-middleware.ts?scopes=${JSON.stringify(scopes)}`)
    const app = new Hono()
    app.use('/api/plugin/*', apiKeyMiddleware)
    app.get('/api/plugin/ping', (c) => c.json({ ok: true, user: c.get('userId') }))
    return app
  }

  it('legacy key (NULL scopes) still reaches the plugin surface', async () => {
    const app = await appWithKey(null)
    const res = await app.request('/api/plugin/ping', { headers: { Authorization: 'Bearer remokey_legacy' } })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, user: 'u1' })
  })

  it('agent-scoped key reaches the plugin surface', async () => {
    const app = await appWithKey(['agent'])
    const res = await app.request('/api/plugin/ping', { headers: { Authorization: 'Bearer remokey_agent' } })
    expect(res.status).toBe(200)
  })

  it('ext-only key is REJECTED 403 on the plugin surface', async () => {
    const app = await appWithKey(['ext:read', 'ext:ask'])
    const res = await app.request('/api/plugin/ping', { headers: { Authorization: 'Bearer remokey_ext' } })
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'insufficient_scope', required: 'agent' })
  })

  it('missing/garbage auth header is 401', async () => {
    const app = await appWithKey(null)
    expect((await app.request('/api/plugin/ping')).status).toBe(401)
    expect((await app.request('/api/plugin/ping', { headers: { Authorization: 'Bearer nope' } })).status).toBe(401)
  })
})

describe('/api/ext scope enforcement (milestone ASK middleware × SKEY scopes)', () => {
  async function extApp(scopes: string[] | null) {
    mock.module(join(SRC, 'db/ask-dal.ts'), () => ({
      verifyApiKeyForExt: async () => ({ id: 'k1', user_id: 'u1', scopes }),
      hasScope: (s: string[] | null | undefined, scope: string) => hasScope(s, scope),
    }))
    const { extApiKeyMiddleware } = await import(
      `../src/auth/ext-api-key-middleware.ts?ext=${encodeURIComponent(JSON.stringify(scopes))}`
    )
    const app = new Hono()
    app.use('/api/ext/*', extApiKeyMiddleware)
    app.get('/api/ext/sessions', (c) => c.json({ ok: true }))
    app.post('/api/ext/sessions/s1/ask', (c) => c.json({ ok: true }))
    return app
  }
  const auth = { headers: { Authorization: 'Bearer remokey_x' } }

  it('ext:read-only key CAN read but is REJECTED 403 on the ask endpoint', async () => {
    const app = await extApp(['ext:read'])
    expect((await app.request('/api/ext/sessions', auth)).status).toBe(200)
    const res = await app.request('/api/ext/sessions/s1/ask', { method: 'POST', ...auth })
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'insufficient_scope', required: 'ext:ask' })
  })

  it('ext:read + ext:ask key may ask', async () => {
    const app = await extApp(['ext:read', 'ext:ask'])
    expect((await app.request('/api/ext/sessions/s1/ask', { method: 'POST', ...auth })).status).toBe(200)
  })

  it('agent-only key is REJECTED on /api/ext (403 ext:read)', async () => {
    const app = await extApp(['agent'])
    const res = await app.request('/api/ext/sessions', auth)
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'insufficient_scope', required: 'ext:read' })
  })

  it('legacy NULL-scopes key retains full /api/ext access', async () => {
    const app = await extApp(null)
    expect((await app.request('/api/ext/sessions', auth)).status).toBe(200)
    expect((await app.request('/api/ext/sessions/s1/ask', { method: 'POST', ...auth })).status).toBe(200)
  })
})

describe('/ws/agent requires the agent scope', () => {
  it('agent.ts gates auth on verifyApiKeyWithScope(…, agent) and closes missing_agent_scope', () => {
    const src = readFileSync(join(SRC, 'ws/agent.ts'), 'utf8')
    expect(src).toContain("verifyApiKeyWithScope(keyHash, 'agent')")
    expect(src).toContain('missing_agent_scope')
  })
})

describe('an api key can never mint an api key', () => {
  it('/api/api-keys is NOT mounted behind apiKeyMiddleware', () => {
    const index = readFileSync(join(SRC, 'index.ts'), 'utf8')
    const mounts = index.split('\n').filter((l) => l.includes('apiKeyMiddleware') && l.includes('app.use'))
    expect(mounts.length).toBeGreaterThan(0)
    for (const line of mounts) {
      expect(line).not.toContain('/api/api-keys')
    }
  })

  it('the api-keys router reads userId from the cookie session only (no Bearer parsing)', () => {
    const src = readFileSync(join(SRC, 'api/api-keys.ts'), 'utf8')
    expect(src).not.toContain("header('Authorization')")
    expect(src).not.toContain('import { apiKeyMiddleware')
  })
})
