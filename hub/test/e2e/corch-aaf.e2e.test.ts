// CORCH-08 e2e on real Postgres. Skips only when REMO_E2E_DB_URL is unset.
// Receiver + closure transitions through the REAL store, the dispatch provision gate, and the provisioning
// backfill against a fake AAF. DATABASE_URL is pointed at the disposable DB before any hub module loads.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-chars-long-aaaaaaaa'
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'session-secret-at-least-32-chars-long-x'
process.env.MAGIC_LINK_SECRET = process.env.MAGIC_LINK_SECRET || 'magic-link-secret-at-least-32-chars-x'
process.env.TITANIUM_KEYGEN_API_URL = process.env.TITANIUM_KEYGEN_API_URL || 'https://keygen.titaniumlabs.us'
process.env.TITANIUM_KEYGEN_ACCOUNT_ID = process.env.TITANIUM_KEYGEN_ACCOUNT_ID || 'acct_test_0000000000'
process.env.TITANIUM_KEYGEN_PRODUCT_ID = process.env.TITANIUM_KEYGEN_PRODUCT_ID || 'prod_test_remo'

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { createHmac, randomBytes, randomUUID } from 'node:crypto'

const HAS_TEST_DB = !!process.env.REMO_E2E_DB_URL
const maybe = HAS_TEST_DB ? describe : describe.skip
const SECRET = randomBytes(24).toString('hex')

maybe('CORCH-08 e2e - AAF event receiver, closure transitions and provision gate on real Postgres', () => {
  let harness: typeof import('./orchestrator-harness.ts')
  let h: import('./orchestrator-harness.ts').Harness
  let storeMod: typeof import('../../src/corch/store.ts')
  let evMod: typeof import('../../src/corch/aaf-events.ts')
  let provMod: typeof import('../../src/corch/aaf-provision.ts')
  let dispMod: typeof import('../../src/corch/dispatcher.ts')
  let recMod: typeof import('../../src/corch/reconciler.ts')
  const users: string[] = []
  const savedEnv: Record<string, string | undefined> = {}
  const ENV = ['REMO_CORCH_ENABLED', 'REMO_CORCH_AAF_URL', 'REMO_CORCH_AAF_TOKEN', 'REMO_CORCH_AAF_INSTALLATION_ID']

  let notified: Array<[string, string]> = []
  let evaluated: string[] = []
  let cancelled: string[] = []

  beforeAll(async () => {
    for (const k of ENV) savedEnv[k] = process.env[k]
    process.env.DATABASE_URL = process.env.REMO_E2E_DB_URL!
    harness = await import('./orchestrator-harness.ts')
    h = await harness.setupHarness()
    storeMod = await import('../../src/corch/store.ts')
    evMod = await import('../../src/corch/aaf-events.ts')
    provMod = await import('../../src/corch/aaf-provision.ts')
    dispMod = await import('../../src/corch/dispatcher.ts')
    recMod = await import('../../src/corch/reconciler.ts')
  }, 60_000)

  afterAll(async () => {
    for (const k of ENV) savedEnv[k] === undefined ? delete process.env[k] : (process.env[k] = savedEnv[k])
    if (users.length) await h.sql`DELETE FROM users WHERE id = ANY(${users})`
    if (h) await harness.teardownHarness(h)
  })

  async function mkUser(): Promise<string> {
    const r = await h.sql<{ id: string }[]>`
      INSERT INTO users (email, password_hash, role) VALUES (${`e2e-aaf-${randomUUID()}@invalid.local`}, 'x', 'user') RETURNING id`
    users.push(r[0]!.id)
    return r[0]!.id
  }
  async function mkProject(userId: string, repo: string, status = 'provisioned'): Promise<string> {
    const r = await h.sql<{ id: string }[]>`
      INSERT INTO corch_projects (user_id, repo_ident, aaf_provision_status) VALUES (${userId}, ${repo}, ${status}) RETURNING id`
    return r[0]!.id
  }
  async function mkItem(userId: string, projectId: string, status = 'pr_open'): Promise<{ id: string; branch: string }> {
    const e = await storeMod.corchStore.enqueueWorkItem({
      userId, projectId, source: 'manual', sourceRef: `aaf-${randomUUID()}`, title: 't', body: '', priority: 0,
    })
    await h.sql`UPDATE corch_work_items SET status = ${status} WHERE id = ${e.item.id}`
    return { id: e.item.id, branch: e.item.branch }
  }
  const itemRow = async (id: string) => (await h.sql`SELECT * FROM corch_work_items WHERE id = ${id}`)[0]!
  const eventRow = async (eventId: string) => (await h.sql`SELECT * FROM corch_events WHERE event_id = ${eventId}`)[0]
  const eventCount = async (eventId: string) =>
    (await h.sql`SELECT count(*)::int AS n FROM corch_events WHERE event_id = ${eventId}`)[0]!.n as number

  const sign = (ts: number, body: string) => 'sha256=' + createHmac('sha256', SECRET).update(`${ts}.${body}`).digest('hex')
  function receiver() {
    return evMod.createAafEventRoutes({
      secret: () => SECRET,
      store: storeMod.corchStore,
      notifyFailed: async (u, w) => {
        notified.push([u, w])
        return true
      },
      evaluate: async (u) => {
        evaluated.push(u)
      },
      cancelRunSends: async (ids) => {
        cancelled.push(...ids)
      },
    })
  }
  async function send(o: { event: string; repo: string; headRef: string; eventId?: string }) {
    const eventId = o.eventId ?? `evt-${randomUUID()}`
    const body = JSON.stringify({ event_id: eventId, event: o.event, repo: o.repo, pr_number: 3, head_ref: o.headRef, occurred_at: new Date().toISOString() })
    const ts = Math.floor(Date.now() / 1000)
    const res = await receiver().request('/aaf', {
      method: 'POST',
      body,
      headers: { 'x-zeroexposure-timestamp': String(ts), 'x-zeroexposure-signature': sign(ts, body), 'x-zeroexposure-event-id': eventId },
    })
    return { res, eventId }
  }

  test('schema: new columns/table exist, default is aaf_unprovisioned, event_id is unique', async () => {
    const u = await mkUser()
    const p = await h.sql<{ aaf_provision_status: string; aaf_project_id: string | null }[]>`
      INSERT INTO corch_projects (user_id, repo_ident) VALUES (${u}, ${`github://acme/def-${randomUUID()}`}) RETURNING aaf_provision_status, aaf_project_id`
    expect(p[0]!.aaf_provision_status).toBe('aaf_unprovisioned')
    expect(p[0]!.aaf_project_id).toBeNull()
    const uniq = `uniq-${randomUUID()}`
    await h.sql`INSERT INTO corch_events (event_id, event, repo, head_ref) VALUES (${uniq}, 'pr.merged', 'a/b', 'corch/x')`
    let dup = false
    try {
      await h.sql`INSERT INTO corch_events (event_id, event, repo, head_ref) VALUES (${uniq}, 'pr.merged', 'a/b', 'corch/x')`
    } catch (err: any) {
      dup = err?.code === '23505'
    }
    expect(dup).toBe(true)
    let bad = false
    try {
      await h.sql`UPDATE corch_projects SET aaf_provision_status = 'nonsense' WHERE user_id = ${u}`
    } catch (err: any) {
      bad = err?.code === '23514'
    }
    expect(bad).toBe(true)
  })

  test('pr.merged => done (200 applied); a replayed event_id => 200 duplicate, no second transition or row', async () => {
    const u = await mkUser()
    const proj = await mkProject(u, 'github://acme/app')
    const it = await mkItem(u, proj)
    const { res, eventId } = await send({ event: 'pr.merged', repo: 'acme/app', headRef: it.branch })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, status: 'applied' })
    expect((await itemRow(it.id)).status).toBe('done')
    const ev = await eventRow(eventId)
    expect(ev.outcome).toBe('done')
    expect(ev.work_item_id).toBe(it.id)
    expect(ev.user_id).toBe(u)

    // Re-open the item by hand, then replay: the dedupe (not the status) must be what stops a second transition.
    await h.sql`UPDATE corch_work_items SET status = 'pr_open' WHERE id = ${it.id}`
    const again = await send({ event: 'pr.merged', repo: 'acme/app', headRef: it.branch, eventId })
    expect(again.res.status).toBe(200)
    expect(await again.res.json()).toEqual({ ok: true, status: 'duplicate' })
    expect((await itemRow(it.id)).status).toBe('pr_open')
    expect(await eventCount(eventId)).toBe(1)
  })

  test('repo match is case-insensitive and exact: another repo or a malformed head ref changes nothing and is audited', async () => {
    const u = await mkUser()
    const proj = await mkProject(u, 'github://acme/case-app')
    const it = await mkItem(u, proj)
    const wrongRepo = await send({ event: 'pr.merged', repo: 'acme/other-app', headRef: it.branch })
    expect(await wrongRepo.res.json()).toEqual({ ok: true, status: 'ignored' })
    const badRef = await send({ event: 'pr.merged', repo: 'acme/case-app', headRef: 'corch/not-a-uuid' })
    expect(await badRef.res.json()).toEqual({ ok: true, status: 'ignored' })
    const foreignRef = await send({ event: 'pr.merged', repo: 'acme/case-app', headRef: 'feature/x' })
    expect(await foreignRef.res.json()).toEqual({ ok: true, status: 'ignored' })
    const unknownId = await send({ event: 'pr.merged', repo: 'acme/case-app', headRef: `corch/${randomUUID()}` })
    expect(await unknownId.res.json()).toEqual({ ok: true, status: 'ignored' })
    expect((await itemRow(it.id)).status).toBe('pr_open')
    for (const e of [wrongRepo, badRef, foreignRef, unknownId]) {
      const row = await eventRow(e.eventId)
      expect(row.outcome).toBe('unknown_item')
      expect(row.work_item_id).toBeNull()
    }
    const mixed = await send({ event: 'pr.merged', repo: 'ACME/Case-App', headRef: it.branch })
    expect(await mixed.res.json()).toEqual({ ok: true, status: 'applied' })
    expect((await itemRow(it.id)).status).toBe('done')
  })

  test('terminal items (done, cancelled) are 200 ignored, audited, unchanged', async () => {
    const u = await mkUser()
    const proj = await mkProject(u, 'github://acme/term')
    for (const status of ['done', 'cancelled']) {
      const it = await mkItem(u, proj, status)
      const before = await itemRow(it.id)
      for (const event of ['pr.merged', 'pr.closed', 'pr.failed']) {
        const r = await send({ event, repo: 'acme/term', headRef: it.branch })
        expect(await r.res.json()).toEqual({ ok: true, status: 'ignored' })
        expect((await eventRow(r.eventId)).outcome).toBe('terminal')
      }
      const after = await itemRow(it.id)
      expect(after.status).toBe(status)
      expect(after.updated_at.getTime()).toBe(before.updated_at.getTime())
    }
  })

  test('pr.closed (unmerged) => blocked, never requeued; stays blocked across reconciler passes and a later run end', async () => {
    process.env.REMO_CORCH_ENABLED = '1'
    const u = await mkUser()
    const proj = await mkProject(u, 'github://acme/closed')
    // A live (running) item whose run lost its session: the reconciler would normally reclaim + requeue it.
    const claimedItem = await mkItem(u, proj, 'queued')
    const c = await storeMod.corchStore.claimNext(u, [])
    expect(c?.item.id).toBe(claimedItem.id)
    const r = await send({ event: 'pr.closed', repo: 'acme/closed', headRef: claimedItem.branch })
    expect(await r.res.json()).toEqual({ ok: true, status: 'applied' })
    let row = await itemRow(claimedItem.id)
    expect(row.status).toBe('blocked')
    expect(row.wait_reason).toBe('pr_closed')
    expect(notified.filter(([, w]) => w === claimedItem.id).length).toBe(0) // pr.closed notifies nobody

    // The event ended the live run itself; re-open it to model a run the reconciler still sees (the race the
    // store's status guard covers), older than the lease: the pass ends it, the item is NOT requeued and NOT
    // re-notified as blocked by the dispatcher.
    expect((await h.sql`SELECT ended_at FROM corch_runs WHERE id = ${c!.run.id}`)[0]!.ended_at).not.toBeNull()
    await h.sql`UPDATE corch_runs SET ended_at = NULL, status = 'running', end_reason = NULL, started_at = now() - interval '10 minutes' WHERE id = ${c!.run.id}`
    const notes: any[] = []
    const deps: any = {
      store: storeMod.corchStore,
      workspace: dispMod.DEFAULT_WORKSPACE,
      launch: {},
      launchCommand: 'x',
      quota: {},
      pipeline: { isOnline: async () => true, send: async () => {}, releaseByToken: async () => {} },
      dispatch: async () => ({ kind: 'failed' }),
      prLookup: dispMod.DEFAULT_PR_LOOKUP,
      notify: async (n: any) => void notes.push(n),
      inventory: { forSupervisor: () => ({ fresh: true, sessionIds: new Set() }), forUser: () => ({ fresh: true, sessionIds: new Set() }), isOnline: () => false },
      timers: { setTimeout: () => ({}), clearTimeout: () => {} },
    }
    const d = dispMod.createCorchDispatcher(deps)
    await recMod.reconcilePass(deps, d)
    await recMod.reconcilePass(deps, d)
    const runs = await h.sql`SELECT * FROM corch_runs WHERE work_item_id = ${claimedItem.id}`
    expect(runs[0]!.ended_at).not.toBeNull()
    row = await itemRow(claimedItem.id)
    expect(row.status).toBe('blocked')
    expect(row.wait_reason).toBe('pr_closed')
    expect(row.attempts).toBe(0)
    expect(notes.filter((n) => n.kind === 'blocked').length).toBe(0)
    // And no later claim can pick it up.
    expect(await storeMod.corchStore.claimNext(u, [])).toBeNull()
  })

  test('pr.merged while a run is still live => done AND the live run is ended; a late run end cannot requeue it', async () => {
    const u = await mkUser()
    const proj = await mkProject(u, 'github://acme/merge-live')
    const it = await mkItem(u, proj, 'queued')
    const c = await storeMod.corchStore.claimNext(u, [])
    expect(c?.item.id).toBe(it.id)
    await send({ event: 'pr.merged', repo: 'acme/merge-live', headRef: it.branch })
    expect((await itemRow(it.id)).status).toBe('done')
    const run = (await h.sql`SELECT * FROM corch_runs WHERE id = ${c!.run.id}`)[0]!
    expect(run.ended_at).not.toBeNull()
    expect(run.end_reason).toBe('aaf_pr_merged')
    // The reconciler / watcher end path now finds the run already ended: a no-op.
    const end = await storeMod.corchStore.endRunAndRequeue(c!.run.id, { endReason: 'no_pr', consumeAttempt: true, waitReason: null, notBefore: null })
    expect(end.changed).toBe(false)
    const row = await itemRow(it.id)
    expect(row.status).toBe('done')
    expect(row.attempts).toBe(0)
  })

  test('closure invalidates a pending send: the run ends, every dispatch gate refuses corch_run_not_live, the slot is free', async () => {
    const keysMod = await import('../../src/corch/keys.ts')
    const gatesMod = await import('../../src/corch/gates.ts')
    for (const event of ['pr.closed', 'pr.failed', 'pr.merged']) {
      const u = await mkUser()
      const repo = `acme/parked-${event.replace('.', '-')}`
      const proj = await mkProject(u, `github://${repo}`)
      const it = await mkItem(u, proj, 'queued')
      const c = await storeMod.corchStore.claimNext(u, [])
      expect(c?.item.id).toBe(it.id)
      const r = await send({ event, repo, headRef: it.branch })
      expect(r.res.status).toBe(200)
      const ctx = await storeMod.corchStore.runContext(c!.run.id)
      expect(ctx!.run.ended_at).not.toBeNull()
      const gate = gatesMod.corchProjectBudgetGate(storeMod.corchStore)
      const verdict = await gate.check({ token: keysMod.buildCorchRunToken(c!.run.id) } as any)
      expect(verdict).toEqual({ ok: false, reason: 'corch_run_not_live' })
      expect((await h.sql`SELECT count(*)::int AS n FROM corch_runs WHERE user_id = ${u} AND ended_at IS NULL`)[0]!.n).toBe(0)
    }
  })

  test('race guard: if a closure moved the item while its run was still live, the run end leaves the item untouched', async () => {
    const u = await mkUser()
    const proj = await mkProject(u, 'github://acme/race-guard')
    const it = await mkItem(u, proj, 'queued')
    const c = await storeMod.corchStore.claimNext(u, [])
    expect(c?.item.id).toBe(it.id)
    // Simulate the closure landing without ending the run (the narrow race the status guard exists for).
    await h.sql`UPDATE corch_work_items SET status = 'blocked', wait_reason = 'pr_failed' WHERE id = ${it.id}`
    const end = await storeMod.corchStore.endRunAndRequeue(c!.run.id, { endReason: 'no_pr', consumeAttempt: true, waitReason: null, notBefore: null })
    expect(end.changed && end.itemUntouched).toBe(true)
    expect(end.changed && end.itemStatus).toBe('blocked')
    const row = await itemRow(it.id)
    expect(row.status).toBe('blocked')
    expect(row.attempts).toBe(0)
    expect(row.wait_reason).toBe('pr_failed')

    const it2 = await mkItem(u, proj, 'queued')
    const c2 = await storeMod.corchStore.claimNext(u, [])
    expect(c2?.item.id).toBe(it2.id)
    await h.sql`UPDATE corch_work_items SET status = 'blocked', wait_reason = 'pr_closed' WHERE id = ${it2.id}`
    const end2 = await storeMod.corchStore.endRunMarkPrOpen(c2!.run.id, 'https://example.test/pr/1')
    expect(end2.changed && end2.itemUntouched).toBe(true)
    expect((await itemRow(it2.id)).status).toBe('blocked')
  })

  test('a failed notification is durable: 503, state stays pending, the sender retry delivers it once', async () => {
    const u = await mkUser()
    const proj = await mkProject(u, 'github://acme/notify-retry')
    const it = await mkItem(u, proj)
    let fail = true
    const sent: string[] = []
    const app = evMod.createAafEventRoutes({
      secret: () => SECRET,
      store: storeMod.corchStore,
      notifyFailed: async (_u, w) => {
        if (fail) return false
        sent.push(w)
        return true
      },
      evaluate: async () => {},
      cancelRunSends: async () => {},
    })
    const eventId = `evt-${randomUUID()}`
    const body = JSON.stringify({ event_id: eventId, event: 'pr.failed', repo: 'acme/notify-retry', pr_number: 3, head_ref: it.branch })
    const call = () => {
      const ts = Math.floor(Date.now() / 1000)
      return app.request('/aaf', { method: 'POST', body, headers: { 'x-zeroexposure-timestamp': String(ts), 'x-zeroexposure-signature': sign(ts, body) } })
    }
    const first = await call()
    expect(first.status).toBe(503)
    expect((await itemRow(it.id)).status).toBe('blocked')
    expect((await eventRow(eventId)).notify_state).toBe('pending')
    fail = false
    const retry = await call()
    expect(retry.status).toBe(200)
    expect(await retry.json()).toEqual({ ok: true, status: 'duplicate' })
    expect((await eventRow(eventId)).notify_state).toBe('sent')
    expect((await call()).status).toBe(200)
    expect(sent).toEqual([it.id])
    expect(await eventCount(eventId)).toBe(1)
  })

  test('a stale sending claim (crash mid-send) is reclaimable; a fresh one is not', async () => {
    const u = await mkUser()
    const proj = await mkProject(u, 'github://acme/notify-stale')
    const it = await mkItem(u, proj)
    const r = await send({ event: 'pr.failed', repo: 'acme/notify-stale', headRef: it.branch })
    expect(r.res.status).toBe(200) // delivered through the injected notifier
    expect((await eventRow(r.eventId)).notify_state).toBe('sent')
    expect(await storeMod.corchStore.claimAafNotify(r.eventId)).toEqual({ kind: 'none' }) // already delivered
    await h.sql`UPDATE corch_events SET notify_state = 'pending' WHERE event_id = ${r.eventId}`
    const c1 = await storeMod.corchStore.claimAafNotify(r.eventId)
    expect(c1.kind).toBe('claimed')
    await storeMod.corchStore.finishAafNotify(r.eventId, (c1 as any).token, false) // released: pending again, not done
    await h.sql`UPDATE corch_events SET notify_state = 'sent' WHERE event_id = ${r.eventId}`
    await h.sql`UPDATE corch_events SET notify_state = 'sending', notify_claimed_at = now() WHERE event_id = ${r.eventId}`
    expect(await storeMod.corchStore.claimAafNotify(r.eventId)).toEqual({ kind: 'busy' }) // fresh claim: not done
    await h.sql`UPDATE corch_events SET notify_claimed_at = now() - interval '6 minutes' WHERE event_id = ${r.eventId}`
    const reclaimed = await storeMod.corchStore.claimAafNotify(r.eventId)
    expect(reclaimed.kind).toBe('claimed')
    expect(reclaimed.kind === 'claimed' && reclaimed.userId).toBe(u)
    expect(reclaimed.kind === 'claimed' && reclaimed.workItemId).toBe(it.id)
  })

  test('claim fencing: a superseded delivery cannot overwrite the new claim owner', async () => {
    const u = await mkUser()
    const proj = await mkProject(u, 'github://acme/notify-fence')
    const it = await mkItem(u, proj)
    const failing = evMod.createAafEventRoutes({
      secret: () => SECRET, store: storeMod.corchStore, notifyFailed: async () => false, evaluate: async () => {}, cancelRunSends: async () => {},
    })
    const eventId = `evt-${randomUUID()}`
    const body = JSON.stringify({ event_id: eventId, event: 'pr.failed', repo: 'acme/notify-fence', pr_number: 3, head_ref: it.branch })
    const ts = Math.floor(Date.now() / 1000)
    expect((await failing.request('/aaf', { method: 'POST', body, headers: { 'x-zeroexposure-timestamp': String(ts), 'x-zeroexposure-signature': sign(ts, body) } })).status).toBe(503)
    const old = await storeMod.corchStore.claimAafNotify(eventId)
    expect(old.kind).toBe('claimed')
    await h.sql`UPDATE corch_events SET notify_claimed_at = now() - interval '6 minutes' WHERE event_id = ${eventId}`
    const fresh = await storeMod.corchStore.claimAafNotify(eventId)
    expect(fresh.kind).toBe('claimed')
    // The old (slow) delivery finishes late with its stale token: ignored.
    await storeMod.corchStore.finishAafNotify(eventId, (old as any).token, true)
    expect((await eventRow(eventId)).notify_state).toBe('sending')
    await storeMod.corchStore.finishAafNotify(eventId, (fresh as any).token, true)
    expect((await eventRow(eventId)).notify_state).toBe('sent')
  })

  test('a closure that ends a live run cancels its in-process send guard', async () => {
    const u = await mkUser()
    const proj = await mkProject(u, 'github://acme/cancel-guard')
    const it = await mkItem(u, proj, 'queued')
    const c = await storeMod.corchStore.claimNext(u, [])
    expect(c?.item.id).toBe(it.id)
    cancelled = []
    await send({ event: 'pr.closed', repo: 'acme/cancel-guard', headRef: it.branch })
    expect(cancelled).toEqual([c!.run.id])
  })

  test('cancelRunSends releases the pipeline slot (hook + queue) like reclaimRun does', async () => {
    const keysMod = await import('../../src/corch/keys.ts')
    const released: Array<[string, string]> = []
    const deps: any = {
      store: storeMod.corchStore, workspace: dispMod.DEFAULT_WORKSPACE, launch: {}, launchCommand: 'x', quota: {},
      pipeline: { isOnline: async () => true, send: async () => {}, releaseByToken: async (t: string, r: string) => void released.push([t, r]) },
      dispatch: async () => ({ kind: 'failed' }), prLookup: dispMod.DEFAULT_PR_LOOKUP, notify: async () => {},
      inventory: { forSupervisor: () => ({ fresh: false, sessionIds: new Set() }), forUser: () => ({ fresh: false, sessionIds: new Set() }), isOnline: () => false },
      timers: { setTimeout: () => ({}), clearTimeout: () => {} },
    }
    const d = dispMod.createCorchDispatcher(deps)
    await d.cancelRunSends(['run-a', 'run-b'])
    expect(released).toEqual([
      [keysMod.buildCorchRunToken('run-a'), 'aaf_closure'],
      [keysMod.buildCorchRunToken('run-b'), 'aaf_closure'],
    ])
    // A throwing release never fails the others.
    deps.pipeline.releaseByToken = async () => { throw new Error('boom') }
    await d.cancelRunSends(['run-c'])
  })

  test('no deadlock: closure racing claimNext and a run end, repeated, always completes and the item ends closed', async () => {
    const u = await mkUser()
    const proj = await mkProject(u, 'github://acme/deadlock')
    for (let i = 0; i < 12; i++) {
      const it = await mkItem(u, proj, 'queued')
      const [claim, ev] = await Promise.all([
        storeMod.corchStore.claimNext(u, []),
        send({ event: i % 2 ? 'pr.failed' : 'pr.closed', repo: 'acme/deadlock', headRef: it.branch }),
      ])
      expect(ev.res.status).toBe(200)
      if (claim) {
        // The watcher's run end racing the closure must never deadlock or requeue.
        await storeMod.corchStore.endRunAndRequeue(claim.run.id, { endReason: 'no_pr', consumeAttempt: true, waitReason: null, notBefore: null })
      }
      const row = await itemRow(it.id)
      // Either the closure won (blocked) or the claim won first and the closure then blocked it: never queued/running.
      expect(['blocked']).toContain(row.status)
      expect((await h.sql`SELECT count(*)::int AS n FROM corch_runs WHERE work_item_id = ${it.id} AND ended_at IS NULL`)[0]!.n).toBe(0)
    }
  })

  test('pr.failed => blocked + exactly ONE notification, even on replay and on a second failed event', async () => {
    const u = await mkUser()
    const proj = await mkProject(u, 'github://acme/failed')
    const it = await mkItem(u, proj)
    const first = await send({ event: 'pr.failed', repo: 'acme/failed', headRef: it.branch })
    expect(await first.res.json()).toEqual({ ok: true, status: 'applied' })
    expect((await itemRow(it.id)).status).toBe('blocked')
    expect((await itemRow(it.id)).wait_reason).toBe('pr_failed')
    await send({ event: 'pr.failed', repo: 'acme/failed', headRef: it.branch, eventId: first.eventId }) // replay
    const second = await send({ event: 'pr.failed', repo: 'acme/failed', headRef: it.branch }) // new id, already blocked
    expect(await second.res.json()).toEqual({ ok: true, status: 'ignored' })
    expect((await eventRow(second.eventId)).outcome).toBe('already_blocked')
    expect(notified.filter(([, w]) => w === it.id)).toEqual([[u, it.id]])
    expect(evaluated.filter((x) => x === u).length).toBeGreaterThan(0)
  })

  test('concurrent duplicate deliveries apply one transition and one notification', async () => {
    const u = await mkUser()
    const proj = await mkProject(u, 'github://acme/race')
    const it = await mkItem(u, proj)
    const eventId = `evt-${randomUUID()}`
    const rs = await Promise.all(Array.from({ length: 6 }, () => send({ event: 'pr.failed', repo: 'acme/race', headRef: it.branch, eventId })))
    const bodies: any[] = await Promise.all(rs.map((r) => r.res.json()))
    // Exactly one delivery applied the transition. A concurrent duplicate that finds the notification still in
    // flight is a 503 (not delivered yet, the sender retries), never a second apply or a second send.
    expect(bodies.filter((j) => j.status === 'applied').length).toBe(1)
    for (const j of bodies) expect(['applied', 'duplicate', undefined]).toContain(j.status)
    expect(bodies.filter((j) => j.status === undefined).every((j) => j.error === 'notification_pending')).toBe(true)
    expect(notified.filter(([, w]) => w === it.id).length).toBe(1)
    expect(await eventCount(eventId)).toBe(1)
  })

  test('dispatch gate: only a provisioned project is claimable or counted as due (fail closed)', async () => {
    const u = await mkUser()
    const unprov = await mkProject(u, 'github://acme/unprov', 'aaf_unprovisioned')
    const itemU = await mkItem(u, unprov, 'queued')
    expect(await storeMod.corchStore.claimNext(u, [])).toBeNull()
    expect((await storeMod.corchStore.usersWithDueItems()).includes(u)).toBe(false)
    expect((await itemRow(itemU.id)).status).toBe('queued')
    await storeMod.corchStore.setProvisionResult(unprov, { status: 'provisioned', aafProjectId: 'aaf-9' })
    expect((await storeMod.corchStore.usersWithDueItems()).includes(u)).toBe(true)
    const c = await storeMod.corchStore.claimNext(u, [])
    expect(c?.item.id).toBe(itemU.id)
  })

  test('provisionExisting backfill on real Postgres is idempotent against a fake AAF', async () => {
    process.env.REMO_CORCH_AAF_URL = 'https://aaf.example.test'
    process.env.REMO_CORCH_AAF_TOKEN = 'tok-e2e'
    process.env.REMO_CORCH_AAF_INSTALLATION_ID = '77'
    const u = await mkUser()
    const pa = await mkProject(u, `github://acme/bf-${randomUUID().slice(0, 8)}`, 'aaf_unprovisioned')
    let calls = 0
    const fetch = async (_url: string, init: RequestInit) => {
      calls++
      const slug = JSON.parse(init.body as string).repo_slugs[0] as string
      return new Response(JSON.stringify({ projects: [{ repo_slug: slug, project_id: `aaf-${slug.replace('/', '-')}`, action: 'created', installation_id: 77 }] }), { status: 200 })
    }
    const mine = (s: any[]) => s.filter((p) => p.user_id === u)
    const before = mine(await storeMod.corchStore.listUnprovisionedProjects())
    expect(before.map((p) => p.id)).toEqual([pa])
    await provMod.provisionExisting(storeMod.corchStore, { fetch })
    expect(mine(await storeMod.corchStore.listUnprovisionedProjects()).length).toBe(0)
    const row = (await h.sql`SELECT * FROM corch_projects WHERE id = ${pa}`)[0]!
    expect(row.aaf_provision_status).toBe('provisioned')
    expect(String(row.aaf_project_id).startsWith('aaf-acme-bf-')).toBe(true)
    const callsAfterFirst = calls
    const second = await provMod.provisionExisting(storeMod.corchStore, { fetch })
    expect(second.total).toBe(0)
    expect(calls).toBe(callsAfterFirst) // nothing left to provision: no AAF call on the second run
    const again = (await h.sql`SELECT aaf_project_id, aaf_provision_status FROM corch_projects WHERE id = ${pa}`)[0]!
    expect(again.aaf_project_id).toBe(row.aaf_project_id)
  })

  test('provision failure and unset env leave aaf_unprovisioned on the real row', async () => {
    const u = await mkUser()
    const p = await mkProject(u, `github://acme/pf-${randomUUID().slice(0, 8)}`, 'aaf_unprovisioned')
    const project = (await storeMod.corchStore.getProject(u, p))!
    delete process.env.REMO_CORCH_AAF_URL
    const unset = await provMod.provisionProject(storeMod.corchStore, project, { fetch: async () => { throw new Error('must not be called') } })
    expect(unset.aaf_provision_status).toBe('aaf_unprovisioned')
    process.env.REMO_CORCH_AAF_URL = 'https://aaf.example.test'
    const failed = await provMod.provisionProject(storeMod.corchStore, project, { fetch: async () => new Response('', { status: 503 }) })
    expect(failed.aaf_provision_status).toBe('aaf_unprovisioned')
    expect(failed.aaf_project_id).toBeNull()
  })
})
