/**
 * Cloud-host keys (docs/cloud-session-supervisor.md).
 *
 * A user can run a second supervisor host (e.g. a Claude Code cloud session)
 * next to the tray app. Two hosts on ONE key evict each other
 * (registerSupervisor closes the older socket 4003), so:
 *   1. `host: true` + agent scope mints purpose='host' (never 'supervisor', so
 *      createApiKey does NOT revoke the tray app's key).
 *   2. `host: true` without agent → 400.
 *   3. Minting a new supervisor key hot-swaps ONLY the prior supervisor key's
 *      socket, never a host key's socket.
 *   4. Rotating a host key hot-swaps ONLY that host.
 *
 * DAL + registry are mocked via mock.module (real modules spread first — Bun
 * mock.module is process-global; see sessions-launch.test.ts).
 */
import { describe, it, expect, mock, beforeEach } from 'bun:test'
import { Hono } from 'hono'

const USER = 'user-1'
const state = {
  created: [] as any[],
  pushes: [] as { keyId: string; only?: string[] }[],
  active: [] as any[],
  byId: {} as Record<string, any>,
}

const realDal = await import(`../src/db/dal.ts?real=${Date.now()}`)
const realRegistry = await import(`../src/ws/supervisor-registry.ts?real=${Date.now()}`)

mock.module('../src/db/dal.ts', () => ({
  ...realDal,
  createApiKey: async (_u: string, _h: string, name: string, opts: any) => {
    const key = { id: `k${state.created.length + 1}`, name, purpose: opts.purpose, scopes: opts.scopes }
    state.created.push(key)
    return key
  },
  listApiKeys: async () => state.active,
  getApiKeyById: async (_u: string, id: string) => state.byId[id] ?? null,
  revokeApiKeyById: async (_u: string, id: string) => ({ id }),
  recordAuthEvent: async () => {},
}))
mock.module('../src/ws/supervisor-registry.ts', () => ({
  ...realRegistry,
  pushKeyRotatedToUser: (_u: string, _k: string, keyId: string, opts: any = {}) => {
    state.pushes.push({ keyId, only: opts.onlyApiKeyIds })
    return 1
  },
}))

const { apiKeys } = await import('../src/api/api-keys.ts')
const app = new Hono()
app.use('*', async (c, next) => { c.set('userId' as never, USER as never); await next() })
app.route('/api/api-keys', apiKeys)

const post = (path: string, body?: unknown) =>
  app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })

beforeEach(() => {
  state.created = []
  state.pushes = []
  state.active = [{ id: 'tray', purpose: 'supervisor' }]
  state.byId = {}
})

describe('cloud-host api keys', () => {
  it('host:true + agent mints purpose=host and pushes to nobody', async () => {
    const res = await post('/api/api-keys', { scopes: ['agent'], host: true })
    expect(res.status).toBe(201)
    const body: any = await res.json()
    expect(body.purpose).toBe('host')
    expect(body.name).toBe('Cloud host')
    expect(body.key).toMatch(/^remokey_/)
    expect(state.pushes).toEqual([])
  })

  it('host:true without agent scope is rejected', async () => {
    const res = await post('/api/api-keys', { scopes: ['ext:read'], host: true })
    expect(res.status).toBe(400)
    expect(state.created).toEqual([])
  })

  it('a new supervisor key hot-swaps only the prior supervisor key, never a host', async () => {
    state.active = [{ id: 'tray', purpose: 'supervisor' }, { id: 'cloud', purpose: 'host' }]
    const res = await post('/api/api-keys', { scopes: ['agent'] })
    expect(res.status).toBe(201)
    expect(((await res.json()) as any).purpose).toBe('supervisor')
    expect(state.pushes).toEqual([{ keyId: 'k1', only: ['tray'] }])
  })

  it('ext-only keys are still external and never pushed', async () => {
    const res = await post('/api/api-keys', { scopes: ['ext:read'] })
    expect(((await res.json()) as any).purpose).toBe('external')
    expect(state.pushes).toEqual([])
  })

  it('rotating a host key hot-swaps only that host', async () => {
    state.byId.cloud = { id: 'cloud', name: 'Cloud host', purpose: 'host', scopes: ['agent'] }
    const res = await post('/api/api-keys/cloud/rotate')
    expect(res.status).toBe(201)
    expect(((await res.json()) as any).purpose).toBe('host')
    expect(state.pushes).toEqual([{ keyId: 'k1', only: ['cloud'] }])
  })

  it('rotating the tray key hot-swaps only the tray app', async () => {
    state.byId.tray = { id: 'tray', name: 'Supervisor', purpose: 'supervisor', scopes: null }
    await post('/api/api-keys/tray/rotate')
    expect(state.pushes).toEqual([{ keyId: 'k1', only: ['tray'] }])
  })
})

describe('pushKeyRotatedToUser onlyApiKeyIds filter', () => {
  it('delivers only to sockets whose key id is listed', () => {
    const sent: string[] = []
    const mk = (id: string) => ({ send: () => sent.push(id), close() {} }) as any
    realRegistry.registerSupervisor({ ws: mk('tray'), supervisorId: 's-tray', userId: 'u9', apiKeyId: 'tray', roots: [] })
    realRegistry.registerSupervisor({ ws: mk('cloud'), supervisorId: 's-cloud', userId: 'u9', apiKeyId: 'cloud', roots: [] })
    expect(realRegistry.pushKeyRotatedToUser('u9', 'remokey_x', 'new', { onlyApiKeyIds: ['tray'] })).toBe(1)
    expect(sent).toEqual(['tray'])
    sent.length = 0
    expect(realRegistry.pushKeyRotatedToUser('u9', 'remokey_x', 'new')).toBe(2)
    realRegistry.unregisterSupervisor?.('s-tray')
    realRegistry.unregisterSupervisor?.('s-cloud')
  })
})
