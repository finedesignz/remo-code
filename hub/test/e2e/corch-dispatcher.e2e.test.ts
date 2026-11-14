// CORCH-01 e2e on real Postgres. Skips only when REMO_E2E_DB_URL is unset.
import { describe, test, expect, beforeAll, beforeEach, afterAll, afterEach } from 'bun:test'
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

// ── Task 6: criterion 5 on real Postgres ─────────────────────────────────────
// Real: store, REAL_AUTOSPAWN gate runner / reserve / release / tz / run-log, the real corch gates, the
// real kill switch, cost cap, token cap, inject-rate and lifetime counter. Fakes: launchSessionForUser
// (records), supervisorOnlineForUser, Workspace (inserts a real sessions row), QuotaProvider, PrLookup,
// dispatch (records, returns a chosen outcome; the captured RunStore callbacks are invoked by the tests),
// notify, inventory, timers. Every test owns its user. Env set by a test is restored afterwards.

maybe('CORCH-01 e2e - criterion 5: claims, requeue, refusals, reclaim', () => {
  let harness: typeof import('./orchestrator-harness.ts')
  let h: import('./orchestrator-harness.ts').Harness
  let storeMod: typeof import('../../src/corch/store.ts')
  let dispMod: typeof import('../../src/corch/dispatcher.ts')
  let recMod: typeof import('../../src/corch/reconciler.ts')
  let autoMod: typeof import('../../src/heal/autospawn-deps.ts')
  let ctlMod: typeof import('../../src/dispatch/automation-controls.ts')
  let rowsMod: typeof import('../../src/db/orchestrator-rows-dal.ts')
  const users: string[] = []
  const ENV = [
    'REMO_CORCH_ENABLED',
    'REMO_ORCHESTRATOR_DAILY_TOKEN_CAP',
    'REMO_AUTOMATION_LIFETIME_INJECT_CAP',
    'REMO_ORCHESTRATOR_MAX_INJECTS_PER_HOUR',
  ]
  let saved: Record<string, string | undefined> = {}

  beforeAll(async () => {
    process.env.DATABASE_URL = process.env.REMO_E2E_DB_URL!
    harness = await import('./orchestrator-harness.ts')
    h = await harness.setupHarness()
    storeMod = await import('../../src/corch/store.ts')
    dispMod = await import('../../src/corch/dispatcher.ts')
    recMod = await import('../../src/corch/reconciler.ts')
    autoMod = await import('../../src/heal/autospawn-deps.ts')
    ctlMod = await import('../../src/dispatch/automation-controls.ts')
    rowsMod = await import('../../src/db/orchestrator-rows-dal.ts')
  }, 60_000)

  beforeEach(() => {
    saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]))
    process.env.REMO_CORCH_ENABLED = '1'
  })

  afterEach(async () => {
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
    if (users.length > 0) {
      await h.sql`UPDATE corch_runs SET status = 'ended', end_reason = 'test_cleanup', ended_at = now()
                  WHERE ended_at IS NULL AND user_id = ANY(${users})`
    }
  })

  afterAll(async () => {
    if (h) {
      await h.sql`DELETE FROM automation_kill_switch WHERE user_id = ANY(${users})`
      await h.sql`DELETE FROM automation_inject_ledger WHERE user_id = ANY(${users})`
      await h.sql`DELETE FROM users WHERE id = ANY(${users})`
      await harness.teardownHarness(h)
    }
  })

  // ── helpers (local to this file) ──
  const rand = () => randomUUID().slice(0, 8)

  async function mkUser(maxConcurrent = 1): Promise<string> {
    const r = await h.sql<{ id: string }[]>`
      INSERT INTO users (email, password_hash, role, corch_max_concurrent_runs)
      VALUES (${`e2e-corch-${randomUUID()}@invalid.local`}, 'x', 'user', ${maxConcurrent}) RETURNING id`
    users.push(r[0]!.id)
    return r[0]!.id
  }

  async function mkSession(userId: string): Promise<string> {
    const r = await h.sql<{ id: string }[]>`
      INSERT INTO sessions (user_id, name, project_dir, token_hash)
      VALUES (${userId}, 'corch-e2e', ${'/tmp/corch-e2e-' + randomUUID()}, ${'th-' + randomUUID()}) RETURNING id`
    return r[0]!.id
  }

  async function mkProject(userId: string, repo: string, o: { priority?: number; budget?: number } = {}): Promise<string> {
    const r = await h.sql<{ id: string }[]>`
      INSERT INTO corch_projects (user_id, repo_ident, priority, daily_token_budget)
      VALUES (${userId}, ${repo}, ${o.priority ?? 0}, ${o.budget ?? 2_000_000}) RETURNING id`
    return r[0]!.id
  }

  const enq = (userId: string, projectId: string, ref: string, priority = 0) =>
    storeMod.corchStore.enqueueWorkItem({ userId, projectId, source: 'manual', sourceRef: ref, title: 't', body: 'b', priority })

  async function seedTokens(userId: string, sessionId: string, b: { input?: number; cacheRead?: number; costUsd?: number }) {
    await h.sql`
      INSERT INTO token_usage (user_id, session_id, model, input_tokens, output_tokens,
        cache_creation_input_tokens, cache_read_input_tokens, cost_usd, cost_source, created_at)
      VALUES (${userId}, ${sessionId}, 'claude-test', ${b.input ?? 0}, 0, 0, ${b.cacheRead ?? 0}, ${b.costUsd ?? 0}, 'sdk', now())`
  }

  interface WorldOpts {
    outcome?: any
    quota?: any
    prLookup?: any
    workspace?: any
    onWorkspace?: (c: { userId: string; sessionId: string; runId: string; itemId: string; projectId: string }) => Promise<void>
  }

  function mkWorld(userId: string, o: WorldOpts = {}) {
    const w = {
      launches: [] as any[],
      dispatches: [] as Array<{ req: any; pdeps: any }>,
      notes: [] as any[],
      releases: [] as Array<[string, string]>,
      timeouts: [] as number[],
      outcome: o.outcome ?? { kind: 'dispatched', runId: 'x' },
      inv: { fresh: false, ids: new Set<string>() },
      online: false,
    }
    const deps: any = {
      store: storeMod.corchStore,
      workspace:
        o.workspace ??
        {
          resolve: async (a: any) => {
            const sessionId = await mkSession(a.userId)
            await o.onWorkspace?.({ userId: a.userId, sessionId, runId: a.runId, itemId: a.item.id, projectId: a.project.id })
            return { ok: true, sessionId, worktreePath: 'C:/wt/app' }
          },
        },
      launch: {
        ...autoMod.REAL_AUTOSPAWN,
        isRepoAutospawnAllowed: (u: string, r: string) => storeMod.corchStore.isEnrolledEnabled(u, r),
        supervisorOnlineForUser: async () => true,
        launchSessionForUser: async (a: any) => {
          w.launches.push(a)
          return { ok: true, runId: `sup-run-${w.launches.length}`, supervisorId: 'sup-1' }
        },
      },
      launchCommand: rowsMod.AUTOSPAWN_LAUNCH_COMMAND,
      quota: o.quota ?? { snapshotFor: async () => ({ ok: true, account_slot: 'acct-1', supervisor_id: 'sup-1' }) },
      pipeline: {
        isOnline: async () => true,
        send: async () => {},
        releaseByToken: async (t: string, r: string) => void w.releases.push([t, r]),
      },
      dispatch: async (req: any, pdeps: any) => (w.dispatches.push({ req, pdeps }), w.outcome),
      prLookup: o.prLookup ?? dispMod.DEFAULT_PR_LOOKUP,
      notify: async (n: any) => void w.notes.push(n),
      inventory: {
        forSupervisor: () => ({ fresh: w.inv.fresh, sessionIds: w.inv.ids }),
        forUser: () => ({ fresh: w.inv.fresh, sessionIds: w.inv.ids }),
        isOnline: () => w.online,
      },
      timers: {
        setTimeout: (_fn: () => void, ms: number) => (w.timeouts.push(ms), { id: w.timeouts.length }),
        clearTimeout: () => {},
      },
    }
    return { w, deps, d: dispMod.createCorchDispatcher(deps) }
  }

  const itemRow = async (id: string) => (await h.sql`SELECT * FROM corch_work_items WHERE id = ${id}`)[0]!
  const runRows = async (itemId: string) => h.sql`SELECT * FROM corch_runs WHERE work_item_id = ${itemId} ORDER BY started_at ASC`
  const liveCount = async (userId: string) =>
    (await h.sql`SELECT count(*)::int AS n FROM corch_runs WHERE user_id = ${userId} AND ended_at IS NULL`)[0]!.n as number
  const nextUtcMidnight = () => {
    const d = new Date()
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1)
  }

  // ── CORCH-R1.6: selection order ──
  describe('R1.6 selection order', () => {
    test('project priority, then item priority, then created_at, then id', async () => {
      const userId = await mkUser()
      const pA = await mkProject(userId, 'github://acme/a', { priority: 2 })
      const pB = await mkProject(userId, 'github://acme/b', { priority: 1 })
      const pC = await mkProject(userId, 'github://acme/c', { priority: 0 })
      await enq(userId, pC, 'C1', 99)
      await enq(userId, pB, 'B1', 9)
      await enq(userId, pA, 'A1', 0)
      await enq(userId, pA, 'A2', 5)
      await enq(userId, pC, 'C2', 99)
      await enq(userId, pA, 'A3', 0)
      const order: string[] = []
      const excluded: string[] = []
      for (;;) {
        const c = await storeMod.corchStore.claimNext(userId, excluded)
        if (!c) break
        order.push(c.item.source_ref)
        excluded.push(c.item.id)
        await storeMod.corchStore.endRunAndRequeue(c.run.id, {
          endReason: 'workspace_unavailable', consumeAttempt: false, waitReason: 'workspace_unavailable', notBefore: null,
        })
      }
      expect(order).toEqual(['A2', 'A1', 'A3', 'B1', 'C1', 'C2'])
    })
  })

  // ── CORCH-R1.7: race at cap 1 through the dispatcher ──
  describe('R1.7 concurrent evaluation', () => {
    test('cap 1, two eligible items in two projects: one live run and one launch', async () => {
      const userId = await mkUser(1)
      const p1 = await mkProject(userId, 'github://acme/r1')
      const p2 = await mkProject(userId, 'github://acme/r2')
      await enq(userId, p1, 'x1')
      await enq(userId, p2, 'x2')
      const { w, d } = mkWorld(userId)
      await Promise.all([d.evaluateUser(userId), d.evaluateUser(userId)])
      expect(await liveCount(userId)).toBe(1)
      expect(w.launches.length).toBe(1)
    })
  })

  // ── CORCH-R3.1 / R3.2: structural uniqueness ──
  describe('R3.1 / R3.2 uniqueness', () => {
    test('a direct concurrent insert of two live runs for one item yields exactly one unique violation', async () => {
      const userId = await mkUser(2)
      const projectId = await mkProject(userId, 'github://acme/u1')
      const { item } = await enq(userId, projectId, 'u1')
      const ins = () => h.sql`INSERT INTO corch_runs (work_item_id, project_id, user_id, counter_key)
                              VALUES (${item.id}, ${projectId}, ${userId}, ${'corch:' + item.id}) RETURNING id`
      const rs = await Promise.allSettled([ins(), ins()])
      expect(rs.filter((r) => r.status === 'fulfilled').length).toBe(1)
      const rej = rs.filter((r) => r.status === 'rejected') as PromiseRejectedResult[]
      expect(rej.length).toBe(1)
      expect(rej[0]!.reason.code).toBe('23505')
    })

    test('cap 2 with two queued items in ONE project: one live run', async () => {
      const userId = await mkUser(2)
      const projectId = await mkProject(userId, 'github://acme/u2')
      await enq(userId, projectId, 'a')
      await enq(userId, projectId, 'b')
      const { w, d } = mkWorld(userId)
      await d.evaluateUser(userId)
      expect(await liveCount(userId)).toBe(1)
      expect(w.launches.length).toBe(1)
    })

    test('a project holding a pr_open item gets no claim', async () => {
      const userId = await mkUser(2)
      const projectId = await mkProject(userId, 'github://acme/u3')
      const open = await enq(userId, projectId, 'open')
      await h.sql`UPDATE corch_work_items SET status = 'pr_open', pr_url = 'https://github.com/acme/u3/pull/1' WHERE id = ${open.item.id}`
      const waiting = await enq(userId, projectId, 'waiting')
      const { w, d } = mkWorld(userId)
      await d.evaluateUser(userId)
      expect(w.launches.length).toBe(0)
      expect((await runRows(waiting.item.id)).length).toBe(0)
      expect((await itemRow(waiting.item.id)).status).toBe('queued')
    })
  })

  // ── CORCH-R3.4: death requeue with backoff, third failure blocks, one notification ──
  describe('R3.4 requeue and blocked', () => {
    test('backoff 60s then 300s, third failure blocks with exactly one notification, double delivery is a no-op', async () => {
      const userId = await mkUser(1)
      const projectId = await mkProject(userId, 'github://acme/d1')
      const { item } = await enq(userId, projectId, 'death')
      const { w, d } = mkWorld(userId)
      const near = (t: Date, secs: number) => Math.abs(new Date(t).getTime() - (Date.now() + secs * 1000)) < 10_000

      await d.evaluateUser(userId)
      expect(w.launches.length).toBe(1)
      await d.onSupervisorClosed('sup-1')
      let it = await itemRow(item.id)
      expect(it.attempts).toBe(1)
      expect(it.status).toBe('queued')
      expect(near(it.not_before, 60)).toBe(true)
      let runs = await runRows(item.id)
      expect(runs[0]!.end_reason).toBe('supervisor_closed')
      expect(w.releases[0]![0]).toBe(`corch-run:${runs[0]!.id}`)

      await h.sql`UPDATE corch_work_items SET not_before = now() - interval '1 second' WHERE id = ${item.id}`
      await d.evaluateUser(userId)
      expect(w.launches.length).toBe(2)
      await d.onSupervisorClosed('sup-1')
      it = await itemRow(item.id)
      expect(it.attempts).toBe(2)
      expect(it.status).toBe('queued')
      expect(near(it.not_before, 300)).toBe(true)

      await h.sql`UPDATE corch_work_items SET not_before = now() - interval '1 second' WHERE id = ${item.id}`
      await d.evaluateUser(userId)
      expect(w.launches.length).toBe(3)
      const [lastLive] = await storeMod.corchStore.liveRunsForSupervisor('sup-1').then((rs) => rs.filter((r) => r.user_id === userId))
      await d.onSupervisorClosed('sup-1')
      it = await itemRow(item.id)
      expect(it.attempts).toBe(3)
      expect(it.status).toBe('blocked')
      expect(it.wait_reason).toBe('supervisor_closed')
      expect(w.notes.length).toBe(1)
      expect(w.notes[0]).toMatchObject({ kind: 'blocked', workItemId: item.id, attempts: 3, endReason: 'supervisor_closed' })

      // The same transition delivered again changes nothing and notifies nobody.
      const again = await d.reclaimRun(lastLive!, 'supervisor_closed', true)
      expect(again.changed).toBe(false)
      await d.onSupervisorClosed('sup-1')
      expect(w.notes.length).toBe(1)
      expect((await itemRow(item.id)).attempts).toBe(3)
      runs = await runRows(item.id)
      expect(runs.length).toBe(3)
    })
  })

  // ── CORCH-R3.5 (+ R1.8, R1.13): one case per refusal; no attempt, item back to queued ──
  describe('R3.5 refusals never consume an attempt', () => {
    async function refusal(o: {
      env?: Record<string, string>
      budget?: number
      setup?: (c: { userId: string; projectId: string; itemId: string }) => Promise<void>
      world?: WorldOpts
    }) {
      const userId = await mkUser(1)
      const projectId = await mkProject(userId, `github://acme/f-${rand()}`, { budget: o.budget })
      const { item } = await enq(userId, projectId, `ref-${rand()}`)
      for (const [k, v] of Object.entries(o.env ?? {})) process.env[k] = v
      await o.setup?.({ userId, projectId, itemId: item.id })
      const world = mkWorld(userId, o.world)
      await world.d.evaluateUser(userId)
      return { userId, itemId: item.id, ...world, item: await itemRow(item.id), runs: await runRows(item.id) }
    }

    function expectRefused(
      r: Awaited<ReturnType<typeof refusal>>,
      e: { end: string | RegExp; wait?: string | RegExp; nb: null | 'midnight' | 'plus_60m'; launched?: boolean },
    ) {
      expect(r.item.status).toBe('queued')
      expect(r.item.attempts).toBe(0)
      expect(r.runs.length).toBe(1)
      expect(r.runs[0]!.ended_at).not.toBeNull()
      expect(r.runs[0]!.end_reason).toMatch(e.end instanceof RegExp ? e.end : new RegExp(`^${e.end}$`))
      if (e.wait) expect(r.item.wait_reason).toMatch(e.wait instanceof RegExp ? e.wait : new RegExp(`^${e.wait}$`))
      expect(r.w.launches.length).toBe(e.launched ? 1 : 0)
      if (e.nb === null) expect(r.item.not_before).toBeNull()
      else if (e.nb === 'midnight') expect(Math.abs(new Date(r.item.not_before).getTime() - nextUtcMidnight())).toBeLessThan(1000)
      else expect(Math.abs(new Date(r.item.not_before).getTime() - (Date.now() + 3_600_000))).toBeLessThan(60_000)
    }

    test('kill switch engaged (user scope): automation_halted, event-driven', async () => {
      const r = await refusal({
        setup: async ({ userId }) => {
          await ctlMod.engageKillSwitch({ scope: 'user', userId, reason: 'e2e', engagedBy: userId })
        },
      })
      expectRefused(r, { end: 'automation_halted', wait: 'automation_halted:user', nb: null })
    })

    test('daily token cap exceeded: waits for the next local midnight', async () => {
      const r = await refusal({
        env: { REMO_ORCHESTRATOR_DAILY_TOKEN_CAP: '1000' },
        setup: async ({ userId }) => seedTokens(userId, await mkSession(userId), { input: 5000 }),
      })
      expectRefused(r, { end: /^over_(daily_)?token_cap/, nb: 'midnight' })
    })

    test('daily cost cap exceeded: waits for the next local midnight', async () => {
      const r = await refusal({
        setup: async ({ userId }) => {
          await h.sql`UPDATE users SET daily_cost_cap_usd = 1.0000 WHERE id = ${userId}`
          await seedTokens(userId, await mkSession(userId), { input: 10, costUsd: 5 })
        },
      })
      expectRefused(r, { end: /^over_daily_cost_cap:/, nb: 'midnight' })
    })

    test('project budget (R1.8): cache_read alone on a prior run session exhausts it', async () => {
      const r = await refusal({
        budget: 100,
        setup: async ({ userId, projectId }) => {
          const prior = await h.sql<{ id: string }[]>`
            INSERT INTO corch_work_items (user_id, project_id, source, source_ref, title, branch, status)
            VALUES (${userId}, ${projectId}, 'manual', 'prior', 't', 'corch/prior', 'done') RETURNING id`
          const sid = await mkSession(userId)
          await h.sql`
            INSERT INTO corch_runs (work_item_id, project_id, user_id, session_id, counter_key, status, end_reason, ended_at)
            VALUES (${prior[0]!.id}, ${projectId}, ${userId}, ${sid}, ${'corch:' + prior[0]!.id}, 'ended', 'pr_open', now())`
          await seedTokens(userId, sid, { cacheRead: 1000 })
        },
      })
      expectRefused(r, { end: 'project_budget', wait: 'project_budget', nb: 'midnight' })
    })

    test('concurrency gate: another live run appearing after the claim refuses corch_concurrency', async () => {
      const r = await refusal({
        world: {
          onWorkspace: async ({ userId }) => {
            const p = await mkProject(userId, `github://acme/other-${rand()}`)
            const other = await enq(userId, p, `other-${rand()}`)
            await h.sql`INSERT INTO corch_runs (work_item_id, project_id, user_id, counter_key)
                        VALUES (${other.item.id}, ${p}, ${userId}, ${'corch:' + other.item.id})`
          },
        },
      })
      expectRefused(r, { end: 'corch_concurrency', wait: 'corch_concurrency', nb: null })
    })

    test('default quota provider (R1.13): wait_reason quota_no_snapshot, nothing launched', async () => {
      const { DEFAULT_QUOTA_PROVIDER } = await import('../../src/corch/quota-provider.ts')
      const r = await refusal({ world: { quota: DEFAULT_QUOTA_PROVIDER } })
      expectRefused(r, { end: 'quota_no_snapshot', wait: 'quota_no_snapshot', nb: null })
    })

    test('session inject rate at the configured per-hour max: retry in 60 minutes', async () => {
      const r = await refusal({
        env: { REMO_ORCHESTRATOR_MAX_INJECTS_PER_HOUR: '2' },
        world: {
          onWorkspace: async ({ sessionId }) => {
            for (let i = 0; i < 2; i++) {
              await h.sql`INSERT INTO routine_run_log (session_id, command, outcome) VALUES (${sessionId}, 'e2e_inject', 'dispatched')`
            }
          },
        },
      })
      expectRefused(r, { end: /^over_session_inject_rate:/, nb: 'plus_60m' })
    })

    test('lifetime cap reached for the item key: lifetime_inject_exhausted, event-driven', async () => {
      const r = await refusal({
        env: { REMO_AUTOMATION_LIFETIME_INJECT_CAP: '1' },
        setup: async ({ userId, itemId }) => {
          await h.sql`INSERT INTO automation_inject_ledger (user_id, counter_key, actor, token, kind)
                      VALUES (${userId}, ${'corch:' + itemId}, 'corch', 'earlier-token', 'inject')`
        },
      })
      expectRefused(r, { end: /^lifetime_inject_exhausted/, nb: null })
    })

    test('default workspace: workspace_unavailable', async () => {
      const r = await refusal({ world: { workspace: dispMod.DEFAULT_WORKSPACE } })
      expectRefused(r, { end: 'workspace_unavailable', wait: 'workspace_unavailable', nb: null })
    })

    test('halt after the claim (dispatch skipped automation_halted:global): no attempt and the reservation is released', async () => {
      const r = await refusal({ world: { outcome: { kind: 'skipped', reason: 'automation_halted:global' } } })
      expectRefused(r, { end: 'automation_halted', wait: 'automation_halted:global', nb: null, launched: true })
      const led = await h.sql`SELECT released_at FROM automation_inject_ledger
                              WHERE counter_key = ${'corch:' + r.itemId} AND token = ${'corch-run:' + r.runs[0]!.id}`
      expect(led.length).toBe(1)
      expect(led[0]!.released_at).not.toBeNull()
    })
  })

  // ── CORCH-R3.3 / R3.7: hub restart never double-launches; reclaim only on positive knowledge ──
  describe('R3.3 / R3.7 restart and reclaim', () => {
    test('restart launches nothing; no fresh inventory stalls once with one notification; a fresh inventory lacking the session reclaims', async () => {
      const userId = await mkUser(1)
      const p1 = await mkProject(userId, 'github://acme/rs1')
      const p2 = await mkProject(userId, 'github://acme/rs2')
      const { item } = await enq(userId, p1, 'live')
      await enq(userId, p2, 'waiting')
      const first = mkWorld(userId)
      await first.d.evaluateUser(userId)
      expect(first.w.launches.length).toBe(1)
      const live1 = (await runRows(item.id))[0]!
      expect(live1.ended_at).toBeNull()

      // Simulated restart: a NEW dispatcher knows nothing in memory.
      const second = mkWorld(userId)
      // evaluateAll is global: park the other tests' queued work so only this user's items are in play.
      await h.sql`UPDATE corch_projects SET enabled = false WHERE user_id = ANY(${users}) AND user_id <> ${userId}`
      await second.d.evaluateUser(userId)
      await second.d.evaluateAll()
      expect(second.w.launches.length).toBe(0)
      expect(await liveCount(userId)).toBe(1)

      await h.sql`UPDATE corch_runs SET heartbeat_at = now() - interval '10 minutes' WHERE id = ${live1.id}`
      await recMod.reconcilePass(second.deps, second.d)
      await recMod.reconcilePass(second.deps, second.d)
      expect((await runRows(item.id))[0]!.status).toBe('stalled')
      expect(second.w.notes.filter((n) => n.kind === 'stalled').length).toBe(1)
      expect((await itemRow(item.id)).attempts).toBe(0)

      second.w.inv = { fresh: true, ids: new Set() } // a fresh inventory that lacks the session
      await recMod.reconcilePass(second.deps, second.d)
      const it = await itemRow(item.id)
      expect(it.attempts).toBe(1)
      expect((await runRows(item.id))[0]!.end_reason).toBe('session_absent')
    })
  })

  // ── QC round 1: real-store behaviour behind the unit regressions ──
  describe('QC round 1 fixes on real Postgres', () => {
    const near = (t: Date, secs: number) => Math.abs(new Date(t).getTime() - (Date.now() + secs * 1000)) < 10_000

    test('C1: a reclaimed run can no longer send: gates refuse, markDispatched throws, a parked replay is dropped', async () => {
      const userId = await mkUser(1)
      const projectId = await mkProject(userId, 'github://acme/c1')
      const { item } = await enq(userId, projectId, 'c1')
      const { w, d } = mkWorld(userId, { outcome: { kind: 'parked_offline' } })
      await d.evaluateUser(userId)
      const run = (await runRows(item.id))[0]!
      const { req, pdeps } = w.dispatches[0]!
      const [liveRun] = await storeMod.corchStore.liveRunsForSupervisor('sup-1').then((rs) => rs.filter((r) => r.id === run.id))
      expect((await d.reclaimRun(liveRun!, 'session_absent', true)).changed).toBe(true)
      const dispatchesBefore = w.dispatches.length
      await pdeps.replay(req)
      expect(w.dispatches.length).toBe(dispatchesBefore)
      await expect(pdeps.store.markDispatched(req.token)).rejects.toThrow('corch_run_not_live')
      const gate = pdeps.gates.find((g: any) => g.name === 'corch_concurrency')
      expect(await gate.check(req)).toEqual({ ok: false, reason: 'corch_run_not_live' })
    })

    test('C5: the real pipeline order (markSkipped session_busy, then dropped_busy) is ONE attempt with a 60s backoff', async () => {
      const userId = await mkUser(1)
      const projectId = await mkProject(userId, 'github://acme/c5')
      const { item } = await enq(userId, projectId, 'c5')
      const { d, deps } = mkWorld(userId)
      deps.dispatch = async (req: any, pdeps: any) => {
        await pdeps.store.markSkipped(req.token, 'session_busy')
        return { kind: 'dropped_busy' }
      }
      await d.evaluateUser(userId)
      const it = await itemRow(item.id)
      expect(it.attempts).toBe(1)
      expect(it.status).toBe('queued')
      expect(near(it.not_before, 60)).toBe(true)
      expect((await runRows(item.id))[0]!.end_reason).toBe('dropped_busy')
    })

    test('MED 2: a throwing Workspace consumes attempts, the third blocks with exactly one notification', async () => {
      const userId = await mkUser(1)
      const projectId = await mkProject(userId, 'github://acme/m2')
      const { item } = await enq(userId, projectId, 'm2')
      const { w, d } = mkWorld(userId, { workspace: { resolve: async () => { throw new Error('worktree boom') } } })
      for (let i = 1; i <= 3; i++) {
        await h.sql`UPDATE corch_work_items SET not_before = now() - interval '1 second' WHERE id = ${item.id}`
        await d.evaluateUser(userId)
        expect((await itemRow(item.id)).attempts).toBe(i)
      }
      const it = await itemRow(item.id)
      expect(it.status).toBe('blocked')
      expect(it.wait_reason).toBe('workspace_error')
      expect(w.notes.length).toBe(1)
      expect(await liveCount(userId)).toBe(0)
    })

    test('MED 1: a throwing launch dependency ends the run as launch_error with an attempt (no live run)', async () => {
      const userId = await mkUser(1)
      const projectId = await mkProject(userId, 'github://acme/m1')
      const { item } = await enq(userId, projectId, 'm1')
      const { deps, d } = mkWorld(userId)
      deps.launch.checkGates = async () => {
        throw new Error('db down')
      }
      expect((await d.evaluateUser(userId)).kind).toBe('done')
      const it = await itemRow(item.id)
      expect(it.attempts).toBe(1)
      expect(it.status).toBe('queued')
      expect((await runRows(item.id))[0]!.end_reason).toBe('launch_error')
      expect(await liveCount(userId)).toBe(0)
    })

    test('C4: liveRunsPage walks live runs in stable id order without overlap', async () => {
      const a = await mkUser(1)
      const b = await mkUser(1)
      for (const [u, repo] of [[a, 'github://acme/pg1'], [b, 'github://acme/pg2']] as const) {
        const projectId = await mkProject(u, repo)
        await enq(u, projectId, 'pg')
        await mkWorld(u).d.evaluateUser(u)
      }
      const all = await storeMod.corchStore.liveRunsPage(null, 1000)
      expect(all.length).toBeGreaterThanOrEqual(2)
      expect(all.map((r) => r.id)).toEqual([...all.map((r) => r.id)].sort())
      const walked: string[] = []
      let cursor: string | null = null
      for (;;) {
        const page = await storeMod.corchStore.liveRunsPage(cursor, 1)
        if (page.length === 0) break
        walked.push(page[0]!.id)
        cursor = page[0]!.id
      }
      expect(walked).toEqual(all.map((r) => r.id))
    })

    test('C6: boot evaluates backlog whose not_before already passed, with no other trigger', async () => {
      const userId = await mkUser(1)
      const projectId = await mkProject(userId, 'github://acme/c6')
      const { item } = await enq(userId, projectId, 'c6')
      await h.sql`UPDATE corch_work_items SET not_before = now() - interval '5 minutes' WHERE id = ${item.id}`
      // evaluateAll is global: park every other user's work so only this item is in play.
      await h.sql`UPDATE corch_projects SET enabled = false WHERE user_id = ANY(${users}) AND user_id <> ${userId}`
      const { w, d } = mkWorld(userId)
      const stop = await recMod.startCorchWith(d)
      stop()
      expect(w.launches.length).toBe(1)
      expect((await runRows(item.id)).length).toBe(1)
    })
  })

  // ── QC round 2 (Codex R2-1): reclaim is serialized with the send ──
  describe('QC round 2 fixes on real Postgres', () => {
    // The REAL shared pipeline (dispatch + queue + gates + preSendGuard + finalHaltCheck), the REAL corch
    // send wiring (realCorchDeps().pipeline.send -> sendUserMessage: channel lookup, real messages insert,
    // ws.send) and a fake agent socket registered in the real ws registry. Only the pause is injected: it
    // holds the pipeline right after markDispatched/markRunRunning succeeded, which is the window the
    // finalHaltCheck / channel lookup / message insert awaits give a concurrent reclaim.
    async function runRealPipeline(opts: { reclaimDuringPause: boolean }) {
      const registry = await import('../../src/ws/registry.ts')
      const pipelineMod = await import('../../src/dispatch/pipeline.ts')
      const real = await dispMod.realCorchDeps()
      const userId = await mkUser(1)
      const projectId = await mkProject(userId, `github://acme/r2-${rand()}`)
      const { item } = await enq(userId, projectId, `r2-${rand()}`)
      const sent: string[] = []
      let sessionId = ''
      const { d, deps } = mkWorld(userId, {
        onWorkspace: async (c) => {
          sessionId = c.sessionId
          registry.registerChannel(c.sessionId, c.userId, { send: (data: string) => void sent.push(data), close: () => {} } as any)
        },
      })
      deps.dispatch = real.dispatch
      deps.pipeline = { ...real.pipeline, isOnline: async () => true }

      let armed = opts.reclaimDuringPause
      let reached!: () => void
      let resume!: () => void
      const atPause = new Promise<void>((res) => (reached = res))
      const gate = new Promise<void>((res) => (resume = res))
      const origRunning = storeMod.corchStore.markRunRunning
      storeMod.corchStore.markRunRunning = async (runId: string) => {
        const ok = await origRunning(runId)
        if (armed && ok) {
          armed = false
          reached()
          await gate
        }
        return ok
      }
      try {
        const evaluation = d.evaluateUser(userId)
        if (opts.reclaimDuringPause) {
          await atPause
          const run = (await runRows(item.id))[0]!
          const live = (await storeMod.corchStore.liveRunsForSupervisor('sup-1')).find((r) => r.id === run.id)!
          expect((await d.reclaimRun(live, 'session_absent', true)).changed).toBe(true)
          resume()
        }
        await evaluation
      } finally {
        storeMod.corchStore.markRunRunning = origRunning
        registry.unregisterChannel(sessionId)
        pipelineMod._reset()
      }
      const rows = (await h.sql`SELECT count(*)::int AS n FROM messages WHERE session_id = ${sessionId}`)[0]!.n as number
      return { sent, rows, item: await itemRow(item.id), run: (await runRows(item.id))[0]! }
    }

    test('R2-1: a reclaim landing after markRunRunning stops the send (zero ws sends, zero message rows); without one the real send goes out', async () => {
      const control = await runRealPipeline({ reclaimDuringPause: false })
      expect(control.sent.length).toBe(1) // the harness really sends when nothing races
      expect(control.rows).toBe(1)
      expect(control.run.ended_at).toBeNull()

      const raced = await runRealPipeline({ reclaimDuringPause: true })
      expect(raced.run.end_reason).toBe('session_absent')
      expect(raced.item.attempts).toBe(1) // one reclaim, not double-counted by the pipeline's own failure path
      expect(raced.sent.length).toBe(0)
      expect(raced.rows).toBe(0)
    })
  })

  // ── end to end: a pushed PR ends the run and parks the item as pr_open ──
  describe('success path', () => {
    test('PrLookup open on finalize: item pr_open with the url, run ended', async () => {
      const userId = await mkUser(1)
      const projectId = await mkProject(userId, 'github://acme/ok')
      const { item } = await enq(userId, projectId, 'ok')
      const url = 'https://github.com/acme/ok/pull/7'
      const { w, d } = mkWorld(userId, { prLookup: { lookup: async () => ({ kind: 'open', url }) } })
      await d.evaluateUser(userId)
      const run = (await runRows(item.id))[0]!
      expect(run.status).toBe('running')
      await w.dispatches[0]!.pdeps.store.onFinalize(`corch-run:${run.id}`, 'done')
      const it = await itemRow(item.id)
      expect(it.status).toBe('pr_open')
      expect(it.pr_url).toBe(url)
      const ended = (await runRows(item.id))[0]!
      expect(ended.ended_at).not.toBeNull()
      expect(ended.end_reason).toBe('pr_open')
    })
  })
})
