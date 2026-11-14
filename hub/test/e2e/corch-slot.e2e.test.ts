// CORCH-09 e2e on real Postgres. Skips only when REMO_E2E_DB_URL is unset.
// A fake SLOT SUPERVISOR (replies to the corch.* RPCs) and a fake memlog drive the REAL dispatcher, the REAL
// (non-default) Workspace and PrLookup and the real corch store: claim -> memlog -> worktree -> launch ->
// turn end -> PR lookup -> done release.
import { describe, test, expect, beforeAll, beforeEach, afterEach, afterAll } from 'bun:test'
import { randomUUID } from 'node:crypto'

const HAS_TEST_DB = !!process.env.REMO_E2E_DB_URL
const maybe = HAS_TEST_DB ? describe : describe.skip

maybe('CORCH-09 e2e - slot worktree, memlog claim and PR lookup on real Postgres', () => {
  let harness: typeof import('./orchestrator-harness.ts')
  let h: import('./orchestrator-harness.ts').Harness
  let storeMod: typeof import('../../src/corch/store.ts')
  let dispMod: typeof import('../../src/corch/dispatcher.ts')
  let recMod: typeof import('../../src/corch/reconciler.ts')
  let autoMod: typeof import('../../src/heal/autospawn-deps.ts')
  let wsMod: typeof import('../../src/corch/workspace.ts')
  let memMod: typeof import('../../src/corch/memlog.ts')
  let rowsMod: typeof import('../../src/db/orchestrator-rows-dal.ts')
  const users: string[] = []
  const saved = process.env.REMO_CORCH_ENABLED
  const ROOT = '/data/repos'

  beforeAll(async () => {
    process.env.DATABASE_URL = process.env.REMO_E2E_DB_URL!
    harness = await import('./orchestrator-harness.ts')
    h = await harness.setupHarness()
    storeMod = await import('../../src/corch/store.ts')
    dispMod = await import('../../src/corch/dispatcher.ts')
    recMod = await import('../../src/corch/reconciler.ts')
    autoMod = await import('../../src/heal/autospawn-deps.ts')
    wsMod = await import('../../src/corch/workspace.ts')
    memMod = await import('../../src/corch/memlog.ts')
    rowsMod = await import('../../src/db/orchestrator-rows-dal.ts')
  }, 60_000)

  beforeEach(() => {
    process.env.REMO_CORCH_ENABLED = '1'
  })
  afterEach(async () => {
    if (users.length > 0) {
      await h.sql`UPDATE corch_runs SET status = 'ended', end_reason = 'test_cleanup', ended_at = now()
                  WHERE ended_at IS NULL AND user_id = ANY(${users})`
    }
  })
  afterAll(async () => {
    if (saved === undefined) delete process.env.REMO_CORCH_ENABLED
    else process.env.REMO_CORCH_ENABLED = saved
    if (h) {
      await h.sql`DELETE FROM automation_inject_ledger WHERE user_id = ANY(${users})`
      await h.sql`DELETE FROM users WHERE id = ANY(${users})`
      await harness.teardownHarness(h)
    }
  })

  async function mkUser(): Promise<string> {
    const r = await h.sql<{ id: string }[]>`
      INSERT INTO users (email, password_hash, role, corch_max_concurrent_runs)
      VALUES (${`e2e-corch09-${randomUUID()}@invalid.local`}, 'x', 'user', 3) RETURNING id`
    users.push(r[0]!.id)
    return r[0]!.id
  }
  async function mkProject(userId: string, repo: string): Promise<string> {
    const r = await h.sql<{ id: string }[]>`
      INSERT INTO corch_projects (user_id, repo_ident, daily_token_budget, aaf_provision_status)
      VALUES (${userId}, ${repo}, 2000000, 'provisioned') RETURNING id`
    return r[0]!.id
  }
  const enq = (userId: string, projectId: string, ref: string) =>
    storeMod.corchStore.enqueueWorkItem({ userId, projectId, source: 'manual', sourceRef: ref, title: 't', body: 'b', priority: 0 })
  const itemRow = async (id: string) => (await h.sql`SELECT * FROM corch_work_items WHERE id = ${id}`)[0]!
  const runRows = async (itemId: string) => h.sql`SELECT * FROM corch_runs WHERE work_item_id = ${itemId} ORDER BY started_at ASC`

  function world(o: { claim?: import('../../src/corch/memlog.ts').MemlogClaimResult; memlog?: import('../../src/corch/memlog.ts').MemlogClient; prUrl?: string | null | 'fail'; attachFails?: boolean; ensureError?: string } = {}) {
    const w = {
      events: [] as string[],
      frames: [] as Array<{ command: string; args: string[]; supervisorId: string }>,
      launches: [] as any[],
      dispatches: [] as Array<{ req: any; pdeps: any }>,
      tickets: [] as string[],
      sessions: [] as Array<{ hostname: string; path: string }>,
      inv: { fresh: false, ids: new Set<string>() },
    }
    const memlog: import('../../src/corch/memlog.ts').MemlogClient = o.memlog ?? {
      claim: async (i) => (w.events.push(`memlog.claim ${i.session} ${i.branch}`), o.claim ?? { ok: true }),
      heartbeat: async (i) => (w.events.push(`memlog.heartbeat ${i.session}`), true),
      release: async (i) => (w.events.push(`memlog.release ${i.session} ${i.status}`), true),
    }
    const quota: any = {
      // Like the real provider: records the chosen account on the run (idempotent) and names the slot supervisor.
      snapshotFor: async (a: { runId?: string }) => {
        if (a.runId) await h.sql`UPDATE corch_runs SET account_slot = 'acct-1' WHERE id = ${a.runId} AND account_slot IS NULL`
        return { ok: true, account_slot: 'acct-1', supervisor_id: 'slot-sup-1' }
      },
      supervisorFor: async () => 'slot-sup-1',
      supervisorAccountSlot: async () => 'acct-1',
    }
    const wsDeps: import('../../src/corch/workspace.ts').WorkspaceDeps = {
      quota,
      memlog,
      store: storeMod.corchStore,
      // The fake SLOT SUPERVISOR: answers the three allowlisted corch.* RPCs.
      runCommand: async (supervisorId, _u, command, args) => {
        w.events.push(`frame ${command}`)
        w.frames.push({ command, args, supervisorId })
        if (command === 'corch.worktree_ensure' && o.ensureError) return { exit_code: 1, error: o.ensureError }
        if (command === 'corch.worktree_ensure') {
          const name = args[0]!.split('/').pop()!
          return { exit_code: 0, snippet: JSON.stringify({ path: `${ROOT}/corch/${name}-${args[1]}`, branch: `corch/${args[1]}` }) }
        }
        if (command === 'corch.pr_lookup') {
          return o.prUrl === 'fail' ? { exit_code: 1, error: 'gh_pr_list_failed' } : { exit_code: 0, snippet: JSON.stringify({ pr_url: o.prUrl ?? null }) }
        }
        return { exit_code: 0, snippet: JSON.stringify({ removed: true }) }
      },
      halt: async (userId) => {
        const { haltBeforeMachineSend } = await import('../../src/dispatch/automation-controls.ts')
        const r = await haltBeforeMachineSend({ userId })
        return r.ok ? { ok: true } : { ok: false, reason: r.reason }
      },
      supervisor: () => ({ hostname: 'slot-host', root: ROOT }),
      ensureSession: async ({ userId, worktreePath, hostname }) => {
        w.sessions.push({ hostname, path: worktreePath })
        const existing = await h.sql<{ id: string }[]>`SELECT id FROM sessions WHERE user_id = ${userId} AND project_dir = ${worktreePath} AND deleted_at IS NULL LIMIT 1`
        if (existing[0]) return existing[0].id
        const r = await h.sql<{ id: string }[]>`
          INSERT INTO sessions (user_id, name, project_dir, token_hash, hostname)
          VALUES (${userId}, 'corch-slot-e2e', ${worktreePath}, ${'th-' + randomUUID()}, ${hostname}) RETURNING id`
        return r[0]!.id
      },
      ticket: (fp) => void w.tickets.push(fp),
    }
    const workspace = wsMod.createWorkspace(wsDeps)
    const deps: any = {
      store: o.attachFails ? { ...storeMod.corchStore, attachSession: async () => { throw new Error('attach exploded') } } : storeMod.corchStore,
      workspace,
      launch: {
        ...autoMod.REAL_AUTOSPAWN,
        isRepoAutospawnAllowed: (u: string, r: string) => storeMod.corchStore.isEnrolledEnabled(u, r),
        supervisorOnlineForUser: async () => true,
        launchSessionForUser: async (a: any) => {
          w.events.push('launch')
          w.launches.push(a)
          return { ok: true, runId: `sup-run-${w.launches.length}`, supervisorId: 'slot-sup-1' }
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

  test('full path: memlog claim -> worktree -> launch -> turn end -> PR lookup -> pr_open -> done releases', async () => {
    const userId = await mkUser()
    const projectId = await mkProject(userId, 'github://acme/app')
    const a = await enq(userId, projectId, 'full-1')
    const { w, deps, d } = world({ prUrl: 'https://github.com/acme/app/pull/12' })
    await d.evaluateUser(userId)

    const itemId = a.item.id
    // claim strictly before the first corch.* frame, worktree before launch
    expect(w.events.slice(0, 4)).toEqual([`memlog.claim corch:${itemId} corch/${itemId}`, 'frame corch.worktree_ensure', 'launch', w.events[3]!])
    expect(w.frames[0]).toEqual({ command: 'corch.worktree_ensure', args: ['github://acme/app', itemId], supervisorId: 'slot-sup-1' })
    expect(w.sessions).toEqual([{ hostname: 'slot-host', path: `${ROOT}/corch/app-${itemId}` }])
    expect(w.launches.length).toBe(1)
    expect(w.dispatches.length).toBe(1)

    const [run] = await runRows(itemId)
    expect(run!.worktree_path).toBe(`${ROOT}/corch/app-${itemId}`)
    expect(run!.supervisor_id).toBe('slot-sup-1')
    expect((await itemRow(itemId)).status).toBe('running')

    // heartbeat: the reconciler sees the session alive and heartbeats the memlog claim
    w.inv = { fresh: true, ids: new Set([run!.session_id as string]) }
    await recMod.reconcilePass(deps, d)
    expect(w.events).toContain(`memlog.heartbeat corch:${itemId}`)

    // turn end -> the REAL PrLookup asks the run's own slot supervisor
    await w.dispatches[0]!.pdeps.store.onFinalize(`corch-run:${run!.id}`, 'done')
    expect(w.frames.at(-1)).toEqual({ command: 'corch.pr_lookup', args: [`${ROOT}/corch/app-${itemId}`, `corch/${itemId}`, 'github://acme/app'], supervisorId: 'slot-sup-1' })
    const after = await itemRow(itemId)
    expect(after.status).toBe('pr_open')
    expect(after.pr_url).toBe('https://github.com/acme/app/pull/12')

    // AAF merged -> done: worktree removed then the claim released
    await d.releaseItem(userId, itemId, 'done')
    const tail = w.events.slice(-2)
    expect(tail).toEqual(['frame corch.worktree_remove', `memlog.release corch:${itemId} DONE`])
  })

  test('no open PR at turn end => requeued per R3.4 (attempt consumed), lookup frame sent', async () => {
    const userId = await mkUser()
    const projectId = await mkProject(userId, 'github://acme/nopr')
    const a = await enq(userId, projectId, 'nopr-1')
    const { w, d } = world({ prUrl: null })
    await d.evaluateUser(userId)
    const [run] = await runRows(a.item.id)
    await w.dispatches[0]!.pdeps.store.onFinalize(`corch-run:${run!.id}`, 'done')
    const it = await itemRow(a.item.id)
    expect(it.status).toBe('queued')
    expect(it.attempts).toBe(1)
    expect(w.frames.some((f) => f.command === 'corch.pr_lookup')).toBe(true)
  })

  test('memlog conflict: item waits memlog_conflict, no worktree frame, no launch, no attempt', async () => {
    const userId = await mkUser()
    const projectId = await mkProject(userId, 'github://acme/conflict')
    const a = await enq(userId, projectId, 'conflict-1')
    const { w, d } = world({ claim: { ok: false, reason: 'memlog_conflict' } })
    await d.evaluateUser(userId)
    expect(w.frames.length).toBe(0)
    expect(w.launches.length).toBe(0)
    const it = await itemRow(a.item.id)
    expect(it.status).toBe('queued')
    expect(it.wait_reason).toBe('memlog_conflict')
    expect(it.attempts).toBe(0)
  })

  test('default (refusing) memlog: waits memlog_unavailable, nothing dispatches without a claim, ONE ticket', async () => {
    const userId = await mkUser()
    const projectId = await mkProject(userId, 'github://acme/nomemlog')
    const a1 = await enq(userId, projectId, 'nm-1')
    const a2 = await enq(userId, projectId, 'nm-2')
    const { w, d } = world({ memlog: memMod.DEFAULT_MEMLOG })
    await d.evaluateUser(userId)
    expect(w.frames.length).toBe(0)
    expect(w.launches.length).toBe(0)
    expect(w.dispatches.length).toBe(0)
    for (const it of [a1.item, a2.item]) {
      const row = await itemRow(it.id)
      expect(row.status).toBe('queued')
      expect(row.wait_reason).toBe('memlog_unavailable')
      expect(row.attempts).toBe(0)
    }
    expect(w.tickets).toEqual(['corch.memlog_unavailable'])
  })

  test('a requeue after a run that had a worktree releases the claim (no live run left to heartbeat it); pr_open items are heartbeated', async () => {
    const userId = await mkUser()
    const projectId = await mkProject(userId, 'github://acme/requeue')
    const a = await enq(userId, projectId, 'rq-1')
    const { w, deps, d } = world({ prUrl: null })
    await d.evaluateUser(userId)
    const [run] = await runRows(a.item.id)
    await w.dispatches[0]!.pdeps.store.onFinalize(`corch-run:${run!.id}`, 'done') // no PR -> requeued (attempt 1 of 3)
    expect((await itemRow(a.item.id)).status).toBe('queued')
    expect(w.events.filter((e) => e === `memlog.release corch:${a.item.id} DONE`).length).toBe(1)
    expect(w.frames.some((f) => f.command === 'corch.worktree_remove')).toBe(false) // worktree kept

    // pr_open: the claim is kept and heartbeated by the reconciler although the run has ended
    await h.sql`UPDATE corch_work_items SET status = 'pr_open', pr_url = 'https://github.com/acme/requeue/pull/1' WHERE id = ${a.item.id}`
    w.events.length = 0
    await recMod.reconcilePass(deps, d)
    expect(w.events).toContain(`memlog.heartbeat corch:${a.item.id}`)
    await h.sql`UPDATE corch_work_items SET status = 'done' WHERE id = ${a.item.id}`
  })

  test('applyGsdcBoards reports the queued items it cancels (their kept worktree is then removed)', async () => {
    const userId = await mkUser()
    const projectId = await mkProject(userId, 'github://acme/gsdc')
    const a = await storeMod.corchStore.enqueueWorkItem({ userId, projectId, source: 'gsd_console', sourceRef: 'phase-1', title: 't', body: 'b', priority: 0 })
    const cancelled: Array<{ userId: string; itemId: string }> = []
    await storeMod.corchStore.applyGsdcBoards([{ userId, projectId, doneRefs: ['phase-1'], candidate: null, priority: 0 } as any], () => true, cancelled)
    expect(cancelled).toEqual([{ userId, itemId: a.item.id }])
    expect((await itemRow(a.item.id)).status).toBe('cancelled')
    // the dispatcher hook removes the worktree and releases the claim for a cancelled item
    const { w, d } = world()
    await d.releaseItem(userId, a.item.id, 'cancelled')
    expect(w.events.length).toBe(0) // no run existed for it: nothing to remove or release
  })

  test('QC2: an attachSession failure after a successful claim still releases the claim', async () => {
    const userId = await mkUser()
    const projectId = await mkProject(userId, 'github://acme/attach')
    const a = await enq(userId, projectId, 'attach-1')
    const { w, d } = world({ attachFails: true })
    await d.evaluateUser(userId)
    expect(w.launches.length).toBe(0)
    expect(w.events.filter((e) => e === `memlog.release corch:${a.item.id} DONE`).length).toBe(1)
  })

  test('QC2: a stale run cleanup never releases a NEWER run\'s claim (fenced per item)', async () => {
    const userId = await mkUser()
    const projectId = await mkProject(userId, 'github://acme/fence')
    const a = await enq(userId, projectId, 'fence-1')
    const { w, d } = world({ prUrl: null })
    await d.evaluateUser(userId)
    const [run1] = await runRows(a.item.id)
    await w.dispatches[0]!.pdeps.store.onFinalize(`corch-run:${run1!.id}`, 'done') // no PR -> requeued, claim released once
    await h.sql`UPDATE corch_work_items SET not_before = NULL WHERE id = ${a.item.id}`
    await d.evaluateUser(userId) // run 2 re-claims
    const claims = () => w.events.filter((e) => e.startsWith('memlog.claim')).length
    const releases = () => w.events.filter((e) => e.startsWith('memlog.release')).length
    expect(claims()).toBe(2)
    expect(releases()).toBe(1)
    await d.releaseIfClaimed(run1!.id, userId, a.item.id) // the OLD run's late cleanup
    expect(releases()).toBe(1) // the newer claim was not released
  })

  test('QC2: a worktree RPC timeout never releases the claim, even when the item is then blocked', async () => {
    const userId = await mkUser()
    const projectId = await mkProject(userId, 'github://acme/timeout')
    const a = await enq(userId, projectId, 'to-1')
    await h.sql`UPDATE corch_work_items SET max_attempts = 1 WHERE id = ${a.item.id}`
    const { w, d } = world({ ensureError: 'supervisor_timeout' })
    await d.evaluateUser(userId)
    expect((await itemRow(a.item.id)).status).toBe('blocked')
    expect(w.events.some((e) => e.startsWith('memlog.release'))).toBe(false)
    expect(w.launches.length).toBe(0)
    // QC3: a later cancellation must not bypass the fence either (no claim release, no worktree removal)
    await d.releaseItem(userId, a.item.id, 'cancelled')
    expect(w.events.some((e) => e.startsWith('memlog.release') || e.includes('worktree_remove'))).toBe(false)
  })

  test('blocked item releases the claim but keeps the worktree', async () => {
    const userId = await mkUser()
    const projectId = await mkProject(userId, 'github://acme/blocked')
    const a = await enq(userId, projectId, 'blocked-1')
    const { w, d } = world({ prUrl: 'fail' })
    await h.sql`UPDATE corch_work_items SET max_attempts = 1 WHERE id = ${a.item.id}`
    await d.evaluateUser(userId)
    const [run] = await runRows(a.item.id)
    await w.dispatches[0]!.pdeps.store.onFinalize(`corch-run:${run!.id}`, 'done')
    expect((await itemRow(a.item.id)).status).toBe('blocked')
    expect(w.events.some((e) => e === `memlog.release corch:${a.item.id} DONE`)).toBe(true)
    expect(w.frames.some((f) => f.command === 'corch.worktree_remove')).toBe(false)
  })
})
