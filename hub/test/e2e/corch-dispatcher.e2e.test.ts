// CORCH-01 e2e on real Postgres. Skips only when REMO_E2E_DB_URL is unset.
import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { randomUUID } from 'node:crypto'

const HAS_TEST_DB = !!process.env.REMO_E2E_DB_URL
const maybe = HAS_TEST_DB ? describe : describe.skip

maybe('CORCH-01 e2e - fail-closed dispatcher on real Postgres', () => {
  let harness: typeof import('./orchestrator-harness.ts')
  let h: import('./orchestrator-harness.ts').Harness
  let storeMod: typeof import('../../src/corch/store.ts')
  let dispMod: typeof import('../../src/corch/dispatcher.ts')
  let projectId: string
  const REPO = 'github://acme/app'
  const savedFlag = process.env.REMO_CORCH_ENABLED

  beforeAll(async () => {
    process.env.DATABASE_URL = process.env.REMO_E2E_DB_URL!
    harness = await import('./orchestrator-harness.ts')
    h = await harness.setupHarness()
    storeMod = await import('../../src/corch/store.ts')
    dispMod = await import('../../src/corch/dispatcher.ts')
    const p = await h.sql<{ id: string }[]>`
      INSERT INTO corch_projects (user_id, repo_ident) VALUES (${h.userId}, ${REPO}) RETURNING id`
    projectId = p[0]!.id
  }, 60_000)

  afterAll(async () => {
    if (savedFlag === undefined) delete process.env.REMO_CORCH_ENABLED
    else process.env.REMO_CORCH_ENABLED = savedFlag
    if (h) await harness.teardownHarness(h)
  })

  function spyLaunch() {
    const calls: string[] = []
    const launch = new Proxy({} as Record<string, unknown>, {
      get: (_t, prop) => (..._a: unknown[]) => {
        calls.push(String(prop))
        throw new Error(`launch.${String(prop)} must never be called`)
      },
    })
    return { launch: launch as any, calls }
  }

  test('tracer: default workspace refuses, item stays queued, no launch', async () => {
    process.env.REMO_CORCH_ENABLED = '1'
    const a = await storeMod.corchStore.enqueueWorkItem({
      userId: h.userId, projectId, source: 'manual', sourceRef: 'tracer-1', title: 't', body: '', priority: 0,
    })
    expect(a.created).toBe(true)
    // CORCH-R1.5: same (source, source_ref) is idempotent.
    const b = await storeMod.corchStore.enqueueWorkItem({
      userId: h.userId, projectId, source: 'manual', sourceRef: 'tracer-1', title: 'other', body: '', priority: 5,
    })
    expect(b.created).toBe(false)
    expect(b.item.id).toBe(a.item.id)

    const { launch, calls } = spyLaunch()
    const d = dispMod.createCorchDispatcher({
      store: storeMod.corchStore, workspace: dispMod.DEFAULT_WORKSPACE, launch,
    } as unknown as import('../../src/corch/dispatcher.ts').CorchDeps)
    const r = await d.evaluateUser(h.userId)
    expect(r.kind).toBe('done')

    const item = (await h.sql`SELECT * FROM corch_work_items WHERE id = ${a.item.id}`)[0]!
    expect(item.status).toBe('queued')
    expect(item.attempts).toBe(0)
    expect(item.wait_reason).toBe('workspace_unavailable')
    const runs = await h.sql`SELECT * FROM corch_runs WHERE work_item_id = ${a.item.id}`
    expect(runs.length).toBe(1)
    expect(runs[0]!.ended_at).not.toBeNull()
    expect(runs[0]!.end_reason).toBe('workspace_unavailable')
    const live = await h.sql`SELECT 1 FROM corch_runs WHERE user_id = ${h.userId} AND ended_at IS NULL`
    expect(live.length).toBe(0)
    expect(calls.length).toBe(0)
  })

  test('flag off: evaluateUser is disabled and writes nothing', async () => {
    delete process.env.REMO_CORCH_ENABLED
    const before = (await h.sql`SELECT count(*)::int AS n FROM corch_runs WHERE user_id = ${h.userId}`)[0]!.n
    const { launch } = spyLaunch()
    const d = dispMod.createCorchDispatcher({
      store: storeMod.corchStore, workspace: dispMod.DEFAULT_WORKSPACE, launch,
    } as unknown as import('../../src/corch/dispatcher.ts').CorchDeps)
    expect(await d.evaluateUser(h.userId)).toEqual({ kind: 'disabled' })
    const after = (await h.sql`SELECT count(*)::int AS n FROM corch_runs WHERE user_id = ${h.userId}`)[0]!.n
    expect(after).toBe(before)
  })

  test('concurrent claim race at cap 1: exactly one claim per user and per project', async () => {
    const items = []
    for (let i = 0; i < 3; i++) {
      items.push(
        await storeMod.corchStore.enqueueWorkItem({
          userId: h.userId, projectId, source: 'manual', sourceRef: `race-${randomUUID()}`, title: 'r', body: '', priority: 0,
        }),
      )
    }
    const results = await Promise.all(
      Array.from({ length: 8 }, () => storeMod.corchStore.claimNext(h.userId, [])),
    )
    const won = results.filter((r) => r !== null)
    expect(won.length).toBe(1)
    const live = await h.sql`SELECT work_item_id FROM corch_runs WHERE user_id = ${h.userId} AND ended_at IS NULL`
    expect(live.length).toBe(1)
    // end it: second delivery is a no-op (LD-9)
    const runId = won[0]!.run.id
    const first = await storeMod.corchStore.endRunAndRequeue(runId, {
      endReason: 'no_pr', consumeAttempt: true, waitReason: null, notBefore: null,
    })
    expect(first.changed).toBe(true)
    const second = await storeMod.corchStore.endRunAndRequeue(runId, {
      endReason: 'no_pr', consumeAttempt: true, waitReason: null, notBefore: null,
    })
    expect(second.changed).toBe(false)
    const it = (await h.sql`SELECT attempts FROM corch_work_items WHERE id = ${won[0]!.item.id}`)[0]!
    expect(it.attempts).toBe(1)
  })
})
