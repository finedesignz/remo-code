// CORCH-04 e2e on real Postgres. Skips only when REMO_E2E_DB_URL is unset.
// The real corchStore with the gsd-console ingest driven by a fake SSE console (no network).
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-chars-long-aaaaaaaa'
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'session-secret-at-least-32-chars-long-x'
process.env.MAGIC_LINK_SECRET = process.env.MAGIC_LINK_SECRET || 'magic-link-secret-at-least-32-chars-x'

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { randomUUID } from 'node:crypto'

const HAS_TEST_DB = !!process.env.REMO_E2E_DB_URL
const maybe = HAS_TEST_DB ? describe : describe.skip

maybe('CORCH-04 e2e - gsd-console ingest on real Postgres', () => {
  let harness: typeof import('./orchestrator-harness.ts')
  let h: import('./orchestrator-harness.ts').Harness
  let store: typeof import('../../src/corch/store.ts').corchStore
  const saved: Record<string, string | undefined> = {}
  const KEYS = ['REMO_CORCH_ENABLED', 'REMO_CORCH_GSDC_URL', 'REMO_CORCH_GSDC_TOKEN']

  beforeAll(async () => {
    process.env.DATABASE_URL = process.env.REMO_E2E_DB_URL!
    for (const k of KEYS) saved[k] = process.env[k]
    process.env.REMO_CORCH_ENABLED = '1'
    process.env.REMO_CORCH_GSDC_URL = 'https://console.example.test'
    process.env.REMO_CORCH_GSDC_TOKEN = 'gsdc_e2e_token'
    harness = await import('./orchestrator-harness.ts')
    h = await harness.setupHarness()
    store = (await import('../../src/corch/store.ts')).corchStore
  }, 60_000)

  afterAll(async () => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
    if (h) await harness.teardownHarness(h)
  })

  const ident = () => `github://e2e-${randomUUID().slice(0, 8)}/app`

  test('listEnabledProjects returns enabled projects only; applyGsdcBoards cancels exactly, queued-only, gsd_console-only, in one transaction', async () => {
    const on = await store.createProject({ userId: h.userId, repoIdent: ident(), priority: 3, dailyTokenBudget: 1000, enabled: true, acceptExternal: false })
    const off = await store.createProject({ userId: h.userId, repoIdent: ident(), priority: 3, dailyTokenBudget: 1000, enabled: false, acceptExternal: false })
    const enabled = (await store.listEnabledProjects()).map((p) => p.id)
    expect(enabled).toContain(on.project.id)
    expect(enabled).not.toContain(off.project.id)

    const mk = (projectId: string, source: 'gsd_console' | 'manual', ref: string) =>
      store.enqueueWorkItem({ userId: h.userId, projectId, source, sourceRef: ref, title: ref, body: '', priority: 1 })
    const target = await mk(on.project.id, 'gsd_console', 'o/n:v1:1')
    const otherRef = await mk(on.project.id, 'gsd_console', 'o/n:v1:2')
    const manual = await mk(on.project.id, 'manual', 'o/n:v1:1')
    const running = await mk(on.project.id, 'gsd_console', 'o/n:v1:3')
    await h.sql`UPDATE corch_work_items SET status = 'running' WHERE id = ${running.item.id}`

    const users = await store.applyGsdcBoards([
      { projectId: on.project.id, userId: h.userId, priority: 1, doneRefs: ['o/n:v1:1', 'o/n:v1:3'], candidate: null },
    ])
    expect(users).toEqual([])
    const st = async (id: string) => (await h.sql`SELECT status FROM corch_work_items WHERE id = ${id}`)[0]!.status as string
    expect(await st(target.item.id)).toBe('cancelled')
    expect(await st(otherRef.item.id)).toBe('queued')
    expect(await st(manual.item.id)).toBe('queued')
    expect(await st(running.item.id)).toBe('running')
    // All or nothing: a failing entry rolls back the earlier entries of the same call.
    const before = await st(otherRef.item.id)
    await expect(
      store.applyGsdcBoards([
        { projectId: on.project.id, userId: h.userId, priority: 1, doneRefs: ['o/n:v1:2'], candidate: null },
        { projectId: '00000000-0000-4000-8000-000000000000', userId: h.userId, priority: 1, doneRefs: [], candidate: { sourceRef: 'x', title: 't', body: '' } },
      ]),
    ).rejects.toBeDefined()
    expect(await st(otherRef.item.id)).toBe(before)
  })

  test('ingest end to end: snapshot queues the phase once (idempotent), a later done snapshot cancels it, a failure changes nothing', async () => {
    const { createGsdcIngest } = await import('../../src/corch/gsdc-ingest.ts')
    const owner = `e2e-${randomUUID().slice(0, 8)}`
    const project = await store.createProject({
      userId: h.userId, repoIdent: `github://${owner}/app`, priority: 4, dailyTokenBudget: 1000, enabled: true, acceptExternal: false,
    })
    const enc = new TextEncoder()
    const sse = (frames: string[]) =>
      new Response(new ReadableStream({ start(c) { for (const f of frames) c.enqueue(enc.encode(f)); c.close() } }), { status: 200 })
    const snap = `event: snapshot\ndata: ${JSON.stringify({ projects: [{ id: 'c1', slug: `${owner}/app`, stale: false, divergent: false, active_runs: 0 }] })}\n\n`
    const board = (cols: any) => ({
      position: { milestone: { version: 'v9', heading: 'M' } },
      snapshot: { state: 'ready', stale: false },
      columns: { done: [], current: [], backlog: [], pending: [], ...cols },
    })
    let phase: 'open' | 'done' | 'fail' = 'open'
    const outages: string[] = []
    const timers: Array<() => void> = []
    const run = async () => {
      const ingest = createGsdcIngest({
        store,
        fetch: async (url) => {
          if (phase === 'fail') return new Response('x', { status: 503 })
          if (url.endsWith('/api/board/stream')) return sse([snap])
          const cols = phase === 'open'
            ? { pending: [{ number: '2', name: 'Two', goal: 'do two' }] }
            : { done: [{ number: '2' }], pending: [{ number: '3', name: 'Three', goal: 'do three' }] }
          return new Response(JSON.stringify(board(cols)), { status: 200 })
        },
        timers: { setTimeout: (fn) => (timers.push(fn), fn), clearTimeout: () => {} },
        notifyOutage: async (o) => void outages.push(o.signature),
        onEnqueued: async () => {},
      })
      ingest.start()
      await new Promise((r) => setTimeout(r, 400)) // real DB round trips: let the event finish
      ingest.stop()
    }
    const items = async () =>
      (await h.sql`SELECT source_ref, status, title FROM corch_work_items WHERE project_id = ${project.project.id} ORDER BY source_ref`) as any[]

    await run()
    await run() // idempotent: same board again
    expect(await items()).toEqual([{ source_ref: `${owner}/app:v9:2`, status: 'queued', title: 'Phase 2: Two' }])

    phase = 'fail'
    await run()
    expect(await items()).toEqual([{ source_ref: `${owner}/app:v9:2`, status: 'queued', title: 'Phase 2: Two' }])
    expect(outages).toEqual(['http_5xx'])

    phase = 'done'
    await run()
    expect(await items()).toEqual([
      { source_ref: `${owner}/app:v9:2`, status: 'cancelled', title: 'Phase 2: Two' },
      { source_ref: `${owner}/app:v9:3`, status: 'queued', title: 'Phase 3: Three' },
    ])
  })
})
