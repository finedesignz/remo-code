// CORCH-12 e2e on real Postgres (CORCH-R6.5). Skips only when REMO_E2E_DB_URL is unset.
// The whole loop in ONE flow, wiring the REAL pieces the earlier CORCH e2e files prove in isolation:
//   quota snapshot POST (real hub app) -> real quota provider -> claim -> memlog claim (fake) -> worktree_ensure
//   (fake slot supervisor) -> launch -> turn end -> pr_lookup -> HMAC-signed AAF event POST (real hub app route)
//   -> hub status. Fakes: AAF sender, memlog, slot supervisor, launch/spawn and the dispatch send (the turn end calls the finalize hook the dispatcher registered; the real gate chain and send are covered by corch-dispatcher.e2e.test.ts). Nothing here touches a live system.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-chars-long-aaaaaaaa'
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'session-secret-at-least-32-chars-long-x'
process.env.MAGIC_LINK_SECRET = process.env.MAGIC_LINK_SECRET || 'magic-link-secret-at-least-32-chars-x'
process.env.TITANIUM_KEYGEN_API_URL = process.env.TITANIUM_KEYGEN_API_URL || 'https://keygen.titaniumlabs.us'
process.env.TITANIUM_KEYGEN_ACCOUNT_ID = process.env.TITANIUM_KEYGEN_ACCOUNT_ID || 'acct_test_0000000000'
process.env.TITANIUM_KEYGEN_PRODUCT_ID = process.env.TITANIUM_KEYGEN_PRODUCT_ID || 'prod_test_remo'

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test'
import { createHmac, randomBytes, randomUUID } from 'node:crypto'

const HAS_TEST_DB = !!process.env.REMO_E2E_DB_URL
const maybe = HAS_TEST_DB ? describe : describe.skip
const EVENT_SECRET = randomBytes(24).toString('hex')
const ROOT = '/data/repos'

maybe('CORCH-12 e2e - full loop on real Postgres', () => {
  let harness: typeof import('./orchestrator-harness.ts')
  let h: import('./orchestrator-harness.ts').Harness
  let app: { request: (path: string, init?: RequestInit) => Response | Promise<Response> }
  let storeMod: typeof import('../../src/corch/store.ts')
  let dispMod: typeof import('../../src/corch/dispatcher.ts')
  let recMod: typeof import('../../src/corch/reconciler.ts')
  let autoMod: typeof import('../../src/heal/autospawn-deps.ts')
  let wsMod: typeof import('../../src/corch/workspace.ts')
  let rowsMod: typeof import('../../src/db/orchestrator-rows-dal.ts')
  let quotaStoreMod: typeof import('../../src/corch/quota-store.ts')
  let quotaProvMod: typeof import('../../src/corch/quota-provider.ts')
  const users: string[] = []
  const saved: Record<string, string | undefined> = {}
  const ENV = ['REMO_CORCH_ENABLED', 'REMO_CORCH_AAF_EVENT_SECRET']

  beforeAll(async () => {
    for (const k of ENV) saved[k] = process.env[k]
    process.env.DATABASE_URL = process.env.REMO_E2E_DB_URL!
    harness = await import('./orchestrator-harness.ts')
    h = await harness.setupHarness()
    app = (await import('../../src/index.ts')).app as any
    storeMod = await import('../../src/corch/store.ts')
    dispMod = await import('../../src/corch/dispatcher.ts')
    recMod = await import('../../src/corch/reconciler.ts')
    autoMod = await import('../../src/heal/autospawn-deps.ts')
    wsMod = await import('../../src/corch/workspace.ts')
    rowsMod = await import('../../src/db/orchestrator-rows-dal.ts')
    quotaStoreMod = await import('../../src/corch/quota-store.ts')
    quotaProvMod = await import('../../src/corch/quota-provider.ts')
  }, 60_000)

  beforeEach(() => {
    process.env.REMO_CORCH_ENABLED = '1'
    process.env.REMO_CORCH_AAF_EVENT_SECRET = EVENT_SECRET
  })
  afterAll(async () => {
    for (const k of ENV) saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k])
    if (h) {
      if (users.length) {
        await h.sql`UPDATE corch_runs SET status = 'ended', end_reason = 'test_cleanup', ended_at = now() WHERE ended_at IS NULL AND user_id = ANY(${users})`
        await h.sql`DELETE FROM automation_inject_ledger WHERE user_id = ANY(${users})`
        await h.sql`DELETE FROM users WHERE id = ANY(${users})`
      }
      await harness.teardownHarness(h)
    }
  })

  // ---- fixtures --------------------------------------------------------------------------------------------------
  async function mintKey(userId: string, scopes: string[]): Promise<string> {
    const { hashToken } = await import('../../src/lib/crypto.ts')
    const { createApiKey } = await import('../../src/db/dal.ts')
    const raw = `remokey_${randomUUID().replace(/-/g, '')}`
    await createApiKey(userId, await hashToken(raw), `corch12-${scopes.join('+')}`, { purpose: 'external', scopes })
    return raw
  }
  async function mkWorld(repo: string) {
    const r = await h.sql<{ id: string }[]>`
      INSERT INTO users (email, password_hash, role, corch_max_concurrent_runs)
      VALUES (${`e2e-corch12-${randomUUID()}@invalid.local`}, 'x', 'user', 3) RETURNING id`
    const userId = r[0]!.id
    users.push(userId)
    const p = await h.sql<{ id: string }[]>`
      INSERT INTO corch_projects (user_id, repo_ident, daily_token_budget, aaf_provision_status)
      VALUES (${userId}, ${`github://acme/${repo}`}, 2000000, 'provisioned') RETURNING id`
    return { userId, projectId: p[0]!.id, repo, publish: await mintKey(userId, ['quota:publish']) }
  }
  const acct = (id: string, over: Record<string, unknown> = {}) => ({
    account_id: id, slot: id, five_h_pct: 10, seven_d_pct: 20,
    resets_5h: new Date(Date.now() + 3_600_000).toISOString(),
    resets_7d: new Date(Date.now() + 86_400_000).toISOString(),
    fetched_at: new Date().toISOString(), source: 'live', enabled: true, blocked: false, current: false, ...over,
  })
  const postQuota = (key: string, accounts: Record<string, unknown>[]) =>
    app.request('/api/quota/snapshot', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ schema: 1, publisher: 'cug', generated_at: new Date().toISOString(), poll_interval_secs: 300, accounts }),
    })
  const sign = (ts: number, body: string) => 'sha256=' + createHmac('sha256', EVENT_SECRET).update(`${ts}.${body}`).digest('hex')
  async function postAafEvent(o: { event: string; repo: string; headRef: string; eventId?: string }) {
    const eventId = o.eventId ?? `evt-${randomUUID()}`
    const body = JSON.stringify({ event_id: eventId, event: o.event, repo: o.repo, pr_number: 7, head_ref: o.headRef, occurred_at: new Date().toISOString() })
    const ts = Math.floor(Date.now() / 1000)
    const res = await app.request('/api/corch-events/aaf', {
      method: 'POST',
      body,
      headers: { 'x-zeroexposure-timestamp': String(ts), 'x-zeroexposure-signature': sign(ts, body), 'x-zeroexposure-event-id': eventId },
    })
    return { res, eventId }
  }
  const itemRow = async (id: string) => (await h.sql`SELECT * FROM corch_work_items WHERE id = ${id}`)[0]!
  const runRows = async (itemId: string) => h.sql`SELECT * FROM corch_runs WHERE work_item_id = ${itemId} ORDER BY started_at ASC`
  const eventRow = async (eventId: string) => (await h.sql`SELECT * FROM corch_events WHERE event_id = ${eventId}`)[0]

  /** The real dispatcher + real quota provider + real Workspace/PrLookup; slot supervisor, memlog, launch are fakes. */
  function wire(o: { account: string; prUrl: string | null }) {
    const w = {
      frames: [] as string[],
      launches: 0,
      memlog: [] as string[],
      dispatches: [] as Array<{ req: any; pdeps: any }>,
      inv: { fresh: false, ids: new Set<string>() },
    }
    const quota = quotaProvMod.createQuotaProvider({
      accountsFor: (u) => quotaStoreMod.quotaStore.accountsFor(u),
      liveRunsByAccount: (u, ex) => quotaStoreMod.quotaStore.liveRunsByAccount(u, ex),
      onlineSlotSupervisors: () => [{ supervisorId: 'slot-sup-1', accountSlot: o.account, maxConcurrent: 1 }],
      claimAccountSlot: (r, u, a, c) => quotaStoreMod.quotaStore.claimAccountSlot(r, u, a, c),
      now: () => new Date(),
      ceilingPct: () => 55,
      markDeath: (a) => quotaStoreMod.quotaStore.markDeath(a),
    })
    const memlog: import('../../src/corch/memlog.ts').MemlogClient = {
      claim: async (i) => (w.memlog.push(`claim ${i.branch}`), { ok: true }),
      heartbeat: async () => true,
      release: async (i) => (w.memlog.push(`release ${i.status}`), true),
    }
    const wsDeps: import('../../src/corch/workspace.ts').WorkspaceDeps = {
      quota,
      memlog,
      store: storeMod.corchStore,
      runCommand: async (_sup, _u, command, args) => {
        w.frames.push(command)
        if (command === 'corch.worktree_ensure') {
          const name = args[0]!.split('/').pop()!
          return { exit_code: 0, snippet: JSON.stringify({ path: `${ROOT}/corch/${name}-${args[1]}`, branch: `corch/${args[1]}` }) }
        }
        if (command === 'corch.pr_lookup') return { exit_code: 0, snippet: JSON.stringify({ pr_url: o.prUrl }) }
        return { exit_code: 0, snippet: JSON.stringify({ removed: true }) }
      },
      halt: async (userId) => {
        const { haltBeforeMachineSend } = await import('../../src/dispatch/automation-controls.ts')
        const r = await haltBeforeMachineSend({ userId })
        return r.ok ? { ok: true } : { ok: false, reason: r.reason }
      },
      supervisor: () => ({ hostname: 'slot-host', root: ROOT }),
      ensureSession: async ({ userId, worktreePath, hostname }) => {
        const existing = await h.sql<{ id: string }[]>`SELECT id FROM sessions WHERE user_id = ${userId} AND project_dir = ${worktreePath} AND deleted_at IS NULL LIMIT 1`
        if (existing[0]) return existing[0].id
        const r = await h.sql<{ id: string }[]>`
          INSERT INTO sessions (user_id, name, project_dir, token_hash, hostname)
          VALUES (${userId}, 'corch12-e2e', ${worktreePath}, ${'th-' + randomUUID()}, ${hostname}) RETURNING id`
        return r[0]!.id
      },
      ticket: () => {},
    }
    const deps: any = {
      store: storeMod.corchStore,
      workspace: wsMod.createWorkspace(wsDeps),
      launch: {
        ...autoMod.REAL_AUTOSPAWN,
        isRepoAutospawnAllowed: (u: string, r: string) => storeMod.corchStore.isEnrolledEnabled(u, r),
        supervisorOnlineForUser: async () => true,
        launchSessionForUser: async () => {
          w.launches++
          return { ok: true, runId: `sup-run-${w.launches}`, supervisorId: 'slot-sup-1' }
        },
      },
      launchCommand: rowsMod.AUTOSPAWN_LAUNCH_COMMAND,
      quota,
      pipeline: { isOnline: async () => true, send: async () => {}, releaseByToken: async () => {} },
      dispatch: async (req: any, pdeps: any) => (w.dispatches.push({ req, pdeps }), { kind: 'dispatched', runId: 'x' }),
      prLookup: wsMod.createPrLookup(wsDeps),
      notify: async () => {},
      inventory: {
        forSupervisor: () => ({ fresh: w.inv.fresh, sessionIds: w.inv.ids }),
        forUser: () => ({ fresh: w.inv.fresh, sessionIds: w.inv.ids }),
        isOnline: () => true,
      },
      timers: { setTimeout: () => ({}), clearTimeout: () => {} },
    }
    return { w, deps, d: dispMod.createCorchDispatcher(deps) }
  }

  test('happy path: queued -> quota -> claim -> launch -> PR on corch/<id> -> signed pr.merged -> done with event_id recorded', async () => {
    const u = await mkWorld('happy')
    expect((await postQuota(u.publish, [acct('acct-1')])).status).toBe(200)
    const e = await storeMod.corchStore.enqueueWorkItem({ userId: u.userId, projectId: u.projectId, source: 'manual', sourceRef: 'happy-1', title: 't', body: 'b', priority: 0 })
    const itemId = e.item.id
    expect((await itemRow(itemId)).status).toBe('queued')

    const { w, d } = wire({ account: 'acct-1', prUrl: 'https://github.com/acme/happy/pull/7' })
    await d.evaluateUser(u.userId)
    expect(w.memlog[0]).toBe(`claim corch/${itemId}`)
    expect(w.frames[0]).toBe('corch.worktree_ensure')
    expect(w.launches).toBe(1)
    expect(w.dispatches.length).toBe(1)
    const [run] = await runRows(itemId)
    expect(run!.account_slot).toBe('acct-1')
    expect(run!.supervisor_id).toBe('slot-sup-1')
    expect((await itemRow(itemId)).status).toBe('running')

    // turn end -> real PrLookup -> pr_open with the url
    await w.dispatches[0]!.pdeps.store.onFinalize(`corch-run:${run!.id}`, 'done')
    const open = await itemRow(itemId)
    expect(open.status).toBe('pr_open')
    expect(open.pr_url).toBe('https://github.com/acme/happy/pull/7')
    expect(open.branch).toBe(`corch/${itemId}`)

    // AAF merged the PR: a signed event through the REAL route closes the item
    const { res, eventId } = await postAafEvent({ event: 'pr.merged', repo: `acme/${u.repo}`, headRef: `corch/${itemId}` })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, status: 'applied' })
    expect((await itemRow(itemId)).status).toBe('done')
    const ev = await eventRow(eventId)
    expect(ev.outcome).toBe('done')
    expect(ev.work_item_id).toBe(itemId)
    expect(ev.user_id).toBe(u.userId)
    expect((await runRows(itemId)).every((r) => r.ended_at !== null)).toBe(true)

    // replay of the same signed event changes nothing
    const again = await postAafEvent({ event: 'pr.merged', repo: `acme/${u.repo}`, headRef: `corch/${itemId}`, eventId })
    expect(await again.res.json()).toEqual({ ok: true, status: 'duplicate' })
    expect((await itemRow(itemId)).status).toBe('done')
  })

  test('death requeue: the session vanishes from a fresh inventory, the attempt is consumed, a second run reaches done', async () => {
    const u = await mkWorld('death')
    await postQuota(u.publish, [acct('acct-1')])
    const e = await storeMod.corchStore.enqueueWorkItem({ userId: u.userId, projectId: u.projectId, source: 'manual', sourceRef: 'death-1', title: 't', body: 'b', priority: 0 })
    const itemId = e.item.id
    const { w, deps, d } = wire({ account: 'acct-1', prUrl: 'https://github.com/acme/death/pull/7' })
    await d.evaluateUser(u.userId)
    const [first] = await runRows(itemId)
    expect(w.launches).toBe(1)

    // positive knowledge that the session is gone: a fresh inventory that lacks it
    await h.sql`UPDATE corch_runs SET heartbeat_at = now() - interval '10 minutes' WHERE id = ${first!.id}`
    w.inv = { fresh: true, ids: new Set<string>() }
    await recMod.reconcilePass(deps, d)
    const requeued = await itemRow(itemId)
    expect(requeued.status).toBe('queued')
    expect(requeued.attempts).toBe(1)
    expect((await runRows(itemId))[0]!.end_reason).toBe('session_absent')
    expect((await runRows(itemId))[0]!.ended_at).not.toBeNull()
    expect((await runRows(itemId))[0]!.id).toBe(first!.id)

    // backoff passes -> relaunch -> PR -> signed merge -> done
    await h.sql`UPDATE corch_work_items SET not_before = now() - interval '1 second' WHERE id = ${itemId}`
    w.inv = { fresh: false, ids: new Set<string>() }
    await d.evaluateUser(u.userId)
    expect(w.launches).toBe(2)
    const runs = await runRows(itemId)
    expect(runs.length).toBe(2)
    await w.dispatches[1]!.pdeps.store.onFinalize(`corch-run:${runs[1]!.id}`, 'done')
    expect((await itemRow(itemId)).status).toBe('pr_open')
    const { res } = await postAafEvent({ event: 'pr.merged', repo: `acme/${u.repo}`, headRef: `corch/${itemId}` })
    expect(res.status).toBe(200)
    expect((await itemRow(itemId)).status).toBe('done')
  })

  test('quota wait: an over-ceiling account launches nothing and costs no attempt; a healthy reading lets it run', async () => {
    const u = await mkWorld('quota')
    await postQuota(u.publish, [acct('acct-1', { five_h_pct: 90, seven_d_pct: 90 })])
    const e = await storeMod.corchStore.enqueueWorkItem({ userId: u.userId, projectId: u.projectId, source: 'manual', sourceRef: 'quota-1', title: 't', body: 'b', priority: 0 })
    const itemId = e.item.id
    const { w, d } = wire({ account: 'acct-1', prUrl: null })
    await d.evaluateUser(u.userId)
    expect(w.launches).toBe(0)
    expect(w.frames.length).toBe(0)
    const waiting = await itemRow(itemId)
    expect(waiting.status).toBe('queued')
    expect(String(waiting.wait_reason)).toMatch(/^quota:/)
    expect(waiting.attempts).toBe(0)

    // a genuine newer healthy reading arrives through the real route; the backoff passes
    await new Promise((r) => setTimeout(r, 20))
    await postQuota(u.publish, [acct('acct-1', { fetched_at: new Date(Date.now() + 5_000).toISOString() })])
    await h.sql`UPDATE corch_work_items SET not_before = now() - interval '1 second' WHERE id = ${itemId}`
    await d.evaluateUser(u.userId)
    expect(w.launches).toBe(1)
    expect((await itemRow(itemId)).status).toBe('running')
    expect((await itemRow(itemId)).attempts).toBe(0)
  })

  test('pr.closed (unmerged) => blocked and stays blocked: no requeue, no second run', async () => {
    const u = await mkWorld('closed')
    await postQuota(u.publish, [acct('acct-1')])
    const e = await storeMod.corchStore.enqueueWorkItem({ userId: u.userId, projectId: u.projectId, source: 'manual', sourceRef: 'closed-1', title: 't', body: 'b', priority: 0 })
    const itemId = e.item.id
    const { w, deps, d } = wire({ account: 'acct-1', prUrl: 'https://github.com/acme/closed/pull/7' })
    await d.evaluateUser(u.userId)
    const [run] = await runRows(itemId)
    await w.dispatches[0]!.pdeps.store.onFinalize(`corch-run:${run!.id}`, 'done')
    expect((await itemRow(itemId)).status).toBe('pr_open')

    const { res, eventId } = await postAafEvent({ event: 'pr.closed', repo: `acme/${u.repo}`, headRef: `corch/${itemId}` })
    expect(res.status).toBe(200)
    expect((await itemRow(itemId)).status).toBe('blocked')
    expect((await eventRow(eventId)).outcome).toBe('blocked')

    await recMod.reconcilePass(deps, d)
    await d.evaluateUser(u.userId)
    expect((await itemRow(itemId)).status).toBe('blocked')
    expect((await runRows(itemId)).length).toBe(1)
    expect(w.launches).toBe(1)
  })
})
