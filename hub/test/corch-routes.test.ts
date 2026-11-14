// CORCH-01 (CORCH-R1.4, R1.5, R1.2): enrollment + enqueue routes, store + trigger injected (NO mock.module:
// module mocks leak across files in one bun process). Env defaults first: importing routes loads hub config.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-chars-long-aaaaaaaa'
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'session-secret-at-least-32-chars-long-x'
process.env.MAGIC_LINK_SECRET = process.env.MAGIC_LINK_SECRET || 'magic-link-secret-at-least-32-chars-x'
process.env.TITANIUM_KEYGEN_API_URL = process.env.TITANIUM_KEYGEN_API_URL || 'https://keygen.titaniumlabs.us'
process.env.TITANIUM_KEYGEN_ACCOUNT_ID = process.env.TITANIUM_KEYGEN_ACCOUNT_ID || 'acct_test_0000000000'
process.env.TITANIUM_KEYGEN_PRODUCT_ID = process.env.TITANIUM_KEYGEN_PRODUCT_ID || 'prod_test_remo'
import { describe, test, expect, beforeEach, afterAll } from 'bun:test'
import { Hono } from 'hono'

type P = Record<string, any>
let projects: P[] = []
let items: P[] = []
let writes: string[] = []
let triggers: string[] = []
let seq = 0

const fakeStore = {
  async createProject(i: P) {
    const ex = projects.find((p) => p.user_id === i.userId && p.repo_ident === i.repoIdent)
    if (ex) return { project: ex, created: false }
    writes.push('createProject')
    const project = {
      id: `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`, user_id: i.userId, repo_ident: i.repoIdent,
      priority: i.priority, daily_token_budget: i.dailyTokenBudget, enabled: i.enabled, accept_external: i.acceptExternal,
    }
    projects.push(project)
    return { project, created: true }
  },
  async listProjects(userId: string) {
    return projects.filter((p) => p.user_id === userId).sort((a, b) => b.priority - a.priority)
  },
  async getProject(userId: string, id: string) {
    return projects.find((p) => p.user_id === userId && p.id === id) ?? null
  },
  async getProjectByIdent(userId: string, ident: string) {
    return projects.find((p) => p.user_id === userId && p.repo_ident === ident) ?? null
  },
  async updateProject(userId: string, id: string, patch: P) {
    const p = projects.find((x) => x.user_id === userId && x.id === id)
    if (!p) return null
    writes.push('updateProject')
    const previousEnabled = p.enabled
    if (patch.priority !== undefined) p.priority = patch.priority
    if (patch.dailyTokenBudget !== undefined) p.daily_token_budget = patch.dailyTokenBudget
    if (patch.enabled !== undefined) p.enabled = patch.enabled
    if (patch.acceptExternal !== undefined) p.accept_external = patch.acceptExternal
    return { project: p, previousEnabled }
  },
  async enqueueWorkItem(i: P) {
    const ex = items.find((x) => x.user_id === i.userId && x.source === i.source && x.source_ref === i.sourceRef)
    if (ex) return { item: ex, created: false }
    writes.push('enqueueWorkItem')
    const id = `10000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`
    const item = {
      id, user_id: i.userId, project_id: i.projectId, source: i.source, source_ref: i.sourceRef, title: i.title,
      body: i.body, priority: i.priority, status: 'queued', attempts: 0, branch: `corch/${id}`,
    }
    items.push(item)
    return { item, created: true }
  },
  async listWorkItems(userId: string, status: string | null, limit: number) {
    return items.filter((x) => x.user_id === userId && (!status || x.status === status)).slice(0, limit)
  },
}

const fakeDeps = {
  store: fakeStore as any,
  evaluate: async (u: string) => {
    triggers.push(u)
  },
}

const savedFlag = process.env.REMO_CORCH_ENABLED
afterAll(() => {
  if (savedFlag === undefined) delete process.env.REMO_CORCH_ENABLED
  else process.env.REMO_CORCH_ENABLED = savedFlag
})

async function cookieApp(userId = 'u1') {
  const { createCorchRoutes } = await import('../src/corch/routes.ts')
  const corchRoutes = createCorchRoutes(fakeDeps)
  const app = new Hono<{ Variables: { userId: string } }>()
  app.use('*', async (c, next) => {
    c.set('userId', userId)
    await next()
  })
  app.route('/api/corch', corchRoutes)
  return app
}

const post = (body: unknown) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})
const patch = (body: unknown) => ({ ...post(body), method: 'PATCH' })
const tick = () => new Promise((r) => setTimeout(r, 5))

beforeEach(() => {
  projects = []
  items = []
  writes = []
  triggers = []
  seq = 0
  delete process.env.REMO_CORCH_ENABLED
})

describe('POST /api/corch/projects', () => {
  test('canonicalizes, applies defaults, 201 then 200', async () => {
    const app = await cookieApp()
    const r = await app.request('/api/corch/projects', post({ repo_ident: 'GitHub://Acme/App' }))
    expect(r.status).toBe(201)
    const j: any = await r.json()
    expect(j.created).toBe(true)
    expect(j.project).toMatchObject({
      repo_ident: 'github://acme/app', priority: 0, daily_token_budget: 2000000, enabled: true, accept_external: false,
    })
    const again = await app.request('/api/corch/projects', post({ repo_ident: 'github://acme/app' }))
    expect(again.status).toBe(200)
    expect(((await again.json()) as any).created).toBe(false)
  })
  test('path:// is 400 path_ident_not_supported; other shapes and zero budget are 400', async () => {
    const app = await cookieApp()
    const p = await app.request('/api/corch/projects', post({ repo_ident: 'path://C:/x' }))
    expect(p.status).toBe(400)
    expect(((await p.json()) as any).error).toBe('path_ident_not_supported')
    for (const bad of ['acme/app', 'https://github.com/a/b', 'github://acme', 'github://a/b/c']) {
      expect((await app.request('/api/corch/projects', post({ repo_ident: bad }))).status).toBe(400)
    }
    expect((await app.request('/api/corch/projects', post({ repo_ident: 'github://a/b', daily_token_budget: 0 }))).status).toBe(400)
    expect(writes.length).toBe(0)
  })
})

describe('GET/PATCH projects', () => {
  test('GET lists only the caller rows ordered by priority', async () => {
    const a = await cookieApp('u1')
    const b = await cookieApp('u2')
    await a.request('/api/corch/projects', post({ repo_ident: 'github://a/one', priority: 1 }))
    await a.request('/api/corch/projects', post({ repo_ident: 'github://a/two', priority: 5 }))
    await b.request('/api/corch/projects', post({ repo_ident: 'github://b/x' }))
    const j: any = await (await a.request('/api/corch/projects')).json()
    expect(j.projects.map((p: any) => p.repo_ident)).toEqual(['github://a/two', 'github://a/one'])
  })
  test('PATCH updates allowed fields only; other user id is 404', async () => {
    const a = await cookieApp('u1')
    const b = await cookieApp('u2')
    const created: any = await (await a.request('/api/corch/projects', post({ repo_ident: 'github://a/one' }))).json()
    const id = created.project.id
    const r = await a.request(`/api/corch/projects/${id}`, patch({ priority: 9, repo_ident: 'github://evil/x', user_id: 'u2' }))
    expect(r.status).toBe(200)
    const j: any = await r.json()
    expect(j.project.priority).toBe(9)
    expect(j.project.repo_ident).toBe('github://a/one')
    expect((await b.request(`/api/corch/projects/${id}`, patch({ priority: 1 }))).status).toBe(404)
    expect((await a.request(`/api/corch/projects/${id}`, patch({ daily_token_budget: 0 }))).status).toBe(400)
  })
  test('PATCH enabled false->true triggers evaluate once when ON, never when OFF', async () => {
    const a = await cookieApp()
    const created: any = await (
      await a.request('/api/corch/projects', post({ repo_ident: 'github://a/one', enabled: false }))
    ).json()
    const id = created.project.id
    await a.request(`/api/corch/projects/${id}`, patch({ enabled: true }))
    await tick()
    expect(triggers.length).toBe(0) // flag OFF
    await a.request(`/api/corch/projects/${id}`, patch({ enabled: false }))
    process.env.REMO_CORCH_ENABLED = '1'
    await a.request(`/api/corch/projects/${id}`, patch({ enabled: true }))
    await tick()
    expect(triggers).toEqual(['u1'])
    await a.request(`/api/corch/projects/${id}`, patch({ enabled: true })) // true->true: no trigger
    await tick()
    expect(triggers.length).toBe(1)
  })
})

describe('POST/GET /api/corch/work-items', () => {
  async function withProject(app: Hono<any>) {
    const c: any = await (await app.request('/api/corch/projects', post({ repo_ident: 'github://a/one' }))).json()
    return c.project.id as string
  }
  test('creates manual item with server-owned fields, defaults source_ref, ignores spoofed fields', async () => {
    const app = await cookieApp()
    const pid = await withProject(app)
    const r = await app.request('/api/corch/work-items', post({
      project_id: pid, title: 'do it', counter_key: 'task:evil', status: 'done', branch: 'main', attempts: 99,
    }))
    expect(r.status).toBe(201)
    const j: any = await r.json()
    expect(j.created).toBe(true)
    expect(j.item.source).toBe('manual')
    expect(j.item.source_ref).toMatch(/^manual:/)
    expect(j.item.status).toBe('queued')
    expect(j.item.attempts).toBe(0)
    expect(j.item.branch).toBe(`corch/${j.item.id}`)
    expect(j.item.counter_key).toBeUndefined()
  })
  test('same source_ref is idempotent (200, created=false)', async () => {
    const app = await cookieApp()
    const pid = await withProject(app)
    expect((await app.request('/api/corch/work-items', post({ project_id: pid, title: 't', source_ref: 'r1' }))).status).toBe(201)
    const again = await app.request('/api/corch/work-items', post({ project_id: pid, title: 't2', source_ref: 'r1' }))
    expect(again.status).toBe(200)
    expect(((await again.json()) as any).created).toBe(false)
  })
  test("another user's project is 404; bounds enforced", async () => {
    const a = await cookieApp('u1')
    const b = await cookieApp('u2')
    const pid = await withProject(a)
    expect((await b.request('/api/corch/work-items', post({ project_id: pid, title: 't' }))).status).toBe(404)
    expect((await a.request('/api/corch/work-items', post({ project_id: pid, title: '' }))).status).toBe(400)
    expect((await a.request('/api/corch/work-items', post({ project_id: pid, title: 'x'.repeat(501) }))).status).toBe(400)
    expect((await a.request('/api/corch/work-items', post({ project_id: pid, title: 't', body: 'x'.repeat(20001) }))).status).toBe(400)
  })
  test('trigger fires once when ON on create, zero when OFF or when not created', async () => {
    const app = await cookieApp()
    const pid = await withProject(app)
    await app.request('/api/corch/work-items', post({ project_id: pid, title: 't', source_ref: 'a' }))
    await tick()
    expect(triggers.length).toBe(0)
    process.env.REMO_CORCH_ENABLED = '1'
    await app.request('/api/corch/work-items', post({ project_id: pid, title: 't', source_ref: 'b' }))
    await app.request('/api/corch/work-items', post({ project_id: pid, title: 't', source_ref: 'b' }))
    await tick()
    expect(triggers).toEqual(['u1'])
  })
  test('GET lists the caller items by status', async () => {
    const app = await cookieApp()
    const pid = await withProject(app)
    await app.request('/api/corch/work-items', post({ project_id: pid, title: 't', source_ref: 'a' }))
    const j: any = await (await app.request('/api/corch/work-items?status=queued')).json()
    expect(j.items.length).toBe(1)
    expect(((await (await app.request('/api/corch/work-items?status=done')).json()) as any).items.length).toBe(0)
    expect((await app.request('/api/corch/work-items?status=bogus')).status).toBe(400)
  })
})

describe('POST /api/ext/corch/work-items (handler; the ext:corch scope gate is pinned in api-keys-scopes.test.ts)', () => {
  async function extApp() {
    const { createExtCorchRoutes } = await import('../src/corch/routes.ts')
    const app = new Hono<{ Variables: { userId: string } }>()
    app.use('*', async (c, next) => {
      c.set('userId', 'u1')
      await next()
    })
    app.route('/api/ext/corch', createExtCorchRoutes(fakeDeps))
    return app
  }
  const ext = (body: unknown) => ({
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const ok = { repo_ident: 'github://a/one', source: 'aaf', source_ref: 'aaf-1', title: 't' }

  test('project not enrolled, disabled, or not accepting external => 403 project_not_accepting, zero writes', async () => {
    const app = await extApp()
    const r = await app.request('/api/ext/corch/work-items', ext(ok))
    expect(r.status).toBe(403)
    expect(((await r.json()) as any).error).toBe('project_not_accepting')
    projects.push({ id: 'p1', user_id: 'u1', repo_ident: 'github://a/one', enabled: false, accept_external: true })
    expect((await app.request('/api/ext/corch/work-items', ext(ok))).status).toBe(403)
    projects[0]!.enabled = true
    projects[0]!.accept_external = false
    expect((await app.request('/api/ext/corch/work-items', ext(ok))).status).toBe(403)
    expect(writes.length).toBe(0)
  })
  test('accepted: enqueues with the key user; source and source_ref validated', async () => {
    projects.push({ id: 'p1', user_id: 'u1', repo_ident: 'github://a/one', enabled: true, accept_external: true })
    const app = await extApp()
    const r = await app.request('/api/ext/corch/work-items', ext(ok))
    expect(r.status).toBe(201)
    expect(items[0]).toMatchObject({ user_id: 'u1', source: 'aaf', source_ref: 'aaf-1', project_id: 'p1' })
    expect((await app.request('/api/ext/corch/work-items', ext({ ...ok, source: 'gsd_console' }))).status).toBe(400)
    expect((await app.request('/api/ext/corch/work-items', ext({ ...ok, source_ref: '' }))).status).toBe(400)
    const { source_ref: _omit, ...noRef } = ok
    expect((await app.request('/api/ext/corch/work-items', ext(noRef))).status).toBe(400)
  })
})

describe('PATCH /api/corch/projects/:id with a non-UUID id (QC round 1 LOW 3)', () => {
  test('404 project_not_found without reaching the store (Postgres would raise 22P02 => 500)', async () => {
    const { createCorchRoutes } = await import('../src/corch/routes.ts')
    let reached = 0
    const strict = {
      ...fakeStore,
      async updateProject() {
        reached++
        throw new Error('invalid input syntax for type uuid')
      },
    }
    const app = new Hono<{ Variables: { userId: string } }>()
    app.use('*', async (c, next) => {
      c.set('userId', 'u1')
      await next()
    })
    app.route('/api/corch', createCorchRoutes({ ...fakeDeps, store: strict as any }))
    const r = await app.request('/api/corch/projects/not-a-uuid', patch({ priority: 1 }))
    expect(r.status).toBe(404)
    expect(await r.json()).toEqual({ error: 'project_not_found' })
    expect(reached).toBe(0)
  })
})
