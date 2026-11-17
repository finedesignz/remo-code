// CORCH-08 (CORCH-R5.7): provision-on-enrollment against a FAKE AAF (injected fetch; no mock.module).
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-chars-long-aaaaaaaa'
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'session-secret-at-least-32-chars-long-x'
process.env.MAGIC_LINK_SECRET = process.env.MAGIC_LINK_SECRET || 'magic-link-secret-at-least-32-chars-x'
process.env.TITANIUM_KEYGEN_API_URL = process.env.TITANIUM_KEYGEN_API_URL || 'https://keygen.titaniumlabs.us'
process.env.TITANIUM_KEYGEN_ACCOUNT_ID = process.env.TITANIUM_KEYGEN_ACCOUNT_ID || 'acct_test_0000000000'
process.env.TITANIUM_KEYGEN_PRODUCT_ID = process.env.TITANIUM_KEYGEN_PRODUCT_ID || 'prod_test_remo'
import { describe, test, expect, beforeEach, afterAll } from 'bun:test'
import { Hono } from 'hono'
import { provisionExisting, provisionProject, provisionRepoIdent, repoSlugFromIdent } from '../src/corch/aaf-provision.ts'
import { aafProvisionConfig } from '../src/corch/flag.ts'

const ENV_KEYS = ['REMO_CORCH_AAF_URL', 'REMO_CORCH_AAF_TOKEN', 'REMO_CORCH_AAF_INSTALLATION_ID'] as const
const saved: Record<string, string | undefined> = {}
for (const k of ENV_KEYS) saved[k] = process.env[k]
const setEnv = () => {
  process.env.REMO_CORCH_AAF_URL = 'https://aaf.example.test/'
  process.env.REMO_CORCH_AAF_TOKEN = 'tok-secret-never-logged'
  process.env.REMO_CORCH_AAF_INSTALLATION_ID = '4242'
}
afterAll(() => {
  for (const k of ENV_KEYS) saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k])
})

type Call = { url: string; init: RequestInit }
let calls: Call[] = []
let behavior: (c: Call) => Promise<Response> = async () => new Response('{}', { status: 500 })
const fakeFetch = async (url: string, init: RequestInit) => {
  const c = { url, init }
  calls.push(c)
  return behavior(c)
}
const okFor = (slug: string, id = 'aaf-proj-1') => async () =>
  new Response(JSON.stringify({ projects: [{ repo_slug: slug, project_id: id, action: 'created', installation_id: 4242 }] }), { status: 200 })

beforeEach(() => {
  calls = []
  behavior = async () => new Response('{}', { status: 500 })
  for (const k of ENV_KEYS) delete process.env[k]
})

describe('aafProvisionConfig', () => {
  test('off when URL or token unset; partial on a missing installation id or a bad URL', () => {
    expect(aafProvisionConfig().state).toBe('off')
    process.env.REMO_CORCH_AAF_URL = 'https://aaf.example.test'
    expect(aafProvisionConfig().state).toBe('off')
    process.env.REMO_CORCH_AAF_TOKEN = 't'
    expect(aafProvisionConfig()).toEqual({ state: 'partial', signature: 'installation_unset' })
    process.env.REMO_CORCH_AAF_INSTALLATION_ID = '5'
    expect(aafProvisionConfig().state).toBe('on')
    process.env.REMO_CORCH_AAF_URL = 'http://aaf.example.test'
    expect(aafProvisionConfig()).toEqual({ state: 'partial', signature: 'bad_url' }) // non-loopback http refused
    process.env.REMO_CORCH_AAF_URL = 'not a url'
    expect(aafProvisionConfig()).toEqual({ state: 'partial', signature: 'bad_url' })
  })
})

describe('provisionRepoIdent against a fake AAF', () => {
  test('success => provisioned with the returned project id; request matches the AAF contract', async () => {
    setEnv()
    behavior = okFor('acme/site', 'p-123')
    const out = await provisionRepoIdent('github://acme/site', { fetch: fakeFetch })
    expect(out).toEqual({ status: 'provisioned', aafProjectId: 'p-123' })
    expect(calls.length).toBe(1)
    expect(calls[0]!.url).toBe('https://aaf.example.test/api/projects/provision')
    expect(calls[0]!.init.method).toBe('POST')
    expect((calls[0]!.init.headers as any).Authorization).toBe('Bearer tok-secret-never-logged')
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ repo_slugs: ['acme/site'], installation_id: 4242 })
  })

  test('env unset => aaf_unprovisioned and NO network call', async () => {
    const out = await provisionRepoIdent('github://acme/site', { fetch: fakeFetch })
    expect(out).toEqual({ status: 'aaf_unprovisioned', reason: 'env_unset' })
    expect(calls.length).toBe(0)
  })

  test('failures are aaf_unprovisioned with a non-leaky reason: 403, 500, network error, bad body, wrong repo, bad id', async () => {
    setEnv()
    const cases: Array<[() => Promise<Response>, string]> = [
      [async () => new Response('{"error":"forbidden"}', { status: 403 }), 'http_403'],
      [async () => new Response('boom token=abc', { status: 500 }), 'http_500'],
      [async () => { throw new Error('connect ECONNREFUSED tok-secret-never-logged') }, 'unreachable'],
      [async () => new Response('not json', { status: 200 }), 'unreachable'],
      [async () => new Response('{"projects":"x"}', { status: 200 }), 'bad_response'],
      [okFor('other/repo'), 'bad_response'],
      [okFor('acme/site', 'bad id with spaces!'), 'bad_response'],
    ]
    for (const [b, reason] of cases) {
      behavior = b
      const out = await provisionRepoIdent('github://acme/site', { fetch: fakeFetch })
      expect(out).toEqual({ status: 'aaf_unprovisioned', reason })
    }
  })

  test('a non-github ident is never sent to AAF', async () => {
    setEnv()
    expect(repoSlugFromIdent('path://C:/x')).toBeNull()
    const out = await provisionRepoIdent('path://C:/x', { fetch: fakeFetch })
    expect(out.status).toBe('aaf_unprovisioned')
    expect(calls.length).toBe(0)
  })
})

function memStore(rows: any[]) {
  return {
    async setProvisionResult(id: string, r: { status: string; aafProjectId: string | null }) {
      const p = rows.find((x) => x.id === id)
      if (!p) return null
      p.aaf_provision_status = r.status
      p.aaf_project_id = r.aafProjectId
      return p
    },
    async listUnprovisionedProjects() {
      return rows.filter((x) => x.aaf_provision_status !== 'provisioned')
    },
  }
}
const mkRow = (id: string, ident: string) => ({ id, repo_ident: ident, aaf_provision_status: 'aaf_unprovisioned', aaf_project_id: null })

describe('enrollment hook (routes) and the backfill', () => {
  test('POST /projects provisions on enrollment; failure never blocks enrollment (201, aaf_unprovisioned)', async () => {
    const { createCorchRoutes } = await import('../src/corch/routes.ts')
    const rows: any[] = []
    const store: any = {
      ...memStore(rows),
      async createProject(i: any) {
        const p = { user_id: i.userId, enabled: true, ...mkRow(`p${rows.length + 1}`, i.repoIdent) }
        rows.push(p)
        return { project: p, created: true }
      },
    }
    const mk = (provisionImpl: (p: any) => Promise<any>) => {
      const app = new Hono<{ Variables: { userId: string } }>()
      app.use('*', async (c, next) => { c.set('userId', 'u1'); await next() })
      app.route('/api/corch', createCorchRoutes({ store, evaluate: async () => {}, provision: provisionImpl, queue: async () => ({}), publish: () => {} } as any))
      return app
    }
    const req = (ident: string) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ repo_ident: ident }) })

    setEnv()
    behavior = okFor('acme/one', 'aaf-1')
    const okApp = mk((p) => provisionProject(store, p, { fetch: fakeFetch }))
    const r1 = await okApp.request('/api/corch/projects', req('github://acme/one'))
    expect(r1.status).toBe(201)
    const j1: any = await r1.json()
    expect(j1.project.aaf_provision_status).toBe('provisioned')
    expect(j1.project.aaf_project_id).toBe('aaf-1')

    behavior = async () => new Response('', { status: 500 })
    const r2 = await okApp.request('/api/corch/projects', req('github://acme/two'))
    expect(r2.status).toBe(201)
    expect(((await r2.json()) as any).project.aaf_provision_status).toBe('aaf_unprovisioned')

    // Even a provisioner that throws cannot fail enrollment.
    const throwing = mk(async () => { throw new Error('boom') })
    const r3 = await throwing.request('/api/corch/projects', req('github://acme/three'))
    expect(r3.status).toBe(201)
    expect(((await r3.json()) as any).project.aaf_provision_status).toBe('aaf_unprovisioned')
  })

  test('provisionProject leaves an already provisioned project alone (no call, no downgrade)', async () => {
    setEnv()
    const row = { ...mkRow('p1', 'github://acme/site'), aaf_provision_status: 'provisioned', aaf_project_id: 'x' }
    const out = await provisionProject(memStore([row]) as any, row as any, { fetch: fakeFetch })
    expect(out).toBe(row as any)
    expect(calls.length).toBe(0)
  })

  test('provisionExisting is idempotent: the second run does nothing', async () => {
    setEnv()
    const rows = [mkRow('a', 'github://acme/a'), mkRow('b', 'github://acme/b')]
    behavior = async (c) => {
      const slug = JSON.parse(c.init.body as string).repo_slugs[0]
      return okFor(slug, `aaf-${slug.replace('/', '-')}`)()
    }
    const s1 = await provisionExisting(memStore(rows) as any, { fetch: fakeFetch })
    expect(s1).toEqual({ total: 2, provisioned: 2, failed: 0 })
    expect(calls.length).toBe(2)
    const s2 = await provisionExisting(memStore(rows) as any, { fetch: fakeFetch })
    expect(s2).toEqual({ total: 0, provisioned: 0, failed: 0 })
    expect(calls.length).toBe(2)
    expect(rows.every((r) => r.aaf_provision_status === 'provisioned')).toBe(true)
  })

  test('provisionExisting with the env unset provisions nothing and reports every project as failed', async () => {
    const rows = [mkRow('a', 'github://acme/a')]
    const s = await provisionExisting(memStore(rows) as any, { fetch: fakeFetch })
    expect(s).toEqual({ total: 1, provisioned: 0, failed: 1 })
    expect(rows[0]!.aaf_provision_status).toBe('aaf_unprovisioned')
    expect(calls.length).toBe(0)
  })
})
