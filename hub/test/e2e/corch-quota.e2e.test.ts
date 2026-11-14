// CORCH-02 e2e on real Postgres. Skips only when REMO_E2E_DB_URL is unset.
// Boots the REAL hub app (hub/src/index.ts) against the disposable DB; DATABASE_URL is pointed at the
// same DB before any hub module loads.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-chars-long-aaaaaaaa'
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'session-secret-at-least-32-chars-long-x'
process.env.MAGIC_LINK_SECRET = process.env.MAGIC_LINK_SECRET || 'magic-link-secret-at-least-32-chars-x'
process.env.TITANIUM_KEYGEN_API_URL = process.env.TITANIUM_KEYGEN_API_URL || 'https://keygen.titaniumlabs.us'
process.env.TITANIUM_KEYGEN_ACCOUNT_ID = process.env.TITANIUM_KEYGEN_ACCOUNT_ID || 'acct_test_0000000000'
process.env.TITANIUM_KEYGEN_PRODUCT_ID = process.env.TITANIUM_KEYGEN_PRODUCT_ID || 'prod_test_remo'

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { randomUUID } from 'node:crypto'

const HAS_TEST_DB = !!process.env.REMO_E2E_DB_URL
const maybe = HAS_TEST_DB ? describe : describe.skip

maybe('CORCH-02 e2e - quota ingest on real Postgres', () => {
  let harness: typeof import('./orchestrator-harness.ts')
  let h: import('./orchestrator-harness.ts').Harness
  let app: { request: (path: string, init?: RequestInit) => Response | Promise<Response> }
  let publishKey = ''
  let readKey = ''
  const extraUsers: string[] = []

  const snapshot = (accounts: Record<string, unknown>[]) => ({
    schema: 1,
    publisher: 'cug',
    generated_at: new Date().toISOString(),
    poll_interval_secs: 300,
    accounts,
  })
  const acct = (id: string, over: Record<string, unknown> = {}) => ({
    account_id: id,
    slot: id,
    five_h_pct: 10,
    seven_d_pct: 20,
    resets_5h: new Date(Date.now() + 3_600_000).toISOString(),
    resets_7d: new Date(Date.now() + 86_400_000).toISOString(),
    fetched_at: new Date().toISOString(),
    source: 'live',
    enabled: true,
    blocked: false,
    current: false,
    ...over,
  })
  const post = (body: unknown, key = publishKey) =>
    app.request('/api/quota/snapshot', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  const get = (key = readKey) =>
    app.request('/api/quota/snapshot', { headers: { Authorization: `Bearer ${key}` } })

  async function mintKey(userId: string, scopes: string[]): Promise<string> {
    const { hashToken } = await import('../../src/lib/crypto.ts')
    const { createApiKey } = await import('../../src/db/dal.ts')
    const raw = `remokey_${randomUUID().replace(/-/g, '')}`
    await createApiKey(userId, await hashToken(raw), `quota-e2e-${scopes.join('+')}`, {
      purpose: 'external',
      scopes,
    })
    return raw
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = process.env.REMO_E2E_DB_URL!
    harness = await import('./orchestrator-harness.ts')
    h = await harness.setupHarness()
    app = (await import('../../src/index.ts')).app as any
    publishKey = await mintKey(h.userId, ['quota:publish'])
    readKey = await mintKey(h.userId, ['quota:read'])
  }, 60_000)

  afterAll(async () => {
    if (h) {
      for (const id of extraUsers) await h.sql`DELETE FROM users WHERE id = ${id}`
      await harness.teardownHarness(h)
    }
  })

  test('tracer: publish -> store -> read on real Postgres', async () => {
    const r = await post(snapshot([acct('acct_a')]))
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ ok: true, accepted: 1 })

    const rows = await h.sql`SELECT account_id, source FROM corch_quota_accounts WHERE user_id = ${h.userId}`
    expect(rows.length).toBe(1)
    expect(rows[0]!.account_id).toBe('acct_a')

    const g = await get()
    expect(g.status).toBe(200)
    const body = (await g.json()) as any
    expect(body.accounts.length).toBe(1)
    expect(body.accounts[0].account_id).toBe('acct_a')
    expect(body.accounts[0].eligible).toBe(true)
    expect(body.accounts[0].reason).toBeNull()
  })

  // ── Full matrix (Task 7) ───────────────────────────────────────────────────

  async function newUser(): Promise<{ userId: string; publish: string; read: string }> {
    const rows = await h.sql<{ id: string }[]>`
      INSERT INTO users (email, password_hash, role) VALUES (${`e2e-quota-${randomUUID()}@invalid.local`}, 'x', 'user') RETURNING id`
    const userId = rows[0]!.id
    extraUsers.push(userId)
    return { userId, publish: await mintKey(userId, ['quota:publish']), read: await mintKey(userId, ['quota:read']) }
  }
  const count = async (userId: string) =>
    (await h.sql`SELECT count(*)::int AS n FROM corch_quota_accounts WHERE user_id = ${userId}`)[0]!.n as number

  test('schema applied twice leaves the table present with the documented columns and no email column', async () => {
    const { readFileSync } = await import('node:fs')
    const { resolve } = await import('node:path')
    const { splitSqlStatements } = await import('../../src/db/migrate.ts')
    const ddl = readFileSync(resolve(import.meta.dir, '../../src/db/schema.sql'), 'utf-8')
    for (let pass = 0; pass < 2; pass++) {
      for (const stmt of splitSqlStatements(ddl)) await h.sql.unsafe(stmt).catch(() => {})
    }
    const cols = (await h.sql`
      SELECT column_name FROM information_schema.columns WHERE table_name = 'corch_quota_accounts'`).map((r) => r.column_name as string)
    expect([...cols].sort()).toEqual(
      ['account_id', 'blocked_at', 'blocked_until', 'cug_blocked', 'enabled', 'fetched_at', 'five_h_pct', 'received_at',
       'resets_5h', 'resets_7d', 'seven_d_pct', 'slot', 'source', 'user_id'].sort(),
    )
    expect(cols.some((c) => /email|label/.test(c))).toBe(false)
  })

  test('repeated POST keeps one row per account and advances received_at', async () => {
    const u = await newUser()
    await post(snapshot([acct('r1'), acct('r2')]), u.publish)
    const first = (await h.sql`SELECT received_at FROM corch_quota_accounts WHERE user_id = ${u.userId} AND account_id = 'r1'`)[0]!.received_at as Date
    await new Promise((r) => setTimeout(r, 15))
    await post(snapshot([acct('r1', { seven_d_pct: 33 })]), u.publish)
    expect(await count(u.userId)).toBe(2)
    const row = (await h.sql`SELECT received_at, seven_d_pct FROM corch_quota_accounts WHERE user_id = ${u.userId} AND account_id = 'r1'`)[0]!
    expect(row.received_at.getTime()).toBeGreaterThan(first.getTime())
    expect(Number(row.seven_d_pct)).toBe(33)
  })

  test('email, label and an unknown key => 400 and the row count is unchanged', async () => {
    const u = await newUser()
    await post(snapshot([acct('s1')]), u.publish)
    for (const bad of [
      snapshot([acct('s1', { email: 'probe@example.invalid' })]),
      snapshot([acct('s2', { label: 'work' })]),
      snapshot([acct('s3', { surprise: 1 })]),
      { ...snapshot([acct('s4')]), user_id: 'someone-else' },
    ]) {
      expect((await post(bad, u.publish)).status).toBe(400)
    }
    expect(await count(u.userId)).toBe(1)
  })

  test('user B read key sees none of user A rows; a publish key GET is 403; a read key POST is 403', async () => {
    const a = await newUser()
    const b = await newUser()
    await post(snapshot([acct('only_a')]), a.publish)
    const gb = await get(b.read)
    expect(gb.status).toBe(200)
    expect(((await gb.json()) as any).accounts).toEqual([])
    const ga = (await (await get(a.read)).json()) as any
    expect(ga.accounts.map((x: any) => x.account_id)).toEqual(['only_a'])
    expect((await get(a.publish)).status).toBe(403)
    expect((await post(snapshot([acct('x')]), a.read)).status).toBe(403)
    // user_id comes from the key: B publishing never writes under A
    await post(snapshot([acct('only_b')]), b.publish)
    expect(await count(a.userId)).toBe(1)
    expect(await count(b.userId)).toBe(1)
  })

  // Fixtures for run-level cases.
  async function fixture(userId: string, nProjects: number) {
    const { corchStore } = await import('../../src/corch/store.ts')
    await h.sql`UPDATE users SET corch_max_concurrent_runs = 5 WHERE id = ${userId}`
    const runs: Array<{ runId: string; itemId: string }> = []
    for (let i = 0; i < nProjects; i++) {
      const p = await h.sql<{ id: string }[]>`
        INSERT INTO corch_projects (user_id, repo_ident) VALUES (${userId}, ${`github://acme/app-${randomUUID()}`}) RETURNING id`
      await corchStore.enqueueWorkItem({ userId, projectId: p[0]!.id, source: 'manual', sourceRef: `q-${randomUUID()}`, title: 't', body: '', priority: 0 })
      const claimed = await corchStore.claimNext(userId, [])
      if (!claimed) throw new Error('fixture: nothing claimed')
      runs.push({ runId: claimed.run.id, itemId: claimed.item.id })
    }
    return { corchStore, runs }
  }
  async function provider(supervisors: Array<{ supervisorId: string; accountSlot: string; maxConcurrent: number }>) {
    const { quotaStore } = await import('../../src/corch/quota-store.ts')
    const { createQuotaProvider } = await import('../../src/corch/quota-provider.ts')
    return {
      quotaStore,
      provider: createQuotaProvider({
        accountsFor: (u) => quotaStore.accountsFor(u),
        liveRunsByAccount: (u, ex) => quotaStore.liveRunsByAccount(u, ex),
        onlineSlotSupervisors: () => supervisors,
        claimAccountSlot: (r, u, a, c) => quotaStore.claimAccountSlot(r, u, a, c),
        now: () => new Date(),
        ceilingPct: () => 55,
        markDeath: (a) => quotaStore.markDeath(a),
      }),
    }
  }

  test('F7: an incoming reading older than the stored fetched_at is ignored (no overwrite, no received_at refresh); equal or newer is applied', async () => {
    const u = await newUser()
    const t0 = Date.now() - 60_000
    await post(snapshot([acct('ord', { five_h_pct: 10, fetched_at: new Date(t0).toISOString() })]), u.publish)
    const read = async () =>
      (await h.sql`SELECT five_h_pct, fetched_at, received_at FROM corch_quota_accounts WHERE user_id = ${u.userId} AND account_id = 'ord'`)[0]!
    const first = await read()
    await new Promise((r) => setTimeout(r, 20))
    await post(snapshot([acct('ord', { five_h_pct: 90, fetched_at: new Date(t0 - 30_000).toISOString() })]), u.publish)
    const afterOld = await read()
    expect(Number(afterOld.five_h_pct)).toBe(10)
    expect(afterOld.fetched_at.getTime()).toBe(first.fetched_at.getTime())
    expect(afterOld.received_at.getTime()).toBe(first.received_at.getTime())
    await post(snapshot([acct('ord', { five_h_pct: 30, fetched_at: new Date(t0).toISOString() })]), u.publish) // equal => applied
    expect(Number((await read()).five_h_pct)).toBe(30)
    await post(snapshot([acct('ord', { five_h_pct: 40, fetched_at: new Date(t0 + 10_000).toISOString() })]), u.publish)
    expect(Number((await read()).five_h_pct)).toBe(40)
  })

  test('QC2 G2: a future-dated reading is a 400 and never stored, so a genuine live reading after a death still clears the block', async () => {
    const u = await newUser()
    await post(snapshot([acct('fut', { fetched_at: new Date(Date.now() - 60_000).toISOString() })]), u.publish)
    const bad = await post(snapshot([acct('fut', { fetched_at: '2099-01-01T00:00:00Z' })]), u.publish)
    expect(bad.status).toBe(400)
    const stored = (await h.sql`SELECT fetched_at FROM corch_quota_accounts WHERE user_id = ${u.userId} AND account_id = 'fut'`)[0]!
    expect(stored.fetched_at.getFullYear()).toBeLessThan(2099)
    const { quotaStore } = await provider([])
    await quotaStore.markDeath({ userId: u.userId, accountId: 'fut', resetAt: null })
    await new Promise((r) => setTimeout(r, 20))
    expect((await post(snapshot([acct('fut', { fetched_at: new Date(Date.now() + 5_000).toISOString() })]), u.publish)).status).toBe(200)
    const cleared = await blockRow(u.userId, 'fut')
    expect(cleared.blocked_until).toBeNull()
  })

  test('the real provider picks the lowest account and records corch_runs.account_slot', async () => {
    const u = await newUser()
    await post(snapshot([acct('hi', { five_h_pct: 40, seven_d_pct: 30 }), acct('lo', { five_h_pct: 5, seven_d_pct: 10 }), acct('mid', { five_h_pct: 20, seven_d_pct: 20 })]), u.publish)
    const { runs } = await fixture(u.userId, 1)
    const { provider: p } = await provider([
      { supervisorId: 's-hi', accountSlot: 'hi', maxConcurrent: 1 },
      { supervisorId: 's-lo', accountSlot: 'lo', maxConcurrent: 1 },
      { supervisorId: 's-mid', accountSlot: 'mid', maxConcurrent: 1 },
    ])
    const r = await p.snapshotFor({ userId: u.userId, projectId: 'x', workItemId: runs[0]!.itemId, runId: runs[0]!.runId })
    expect(r).toEqual({ ok: true, account_slot: 'lo', supervisor_id: 's-lo' })
    const row = (await h.sql`SELECT account_slot FROM corch_runs WHERE id = ${runs[0]!.runId}`)[0]!
    expect(row.account_slot).toBe('lo')
    // already holding an account: never moved
    const again = await p.snapshotFor({ userId: u.userId, projectId: 'x', workItemId: runs[0]!.itemId, runId: runs[0]!.runId, accountSlot: 'lo' })
    expect(again).toMatchObject({ ok: true, account_slot: 'lo' })
  })

  test('a second claim beyond capacity on a null-5h account is refused; the conditional UPDATE enforces capacity', async () => {
    const u = await newUser()
    await post(snapshot([acct('n1', { five_h_pct: null, seven_d_pct: 10 })]), u.publish)
    const { runs } = await fixture(u.userId, 2)
    const { provider: p, quotaStore } = await provider([{ supervisorId: 's-n1', accountSlot: 'n1', maxConcurrent: 3 }])
    const first = await p.snapshotFor({ userId: u.userId, projectId: 'x', workItemId: 'w', runId: runs[0]!.runId })
    expect(first).toMatchObject({ ok: true, account_slot: 'n1' })
    // the real busy count already makes the account ineligible for run 2 (null 5h, one live run)
    const second = await p.snapshotFor({ userId: u.userId, projectId: 'x', workItemId: 'w', runId: runs[1]!.runId })
    expect(second).toEqual({ ok: false, reason: 'quota:five_h_unknown_busy' })
    // and the conditional UPDATE itself refuses beyond capacity 1
    expect(await quotaStore.claimAccountSlot(runs[1]!.runId, u.userId, 'n1', 1)).toBe(false)
    expect((await h.sql`SELECT account_slot FROM corch_runs WHERE id = ${runs[1]!.runId}`)[0]!.account_slot).toBeNull()
    // within a larger capacity the same conditional UPDATE succeeds, once
    expect(await quotaStore.claimAccountSlot(runs[1]!.runId, u.userId, 'n1', 2)).toBe(true)
    expect(await quotaStore.claimAccountSlot(runs[1]!.runId, u.userId, 'n1', 2)).toBe(false) // already set
  })

  test('F4: claimAccountSlot waits on the per-(user, account) advisory lock (serialized, not a racy count)', async () => {
    const u = await newUser()
    await post(snapshot([acct('lk', { five_h_pct: null, seven_d_pct: 10 })]), u.publish)
    const { runs } = await fixture(u.userId, 1)
    const { quotaStore } = await provider([])
    let release!: () => void
    const held = new Promise<void>((r) => (release = r))
    let locked!: () => void
    const lockTaken = new Promise<void>((r) => (locked = r))
    const holder = h.sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext(${u.userId}::text || ':' || ${'lk'}::text))`
      locked()
      await held
    })
    await lockTaken
    let settled = false
    const claim = quotaStore.claimAccountSlot(runs[0]!.runId, u.userId, 'lk', 1).then((v) => ((settled = true), v))
    await new Promise((r) => setTimeout(r, 300))
    expect(settled).toBe(false) // blocked behind the lock
    release()
    await holder
    expect(await claim).toBe(true)
  })

  test('F4: concurrent claims by different runs on a null-5h account: exactly one wins (capacity 1)', async () => {
    const u = await newUser()
    await post(snapshot([acct('race', { five_h_pct: null, seven_d_pct: 10 })]), u.publish)
    const { runs } = await fixture(u.userId, 5)
    const { quotaStore } = await provider([])
    const results = await Promise.all(runs.map((r) => quotaStore.claimAccountSlot(r.runId, u.userId, 'race', 1)))
    expect(results.filter(Boolean).length).toBe(1)
    const held = await h.sql`SELECT count(*)::int AS n FROM corch_runs WHERE user_id = ${u.userId} AND account_slot = 'race'`
    expect(held[0]!.n).toBe(1)
  })

  test('a quota refusal through endRunAndRequeue {at}: queued, wait_reason quota:<reason>, attempts unchanged, not_before = instant', async () => {
    const u = await newUser()
    const { corchStore, runs } = await fixture(u.userId, 1)
    const at = new Date(Date.now() + 2 * 3600_000)
    at.setMilliseconds(0)
    const res = await corchStore.endRunAndRequeue(runs[0]!.runId, {
      endReason: 'quota:over_ceiling', consumeAttempt: false, waitReason: 'quota:over_ceiling', notBefore: { at: at.toISOString() },
    })
    expect(res.changed).toBe(true)
    const item = (await h.sql`SELECT status, wait_reason, attempts, not_before FROM corch_work_items WHERE id = ${runs[0]!.itemId}`)[0]!
    expect(item.status).toBe('queued')
    expect(item.wait_reason).toBe('quota:over_ceiling')
    expect(item.attempts).toBe(0)
    expect(item.not_before.getTime()).toBe(at.getTime())
    expect((await h.sql`SELECT end_reason FROM corch_runs WHERE id = ${runs[0]!.runId}`)[0]!.end_reason).toBe('quota:over_ceiling')
  })

  test('a quota death through the dispatcher RunStore path: blocked_until set, queued with quota:death, attempts unchanged', async () => {
    process.env.REMO_CORCH_ENABLED = '1'
    const u = await newUser()
    await post(snapshot([acct('dead1', { five_h_pct: 5, seven_d_pct: 10 })]), u.publish)
    const { createCorchDispatcher } = await import('../../src/corch/dispatcher.ts')
    const { corchStore } = await import('../../src/corch/store.ts')
    await h.sql`UPDATE users SET corch_max_concurrent_runs = 5 WHERE id = ${u.userId}`
    const p = await h.sql<{ id: string }[]>`
      INSERT INTO corch_projects (user_id, repo_ident) VALUES (${u.userId}, ${`github://acme/death-${randomUUID()}`}) RETURNING id`
    const item = await corchStore.enqueueWorkItem({ userId: u.userId, projectId: p[0]!.id, source: 'manual', sourceRef: `d-${randomUUID()}`, title: 't', body: '', priority: 0 })
    const { provider: quota } = await provider([{ supervisorId: 's-d', accountSlot: 'dead1', maxConcurrent: 1 }])
    const captured: any[] = []
    const deps: any = {
      store: corchStore,
      workspace: { resolve: async () => ({ ok: true, sessionId: `s-${randomUUID()}`, worktreePath: 'C:/wt/app' }) },
      launch: {
        // what the quota gate does at dispatch: pick and record the account on the run (the F5 launch binding reads it)
        tzForUser: async () => 'UTC', reserve: async () => ({ ok: true }), release: async () => {},
        checkGates: async (req: any) => { await quota.snapshotFor({ userId: u.userId, projectId: p[0]!.id, workItemId: item.item.id, runId: String(req.token).replace('corch-run:', '') }); return null },
        isRepoAutospawnAllowed: async () => true, supervisorOnlineForUser: async () => true, getTokenCapStatus: async () => ({ over: false }),
        countAutospawnLaunchesToday: async () => 0, isOverAutospawnDailyLaunchCap: () => false, graceParkPending: () => false,
        launchSessionForUser: async () => ({ ok: true, runId: 'sup-run', supervisorId: 'sup-1' }), appendRunLog: async () => {},
      },
      launchCommand: 'corch_test_launch',
      quota,
      pipeline: { isOnline: async () => true, send: async () => {} },
      dispatch: async (req: any, pdeps: any) => (captured.push({ req, pdeps }), { kind: 'dispatched', runId: 'x' }),
      prLookup: { lookup: async () => { throw new Error('PR lookup must not run on a quota death') } },
      notify: async () => {},
      timers: { setTimeout: () => ({}), clearTimeout: () => {} },
    }
    await createCorchDispatcher(deps).evaluateUser(u.userId)
    const live = await h.sql`SELECT id FROM corch_runs WHERE user_id = ${u.userId} AND ended_at IS NULL`
    expect(live.length).toBe(1)
    const runId = live[0]!.id as string
    expect((await h.sql`SELECT account_slot FROM corch_runs WHERE id = ${runId}`)[0]!.account_slot).toBe('dead1')

    await captured[0].pdeps.store.onFinalize(captured[0].req.token, "You've hit your session limit · resets 3pm (America/Los_Angeles)")

    const acctRow = (await h.sql`SELECT blocked_at, blocked_until, resets_5h FROM corch_quota_accounts WHERE user_id = ${u.userId} AND account_id = 'dead1'`)[0]!
    expect(acctRow.blocked_at).not.toBeNull()
    expect(acctRow.blocked_until.getTime()).toBe(acctRow.resets_5h.getTime()) // the named window's reset
    const it = (await h.sql`SELECT status, wait_reason, attempts, not_before FROM corch_work_items WHERE id = ${item.item.id}`)[0]!
    expect(it.status).toBe('queued')
    expect(it.wait_reason).toBe('quota:death')
    expect(it.attempts).toBe(0)
    // QC2 G1: the account block (not the item deadline) governs quota; the item only backs off ~600s.
    expect(Math.abs(it.not_before.getTime() - (Date.now() + 600_000))).toBeLessThan(60_000)
    expect(it.not_before.getTime()).toBeLessThan(acctRow.blocked_until.getTime())
    expect((await h.sql`SELECT end_reason FROM corch_runs WHERE id = ${runId}`)[0]!.end_reason).toBe('quota_death')
    // the account now reads as blocked through GET
    const g = (await (await get(u.read)).json()) as any
    expect(g.accounts[0]).toMatchObject({ eligible: false, reason: 'quota:blocked' })

    // QC2 G1: death -> clearing live snapshot -> the item is reclaimable once its 600s backoff has passed.
    await new Promise((r) => setTimeout(r, 20))
    await post(snapshot([acct('dead1', { five_h_pct: 5, seven_d_pct: 10, fetched_at: new Date(Date.now() + 5_000).toISOString() })]), u.publish)
    expect(((await (await get(u.read)).json()) as any).accounts[0]).toMatchObject({ eligible: true, reason: null })
    expect(await corchStore.claimNext(u.userId, [])).toBeNull() // still inside the 600s backoff
    await h.sql`UPDATE corch_work_items SET not_before = now() - interval '1 second' WHERE id = ${item.item.id}` // the backoff passes
    const reclaimed = await corchStore.claimNext(u.userId, [])
    expect(reclaimed?.item.id).toBe(item.item.id)
  })

  test('QC3 H1: death -> still over ceiling -> backoff expires -> quota refusal -> healthy reading before reset releases the item within 600s', async () => {
    process.env.REMO_CORCH_ENABLED = '1'
    const u = await newUser()
    await post(snapshot([acct('h1', { five_h_pct: 5, seven_d_pct: 10 })]), u.publish)
    const { createCorchDispatcher } = await import('../../src/corch/dispatcher.ts')
    const { corchStore } = await import('../../src/corch/store.ts')
    await h.sql`UPDATE users SET corch_max_concurrent_runs = 5 WHERE id = ${u.userId}`
    const p = await h.sql<{ id: string }[]>`
      INSERT INTO corch_projects (user_id, repo_ident) VALUES (${u.userId}, ${`github://acme/h1-${randomUUID()}`}) RETURNING id`
    const item = await corchStore.enqueueWorkItem({ userId: u.userId, projectId: p[0]!.id, source: 'manual', sourceRef: `h1-${randomUUID()}`, title: 't', body: '', priority: 0 })
    const { provider: quota } = await provider([{ supervisorId: 's-h1', accountSlot: 'h1', maxConcurrent: 1 }])
    const captured: any[] = []
    const deps: any = {
      store: corchStore,
      workspace: { resolve: async () => ({ ok: true, sessionId: `s-${randomUUID()}`, worktreePath: 'C:/wt/app' }) },
      launch: {
        tzForUser: async () => 'UTC', reserve: async () => ({ ok: true }), release: async () => {},
        // the quota gate's verdict is the refusal reason (what the real gate returns), null when an account is eligible
        checkGates: async (req: any) => {
          const r: any = await quota.snapshotFor({ userId: u.userId, projectId: p[0]!.id, workItemId: item.item.id, runId: String(req.token).replace('corch-run:', '') })
          return r.ok ? null : r.reason
        },
        isRepoAutospawnAllowed: async () => true, supervisorOnlineForUser: async () => true, getTokenCapStatus: async () => ({ over: false }),
        countAutospawnLaunchesToday: async () => 0, isOverAutospawnDailyLaunchCap: () => false, graceParkPending: () => false,
        launchSessionForUser: async () => ({ ok: true, runId: 'sup-run', supervisorId: 'sup-1' }), appendRunLog: async () => {},
      },
      launchCommand: 'corch_test_launch',
      quota,
      pipeline: { isOnline: async () => true, send: async () => {} },
      dispatch: async (req: any, pdeps: any) => (captured.push({ req, pdeps }), { kind: 'dispatched', runId: 'x' }),
      prLookup: { lookup: async () => { throw new Error('PR lookup must not run on a quota death') } },
      notify: async () => {},
      timers: { setTimeout: () => ({}), clearTimeout: () => {} },
    }
    const dispatcher = createCorchDispatcher(deps)
    await dispatcher.evaluateUser(u.userId)
    expect(captured.length).toBe(1)
    await captured[0].pdeps.store.onFinalize(captured[0].req.token, "You've hit your session limit · resets 3pm (America/Los_Angeles)")

    // a fresh live reading that is STILL over the ceiling clears the death block but leaves the account ineligible
    const resetAt = new Date(Date.now() + 3 * 3600_000).toISOString()
    await new Promise((r) => setTimeout(r, 20))
    await post(snapshot([acct('h1', { five_h_pct: 99, seven_d_pct: 99, resets_5h: resetAt, fetched_at: new Date(Date.now() + 5_000).toISOString() })]), u.publish)
    // the 600s backoff expires, the item is re-dispatched and refused by quota
    await h.sql`UPDATE corch_work_items SET not_before = now() - interval '1 second' WHERE id = ${item.item.id}`
    await dispatcher.evaluateUser(u.userId)
    const refused = (await h.sql`SELECT status, wait_reason, attempts, not_before FROM corch_work_items WHERE id = ${item.item.id}`)[0]!
    expect(refused.status).toBe('queued')
    expect(refused.wait_reason).toMatch(/^quota:/)
    expect(refused.attempts).toBe(0)
    // held for one backoff window, NOT until the 3h reset
    expect(Math.abs(refused.not_before.getTime() - (Date.now() + 600_000))).toBeLessThan(60_000)
    expect(refused.not_before.getTime()).toBeLessThan(new Date(resetAt).getTime())

    // a healthy reading arrives before the reset; the item is claimable once the (<=600s) backoff has passed
    await new Promise((r) => setTimeout(r, 20))
    await post(snapshot([acct('h1', { five_h_pct: 5, seven_d_pct: 10, fetched_at: new Date(Date.now() + 10_000).toISOString() })]), u.publish)
    expect(((await (await get(u.read)).json()) as any).accounts[0]).toMatchObject({ eligible: true, reason: null })
    expect(await corchStore.claimNext(u.userId, [])).toBeNull() // inside the backoff
    await h.sql`UPDATE corch_work_items SET not_before = not_before - interval '601 seconds' WHERE id = ${item.item.id}` // 600s elapse
    expect((await corchStore.claimNext(u.userId, []))?.item.id).toBe(item.item.id)
  })

  const blockRow = async (userId: string, id: string) =>
    (await h.sql`SELECT blocked_at, blocked_until FROM corch_quota_accounts WHERE user_id = ${userId} AND account_id = ${id}`)[0]!
  const approx = (d: Date, ms: number) => Math.abs(d.getTime() - (Date.now() + ms)) < 60_000

  test('F1: a death with no usable reset blocks for now+5h (never indefinitely); an older reading does not clear it, a newer live one does', async () => {
    const u = await newUser()
    const past = new Date(Date.now() - 3600_000).toISOString()
    await post(snapshot([acct('nb', { resets_5h: past, resets_7d: past })]), u.publish)
    const { quotaStore } = await provider([])
    const got = await quotaStore.markDeath({ userId: u.userId, accountId: 'nb', resetAt: null })
    expect(got).not.toBeNull()
    expect(approx(got!, 5 * 3600_000)).toBe(true)
    const blocked = await blockRow(u.userId, 'nb')
    expect(blocked.blocked_at).not.toBeNull()
    expect(approx(blocked.blocked_until, 5 * 3600_000)).toBe(true)
    // a reading fetched BEFORE the death does not clear it
    await post(snapshot([acct('nb', { fetched_at: new Date(Date.now() - 30_000).toISOString() })]), u.publish)
    expect((await blockRow(u.userId, 'nb')).blocked_until).not.toBeNull()
    // a non-live reading fetched after the death does not clear it
    await new Promise((r) => setTimeout(r, 20))
    await post(snapshot([acct('nb', { source: 'cache', fetched_at: new Date(Date.now() + 5_000).toISOString() })]), u.publish)
    expect((await blockRow(u.userId, 'nb')).blocked_until).not.toBeNull()
    // a live reading fetched AFTER the death clears block and death mark
    await post(snapshot([acct('nb', { fetched_at: new Date(Date.now() + 5_000).toISOString() })]), u.publish)
    const cleared = await blockRow(u.userId, 'nb')
    expect(cleared.blocked_at).toBeNull()
    expect(cleared.blocked_until).toBeNull()
  })

  test('F1: a far-future legacy epoch is clamped to now+5h (5h/legacy) or now+7d (7d window); a past epoch falls back to the reading reset', async () => {
    const u = await newUser()
    await post(snapshot([acct('c5'), acct('c7'), acct('cp', { resets_5h: new Date(Date.now() + 2 * 3600_000).toISOString() })]), u.publish)
    const { quotaStore } = await provider([])
    const far = new Date(99999999999 * 1000)
    const a = await quotaStore.markDeath({ userId: u.userId, accountId: 'c5', resetAt: far })
    expect(approx(a!, 5 * 3600_000)).toBe(true)
    const b = await quotaStore.markDeath({ userId: u.userId, accountId: 'c7', resetAt: far, window: '7d' })
    expect(approx(b!, 7 * 86_400_000)).toBe(true)
    const c = await quotaStore.markDeath({ userId: u.userId, accountId: 'cp', resetAt: new Date(Date.now() - 1000), window: '5h' })
    expect(approx(c!, 2 * 3600_000)).toBe(true) // the reading's own 5h reset (< cap)
  })

  test('F1: a death at low usage is cleared by the next live reading (GET reads eligible again)', async () => {
    const u = await newUser()
    await post(snapshot([acct('low', { five_h_pct: 3, seven_d_pct: 4 })]), u.publish)
    const { quotaStore } = await provider([])
    await quotaStore.markDeath({ userId: u.userId, accountId: 'low', resetAt: new Date(99999999999 * 1000) })
    expect(((await (await get(u.read)).json()) as any).accounts[0]).toMatchObject({ eligible: false, reason: 'quota:blocked' })
    await new Promise((r) => setTimeout(r, 20))
    await post(snapshot([acct('low', { five_h_pct: 3, seven_d_pct: 4, fetched_at: new Date(Date.now() + 5_000).toISOString() })]), u.publish)
    expect(((await (await get(u.read)).json()) as any).accounts[0]).toMatchObject({ eligible: true, reason: null })
  })

  test('F2: markDeath keeps the later of the existing and the new blocked_until, in both orders', async () => {
    const u = await newUser()
    await post(snapshot([acct('g1'), acct('g2')]), u.publish)
    const { quotaStore } = await provider([])
    const in4h = new Date(Date.now() + 4 * 3600_000)
    const in1h = new Date(Date.now() + 3600_000)
    // long then short: stays long
    await quotaStore.markDeath({ userId: u.userId, accountId: 'g1', resetAt: in4h })
    const r1 = await quotaStore.markDeath({ userId: u.userId, accountId: 'g1', resetAt: in1h })
    expect(r1!.getTime()).toBe(in4h.getTime())
    expect((await blockRow(u.userId, 'g1')).blocked_until.getTime()).toBe(in4h.getTime())
    // short then long: becomes long
    await quotaStore.markDeath({ userId: u.userId, accountId: 'g2', resetAt: in1h })
    const r2 = await quotaStore.markDeath({ userId: u.userId, accountId: 'g2', resetAt: in4h })
    expect(r2!.getTime()).toBe(in4h.getTime())
  })

  test('an explicit in-cap resetAt wins; a past resetAt falls back; an unknown account has nothing to block', async () => {
    const u = await newUser()
    await post(snapshot([acct('tb')]), u.publish)
    const { quotaStore } = await provider([])
    const until = new Date(Date.now() + 3 * 3600_000)
    const got = await quotaStore.markDeath({ userId: u.userId, accountId: 'tb', resetAt: until })
    expect(got?.getTime()).toBe(until.getTime())
    expect((await blockRow(u.userId, 'tb')).blocked_until.getTime()).toBe(until.getTime())
    expect(await quotaStore.markDeath({ userId: u.userId, accountId: 'nope', resetAt: until })).toBeNull()
  })
})
