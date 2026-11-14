// CORCH-11 e2e on real Postgres: pause gates claimNext (live runs continue), priority changes selection order
// (R1.6 ORDER BY), cancel works only on queued. Skips only when REMO_E2E_DB_URL is unset.
import { describe, test, expect, beforeAll, beforeEach, afterAll } from 'bun:test'

const HAS_TEST_DB = !!process.env.REMO_E2E_DB_URL
const maybe = HAS_TEST_DB ? describe : describe.skip

maybe('CORCH-11 e2e - pause, priority, cancel, queue view on real Postgres', () => {
  let harness: typeof import('./orchestrator-harness.ts')
  let h: import('./orchestrator-harness.ts').Harness
  let store: typeof import('../../src/corch/store.ts').corchStore
  let view: typeof import('../../src/corch/queue-view.ts')
  let p1: string
  let p2: string

  beforeAll(async () => {
    process.env.DATABASE_URL = process.env.REMO_E2E_DB_URL!
    harness = await import('./orchestrator-harness.ts')
    h = await harness.setupHarness()
    store = (await import('../../src/corch/store.ts')).corchStore
    view = await import('../../src/corch/queue-view.ts')
    const a = await h.sql<{ id: string }[]>`
      INSERT INTO corch_projects (user_id, repo_ident, priority, aaf_provision_status) VALUES (${h.userId}, 'github://acme/one', 0, 'provisioned') RETURNING id`
    const b = await h.sql<{ id: string }[]>`
      INSERT INTO corch_projects (user_id, repo_ident, priority, aaf_provision_status) VALUES (${h.userId}, 'github://acme/two', 0, 'provisioned') RETURNING id`
    p1 = a[0]!.id
    p2 = b[0]!.id
  }, 60_000)

  beforeEach(async () => {
    await h.sql`DELETE FROM corch_runs WHERE user_id = ${h.userId}`
    await h.sql`DELETE FROM corch_work_items WHERE user_id = ${h.userId}`
    await h.sql`UPDATE users SET corch_paused = false, corch_max_concurrent_runs = 2 WHERE id = ${h.userId}`
  })

  afterAll(async () => {
    if (h) await harness.teardownHarness(h)
  })

  const enqueue = (projectId: string, ref: string, priority = 0) =>
    store.enqueueWorkItem({ userId: h.userId, projectId, source: 'manual', sourceRef: ref, title: ref, body: '', priority })

  test('corch_paused defaults to false (additive column)', async () => {
    const s = await store.getSettings(h.userId)
    expect(s).toEqual({ corch_paused: false, corch_max_concurrent_runs: 2 })
  })

  test('paused dispatches nothing; a live run continues; resume claims again', async () => {
    const a = await enqueue(p1, 'a')
    await enqueue(p2, 'b')
    // one live run first
    const first = await store.claimNext(h.userId, [])
    expect(first).not.toBeNull()

    const r = await store.updateSettings(h.userId, { paused: true })
    expect(r!.previousPaused).toBe(false)
    expect(r!.settings.corch_paused).toBe(true)

    // paused: the second queued item is NOT claimed
    expect(await store.claimNext(h.userId, [])).toBeNull()
    const live = await h.sql`SELECT count(*)::int AS n FROM corch_runs WHERE user_id = ${h.userId} AND ended_at IS NULL`
    expect(live[0]!.n).toBe(1) // the live run is untouched
    const stillQueued = await h.sql`SELECT count(*)::int AS n FROM corch_work_items WHERE user_id = ${h.userId} AND status = 'queued'`
    expect(stillQueued[0]!.n).toBe(1)

    const res = await store.updateSettings(h.userId, { paused: false })
    expect(res!.previousPaused).toBe(true)
    const second = await store.claimNext(h.userId, [])
    expect(second).not.toBeNull()
    expect(second!.item.id).not.toBe(first!.item.id)
    void a
  })

  test('priority PATCH changes selection order (item priority, then FIFO)', async () => {
    await enqueue(p1, 'low')
    const hi = await enqueue(p2, 'high')
    // same project priority 0: FIFO would pick "low"; raising "high" must flip it
    const updated = await store.setItemPriority(h.userId, hi.item.id, 5)
    expect(updated!.priority).toBe(5)
    const c = await store.claimNext(h.userId, [])
    expect(c!.item.id).toBe(hi.item.id)
  })

  test('cancel only on queued: queued -> cancelled; running/cancelled/missing refuse', async () => {
    const q = await enqueue(p1, 'q')
    const run = await store.claimNext(h.userId, [])
    expect(run!.item.id).toBe(q.item.id)
    expect(await store.cancelQueuedItem(h.userId, q.item.id)).toEqual({ kind: 'not_queued', status: 'running' })
    const other = await enqueue(p2, 'o')
    const ok = await store.cancelQueuedItem(h.userId, other.item.id)
    expect(ok.kind).toBe('cancelled')
    expect(await store.cancelQueuedItem(h.userId, other.item.id)).toEqual({ kind: 'not_queued', status: 'cancelled' })
    expect(await store.cancelQueuedItem(h.userId, '00000000-0000-4000-8000-000000000000')).toEqual({ kind: 'not_found' })
    // cancelled is terminal: never claimed
    expect(await store.claimNext(h.userId, [])).toBeNull()
  })

  test('pause serializes with claimNext: after updateSettings returns, no claim can start (shared advisory lock)', async () => {
    for (let n = 0; n < 6; n++) await enqueue(n % 2 ? p1 : p2, `race${n}`)
    await h.sql`UPDATE users SET corch_max_concurrent_runs = 6 WHERE id = ${h.userId}`
    // a claim storm racing one pause
    const claims = Array.from({ length: 6 }, () => store.claimNext(h.userId, []))
    const pause = store.updateSettings(h.userId, { paused: true })
    await Promise.allSettled([pause, ...claims])
    const before = await h.sql`SELECT count(*)::int AS n FROM corch_runs WHERE user_id = ${h.userId}`
    // after the pause returned, nothing may claim any more
    expect(await store.claimNext(h.userId, [])).toBeNull()
    const after = await h.sql`SELECT count(*)::int AS n FROM corch_runs WHERE user_id = ${h.userId}`
    expect(after[0]!.n).toBe(before[0]!.n)
  })

  test('a pile of blocked items cannot hide queued ones; counts are uncapped', async () => {
    for (let n = 0; n < 4; n++) {
      const b = await enqueue(p1, `blk${n}`, 100)
      await h.sql`UPDATE corch_work_items SET status = 'blocked' WHERE id = ${b.item.id}`
    }
    await enqueue(p2, 'visible', 0)
    const items = await store.queueViewItems(h.userId, 2) // cap smaller than the blocked pile
    expect(items[0]!.status).toBe('queued')
    const counts = await store.queueViewCounts(h.userId)
    expect(counts.blocked).toBe(4)
    expect(counts.queued).toBe(1)
  })

  test('queue view: items in dispatch order, live runs, settings, no body field', async () => {
    await enqueue(p1, 'x', 1)
    await enqueue(p2, 'y', 2)
    await store.claimNext(h.userId, []) // y runs
    const snap = await view.buildQueueSnapshot(
      {
        store,
        accountsFor: async () => [],
        liveRunsByAccount: async () => ({}),
        ceilingPct: () => 55,
        now: () => new Date(),
      },
      h.userId,
    )
    expect(snap.paused).toBe(false)
    expect(snap.max_concurrent_runs).toBe(2)
    expect(snap.projects.length).toBe(2)
    expect(snap.live_runs.length).toBe(1)
    expect(snap.items.map((i) => i.status).sort()).toEqual(['queued', 'running'])
    expect(Object.keys(snap.items[0]!)).not.toContain('body')
  })
})
