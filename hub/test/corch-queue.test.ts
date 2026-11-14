// CORCH-11 (R6.1-R6.4): queue view, pause/resume, priority + cancel routes, WS publisher, Telegram /queue lockstep.
// Store + trigger injected (no module mocks).
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-chars-long-aaaaaaaa'
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'session-secret-at-least-32-chars-long-x'
process.env.MAGIC_LINK_SECRET = process.env.MAGIC_LINK_SECRET || 'magic-link-secret-at-least-32-chars-x'
process.env.TITANIUM_KEYGEN_API_URL = process.env.TITANIUM_KEYGEN_API_URL || 'https://keygen.titaniumlabs.us'
process.env.TITANIUM_KEYGEN_ACCOUNT_ID = process.env.TITANIUM_KEYGEN_ACCOUNT_ID || 'acct_test_0000000000'
process.env.TITANIUM_KEYGEN_PRODUCT_ID = process.env.TITANIUM_KEYGEN_PRODUCT_ID || 'prod_test_remo'
import { describe, test, expect, beforeEach, afterAll } from 'bun:test'
import { Hono } from 'hono'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ITEM = '10000000-0000-4000-8000-000000000001'
let settings = { corch_paused: false, corch_max_concurrent_runs: 1 }
let itemStatus = 'queued'
let triggers: string[] = []
let published: string[] = []
const calls: string[] = []

const fakeStore = {
  async updateSettings(_u: string, p: { paused?: boolean; maxConcurrentRuns?: number }) {
    const previousPaused = settings.corch_paused
    if (p.paused !== undefined) settings.corch_paused = p.paused
    if (p.maxConcurrentRuns !== undefined) settings.corch_max_concurrent_runs = p.maxConcurrentRuns
    return { settings: { ...settings }, previousPaused }
  },
  async setItemPriority(_u: string, id: string, priority: number) {
    calls.push(`prio:${id}:${priority}`)
    return id === ITEM ? { id, priority, status: itemStatus } : null
  },
  async cancelQueuedItem(_u: string, id: string) {
    if (id !== ITEM) return { kind: 'not_found' }
    if (itemStatus !== 'queued') return { kind: 'not_queued', status: itemStatus }
    itemStatus = 'cancelled'
    return { kind: 'cancelled', item: { id, status: 'cancelled' } }
  },
}

const SNAP = { paused: false, max_concurrent_runs: 1, counts: {}, projects: [], items: [], live_runs: [], quota_accounts: [], generated_at: 'x' }
const deps = {
  store: fakeStore as any,
  evaluate: async (u: string) => void triggers.push(u),
  provision: async (p: any) => p,
  queue: async () => SNAP as any,
  publish: (u: string) => void published.push(u),
}

const savedFlag = process.env.REMO_CORCH_ENABLED
afterAll(() => {
  if (savedFlag === undefined) delete process.env.REMO_CORCH_ENABLED
  else process.env.REMO_CORCH_ENABLED = savedFlag
})
beforeEach(() => {
  settings = { corch_paused: false, corch_max_concurrent_runs: 1 }
  itemStatus = 'queued'
  triggers = []
  published = []
  calls.length = 0
  delete process.env.REMO_CORCH_ENABLED
})

async function app(over: Partial<typeof deps> = {}) {
  const { createCorchRoutes } = await import('../src/corch/routes.ts')
  const a = new Hono<{ Variables: { userId: string } }>()
  a.use('*', async (c, next) => {
    c.set('userId', 'u1')
    await next()
  })
  a.route('/api/corch', createCorchRoutes({ ...deps, ...over }))
  return a
}
const send = (method: string, body?: unknown) => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
})
const tick = () => new Promise((r) => setTimeout(r, 5))

describe('GET /api/corch/queue (R6.1)', () => {
  test('returns the snapshot, flag OFF too', async () => {
    const r = await (await app()).request('/api/corch/queue')
    expect(r.status).toBe(200)
    expect(Object.keys(await r.json()).sort()).toEqual(Object.keys(SNAP).sort())
  })
  test('a failing read model is a 500 queue_unavailable', async () => {
    const a = await app({ queue: async () => { throw new Error('boom') } })
    const r = await a.request('/api/corch/queue')
    expect(r.status).toBe(500)
    expect((await r.json()).error).toBe('queue_unavailable')
  })
})

describe('pause / resume (R6.2)', () => {
  test('pause stores the flag and publishes, no evaluation', async () => {
    process.env.REMO_CORCH_ENABLED = '1'
    const r = await (await app()).request('/api/corch/settings', send('PATCH', { paused: true }))
    expect(r.status).toBe(200)
    expect((await r.json()).settings.corch_paused).toBe(true)
    await tick()
    expect(published).toEqual(['u1'])
    expect(triggers).toEqual([])
  })
  test('resume triggers exactly one evaluation (flag ON)', async () => {
    process.env.REMO_CORCH_ENABLED = '1'
    settings.corch_paused = true
    await (await app()).request('/api/corch/settings', send('PATCH', { paused: false }))
    await tick()
    expect(triggers).toEqual(['u1'])
  })
  test('resume with the flag OFF stores only: no evaluation', async () => {
    settings.corch_paused = true
    await (await app()).request('/api/corch/settings', send('PATCH', { paused: false }))
    await tick()
    expect(triggers).toEqual([])
    expect(settings.corch_paused).toBe(false)
  })
  test('empty / invalid patches are 400', async () => {
    const a = await app()
    expect((await a.request('/api/corch/settings', send('PATCH', {}))).status).toBe(400)
    expect((await a.request('/api/corch/settings', send('PATCH', { max_concurrent_runs: 0 }))).status).toBe(400)
    expect((await a.request('/api/corch/settings', send('PATCH', { paused: 'yes' }))).status).toBe(400)
  })
  test('the kill switch is independent: pause code never references it, and the gate list is untouched', () => {
    const src = (f: string) =>
      readFileSync(join(import.meta.dir, '..', 'src', 'corch', f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[ 	])\/\/.*$/gm, '$1')
    expect(src('routes.ts')).not.toMatch(/kill.?switch|automation-controls/i)
    expect(src('queue-view.ts')).not.toMatch(/kill.?switch|automation-controls/i)
    expect(src('gates.ts')).not.toMatch(/corch_paused|paused/)
    expect(src('store.ts')).toMatch(/cap\[0\]!\.paused/)
  })
})

describe('priority + cancel (R6.3)', () => {
  test('PATCH item priority', async () => {
    const a = await app()
    const r = await a.request(`/api/corch/work-items/${ITEM}`, send('PATCH', { priority: 7 }))
    expect(r.status).toBe(200)
    expect(calls).toEqual([`prio:${ITEM}:7`])
    expect(published).toEqual(['u1'])
    expect((await a.request('/api/corch/work-items/not-a-uuid', send('PATCH', { priority: 1 }))).status).toBe(404)
    expect((await a.request(`/api/corch/work-items/${ITEM}`, send('PATCH', { priority: 1.5 }))).status).toBe(400)
    expect((await a.request('/api/corch/work-items/20000000-0000-4000-8000-000000000009', send('PATCH', { priority: 1 }))).status).toBe(404)
  })
  test('cancel works on queued, every other state is 409 and publishes nothing', async () => {
    const a = await app()
    const ok = await a.request(`/api/corch/work-items/${ITEM}/cancel`, send('POST'))
    expect(ok.status).toBe(200)
    expect(published).toEqual(['u1'])
    for (const st of ['running', 'pr_open', 'done', 'blocked', 'cancelled']) {
      itemStatus = st
      published = []
      const r = await a.request(`/api/corch/work-items/${ITEM}/cancel`, send('POST'))
      expect(r.status).toBe(409)
      expect((await r.json()).status).toBe(st)
      expect(published).toEqual([])
    }
    expect((await a.request('/api/corch/work-items/bad/cancel', send('POST'))).status).toBe(404)
  })
})

describe('queue snapshot builder + WS publisher (R6.1, no polling)', () => {
  test('buildQueueSnapshot joins quota eligibility and serializes dates', async () => {
    const { buildQueueSnapshot } = await import('../src/corch/queue-view.ts')
    const now = new Date('2026-11-14T12:00:00Z')
    const snap = await buildQueueSnapshot(
      {
        store: {
          listProjects: async () => [{ id: 'p1', repo_ident: 'github://a/b', priority: 2, enabled: true, aaf_provision_status: 'provisioned' }] as any,
          getSettings: async () => ({ corch_paused: true, corch_max_concurrent_runs: 2 }),
          queueViewItems: async () => [{ id: 'i1', project_id: 'p1', repo_ident: 'github://a/b', title: 't', source: 'manual', priority: 0, status: 'queued', wait_reason: 'quota:x', not_before: now, attempts: 1, pr_url: null, created_at: now }] as any,
          queueViewCounts: async () => ({ queued: 1 }),
          queueViewRuns: async () => [{ id: 'r1', work_item_id: 'i1', repo_ident: 'github://a/b', status: 'running', account_slot: 'a1', supervisor_id: 's', started_at: new Date(now.getTime() - 90_000), heartbeat_at: now }] as any,
        },
        accountsFor: async () => [],
        liveRunsByAccount: async () => ({}),
        ceilingPct: () => 55,
        now: () => now,
      },
      'u1',
    )
    expect(snap.paused).toBe(true)
    expect(snap.counts).toEqual({ queued: 1 })
    expect(snap.max_concurrent_runs).toBe(2)
    expect(snap.items[0]!.not_before).toBe(now.toISOString())
    expect(snap.live_runs[0]!.age_seconds).toBe(90)
    expect(JSON.stringify(snap)).not.toMatch(/email|token/i)
  })

  test('publisher coalesces overlapping calls and always ends on the newest build', async () => {
    const { createQueuePublisher } = await import('../src/corch/queue-view.ts')
    let n = 0
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const sent: number[] = []
    const pub = createQueuePublisher(
      async () => {
        const mine = ++n
        if (mine === 1) await gate
        return { ...SNAP, generated_at: String(mine) } as any
      },
      (_u, e) => void sent.push(Number(e.queue.generated_at)),
    )
    const p1 = pub('u1')
    pub('u1')
    pub('u1')
    release()
    await p1
    expect(sent).toEqual([1, 2]) // three triggers during one build collapse into one rebuild
    expect(sent.at(-1)).toBe(n)
  })

  test('a failed build never discards a trigger that arrived meanwhile (it still gets its own rebuild)', async () => {
    const { createQueuePublisher } = await import('../src/corch/queue-view.ts')
    let n = 0
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const sent: number[] = []
    const logs: string[] = []
    const pub = createQueuePublisher(
      async () => {
        const mine = ++n
        if (mine === 1) {
          await gate
          throw new Error('transient')
        }
        return { ...SNAP, generated_at: String(mine) } as any
      },
      (_u, e) => void sent.push(Number(e.queue.generated_at)),
      (m) => logs.push(m),
    )
    const p1 = pub('u1')
    pub('u1') // arrives while build 1 is pending
    release()
    await p1
    expect(logs.length).toBe(1)
    expect(sent).toEqual([2])
  })

  test('publisher swallows build failures (never blocks a transition)', async () => {
    const { createQueuePublisher } = await import('../src/corch/queue-view.ts')
    const logs: string[] = []
    const pub = createQueuePublisher(async () => { throw new Error('db down') }, () => {}, (m) => logs.push(m))
    await pub('u1')
    expect(logs.length).toBe(1)
  })
})

describe('Telegram /queue (R6.4)', () => {
  test('lockstep: BOT_COMMANDS and the parser and the webhook switch all carry queue', async () => {
    const { BOT_COMMANDS, parseCommand, HELP_TEXT } = await import('../src/telegram/commands.ts')
    expect(BOT_COMMANDS.some((c) => c.command === 'queue')).toBe(true)
    expect(parseCommand('/queue').kind).toBe('queue')
    expect(HELP_TEXT).toContain('/queue')
    // Every advertised command parses to a known kind and has a webhook case.
    const webhook = readFileSync(join(import.meta.dir, '..', 'src', 'api', 'telegram-webhook.ts'), 'utf8')
    for (const c of BOT_COMMANDS) {
      const kind = parseCommand(`/${c.command}`).kind
      expect(kind).not.toBe('unknown')
      expect(webhook).toContain(`case "${kind}":`)
    }
  })

  test('read-only: the queue case only reads (no store write, no settings, no cancel)', () => {
    const webhook = readFileSync(join(import.meta.dir, '..', 'src', 'api', 'telegram-webhook.ts'), 'utf8')
    const block = webhook.slice(webhook.indexOf('case "queue":'), webhook.indexOf('case "stop":'))
    expect(block).toContain('buildQueueSnapshot')
    expect(block).not.toMatch(/updateSettings|cancelQueuedItem|setItemPriority|corchStore/)
  })

  test('summary: paused flag, live runs, top 5 queued with wait reasons, blocked count', async () => {
    const { renderQueueSummary } = await import('../src/corch/queue-telegram.ts')
    const items = Array.from({ length: 7 }, (_, i) => ({ id: `i${i}`, repo_ident: 'github://a/b', title: `T${i}`, priority: i, status: 'queued', wait_reason: i === 0 ? 'quota:5h' : null }))
    items.push({ id: 'b', repo_ident: 'github://a/b', title: 'x', priority: 0, status: 'blocked', wait_reason: null })
    const text = renderQueueSummary({ ...SNAP, counts: { queued: 7, blocked: 1 }, paused: true, items, live_runs: [{ repo_ident: 'github://a/c', status: 'running', account_slot: 's1' }] } as any)
    expect(text).toContain('PAUSED')
    expect(text).toContain('Live runs: 1/1')
    expect(text).toContain('Queued: 7')
    expect(text).toContain('waiting: quota:5h')
    expect(text).toContain('...and 2 more')
    expect(text).toContain('Blocked: 1')
    expect(text).not.toContain('T6')
  })

  test('counts come from the uncapped aggregates, not the capped item list', async () => {
    const { renderQueueSummary } = await import('../src/corch/queue-telegram.ts')
    const text = renderQueueSummary({ ...SNAP, counts: { queued: 40, blocked: 300 }, items: [] } as any)
    expect(text).toContain('Queued: 40')
    expect(text).toContain('...and 35 more')
    expect(text).toContain('Blocked: 300')
  })
})

describe('publish points outside evaluation (QC R2)', () => {
  test('a stalled run confirmed alive by fresh inventory publishes the owner queue (reconciler)', async () => {
    process.env.REMO_CORCH_ENABLED = '1'
    const { reconcilePass } = await import('../src/corch/reconciler.ts')
    const pubs: string[] = []
    const run = { id: 'r1', work_item_id: 'i1', user_id: 'u9', session_id: 's1', supervisor_id: 'sup', status: 'stalled', heartbeat_at: new Date(), started_at: new Date() }
    const deps: any = {
      store: { liveRunsPage: async () => [run], touchHeartbeat: async () => {} },
      inventory: { forSupervisor: () => ({ fresh: true, sessionIds: new Set(['s1']) }), forUser: () => ({ fresh: false, sessionIds: new Set() }) },
      workspace: {},
      publishQueue: (u: string) => void pubs.push(u),
    }
    await reconcilePass(deps, { inFlight: new Set() } as any)
    expect(pubs).toEqual(['u9'])
    // a run that was already running does not publish
    pubs.length = 0
    await reconcilePass({ ...deps, store: { ...deps.store, liveRunsPage: async () => [{ ...run, status: 'running' }] } }, { inFlight: new Set() } as any)
    expect(pubs).toEqual([])
  })
})
