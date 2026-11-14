// CORCH-01 (CORCH-R1.8-R1.13, R3.4, R3.5): gates, keys, refusal schedule, request builder, and the
// dispatcher's launch/requeue behaviour with fake deps. No DB, no module mocks.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-chars-long-aaaaaaaa'

import { describe, test, expect, afterEach } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  buildCorchPipelineDeps,
  buildCorchRequest,
  refusalSchedule,
  DEFAULT_WORKSPACE,
  DEFAULT_PR_LOOKUP,
} from '../src/corch/dispatcher.ts'
import { corchProjectBudgetGate, corchConcurrencyGate, corchQuotaGate } from '../src/corch/gates.ts'
import { DEFAULT_QUOTA_PROVIDER } from '../src/corch/quota-provider.ts'
import { buildCorchKey, buildCorchRunToken, runIdFromToken } from '../src/corch/keys.ts'
import { automationKillSwitchGate, automationLifetimeCounterGate } from '../src/dispatch/automation-controls.ts'
import { dailyCostCapGate, dailyTokenCapGate, sessionInjectRateGate } from '../src/dispatch/gates.ts'

const SRC = join(import.meta.dir, '..', 'src')

const savedFlag = process.env.REMO_CORCH_ENABLED
afterEach(() => {
  if (savedFlag === undefined) delete process.env.REMO_CORCH_ENABLED
  else process.env.REMO_CORCH_ENABLED = savedFlag
})

function ctx(over: Record<string, unknown> = {}) {
  return {
    run: { id: 'r1', user_id: 'u1', project_id: 'p1', work_item_id: 'w1' },
    item: { id: 'w1' },
    project: { id: 'p1', daily_token_budget: 1000, repo_ident: 'github://a/b' },
    maxConcurrent: 1,
    tz: 'UTC',
    ...over,
  }
}

function fakeStore(over: Record<string, unknown> = {}) {
  return {
    runContext: async () => ctx(),
    liveRunsForUser: async () => 0,
    projectTokensToday: async () => 0,
    ...over,
  } as any
}

const TOKEN = buildCorchRunToken('r1')
const req = (token = TOKEN) => ({ userId: 'u1', sessionId: 's1', token, prompt: 'p' })

describe('gate list (CORCH-R1.9)', () => {
  test('buildCorchPipelineDeps gates are the exact 8, in order', () => {
    const deps = buildCorchPipelineDeps({ store: fakeStore(), quota: DEFAULT_QUOTA_PROVIDER, pipeline: {} } as any)
    expect(deps.gates.map((g) => g.name)).toEqual([
      automationKillSwitchGate.name,
      dailyCostCapGate.name,
      dailyTokenCapGate.name,
      'corch_project_budget',
      'corch_concurrency',
      'corch_quota',
      sessionInjectRateGate.name,
      automationLifetimeCounterGate.name,
    ])
  })
})

describe('corch gates', () => {
  test('corchConcurrencyGate refuses at cap (excluding own run) and passes below', async () => {
    const at = corchConcurrencyGate(fakeStore({ liveRunsForUser: async () => 1 }))
    expect(await at.check(req())).toEqual({ ok: false, reason: 'corch_concurrency' })
    const below = corchConcurrencyGate(fakeStore({ liveRunsForUser: async () => 0 }))
    expect(await below.check(req())).toEqual({ ok: true })
    const cap2 = corchConcurrencyGate(fakeStore({ runContext: async () => ctx({ maxConcurrent: 2 }), liveRunsForUser: async () => 1 }))
    expect(await cap2.check(req())).toEqual({ ok: true })
  })
  test('corchConcurrencyGate excludes the request run from the live count', async () => {
    let seen: unknown[] = []
    const g = corchConcurrencyGate(fakeStore({ liveRunsForUser: async (...a: unknown[]) => ((seen = a), 0) }))
    await g.check(req())
    expect(seen).toEqual(['u1', 'r1'])
  })
  test('corchProjectBudgetGate refuses project_budget at or over budget', async () => {
    const over = corchProjectBudgetGate(fakeStore({ projectTokensToday: async () => 1000 }))
    expect(await over.check(req())).toEqual({ ok: false, reason: 'project_budget' })
    const under = corchProjectBudgetGate(fakeStore({ projectTokensToday: async () => 999 }))
    expect(await under.check(req())).toEqual({ ok: true })
  })
  test('corchQuotaGate: default provider refuses quota_no_snapshot; ok provider passes (CORCH-R1.13)', async () => {
    const store = fakeStore()
    expect(await corchQuotaGate(DEFAULT_QUOTA_PROVIDER, store).check(req())).toEqual({ ok: false, reason: 'quota_no_snapshot' })
    const ok = { snapshotFor: async () => ({ ok: true as const, account_slot: null, supervisor_id: null }) }
    expect(await corchQuotaGate(ok, store).check(req())).toEqual({ ok: true })
  })
  test('every corch gate fails closed for a non corch-run token', async () => {
    const store = fakeStore()
    for (const g of [corchProjectBudgetGate(store), corchConcurrencyGate(store), corchQuotaGate(DEFAULT_QUOTA_PROVIDER, store)]) {
      expect(await g.check(req('heal:x'))).toEqual({ ok: false, reason: 'corch_bad_token' })
    }
  })
  test('every corch gate fails closed when the run is unknown', async () => {
    const store = fakeStore({ runContext: async () => null })
    for (const g of [corchProjectBudgetGate(store), corchConcurrencyGate(store), corchQuotaGate(DEFAULT_QUOTA_PROVIDER, store)]) {
      expect(await g.check(req())).toEqual({ ok: false, reason: 'corch_bad_token' })
    }
  })
})

describe('keys (LD-3)', () => {
  test('buildCorchKey and run token round trip', () => {
    expect(buildCorchKey('abc')).toBe('corch:abc')
    expect(runIdFromToken(buildCorchRunToken('r9'))).toBe('r9')
    expect(runIdFromToken('heal:x')).toBeNull()
    expect(runIdFromToken('corch-run:')).toBeNull()
  })
})

describe('refusalSchedule (LD-7)', () => {
  test('the gates.ts literals the map matches by prefix are pinned', () => {
    const g = readFileSync(join(SRC, 'dispatch/gates.ts'), 'utf-8')
    expect(g).toContain('`over_daily_cost_cap:')
    expect(g).toContain('`over_daily_token_cap:')
    expect(g).toContain('`over_session_inject_rate:')
  })
  test('midnight kinds', () => {
    for (const r of ['project_budget', 'over_daily_cost_cap:$10.42>=$10.00', 'over_daily_token_cap:5>=4', 'over_token_cap', 'launch_cap']) {
      expect([r, refusalSchedule(r).notBefore]).toEqual([r, 'midnight'])
    }
  })
  test('inject rate is plus_60m; autospawn_launch_ prefix is plus_lease', () => {
    expect(refusalSchedule('over_session_inject_rate:4>=4').notBefore).toBe('plus_60m')
    expect(refusalSchedule('autospawn_launch_no_supervisor').notBefore).toBe('plus_lease')
  })
  test('event-driven reasons carry no not_before', () => {
    for (const r of [
      'automation_halted:global', 'corch_concurrency', 'quota_no_snapshot', 'lifetime_inject_exhausted:1000>=1000',
      'workspace_unavailable', 'supervisor_offline', 'disabled', 'not_allowlisted', 'in_flight', 'ledger_unavailable', 'weird_unknown',
    ]) {
      expect([r, refusalSchedule(r).notBefore]).toEqual([r, null])
    }
  })
  test('end_reason normalizes automation_halted:<scope>; wait_reason keeps the full string', () => {
    expect(refusalSchedule('automation_halted:user')).toEqual({ endReason: 'automation_halted', waitReason: 'automation_halted:user', notBefore: null })
    expect(refusalSchedule('quota_no_snapshot').endReason).toBe('quota_no_snapshot')
  })
})

describe('buildCorchRequest (CORCH-R1.10)', () => {
  test('counterKey comes from the work item id, never from the caller', () => {
    const r = buildCorchRequest({
      userId: 'u1', sessionId: 's1', runId: 'r1', workItemId: 'w1', prompt: 'hi',
      counterKey: 'task:evil', token: 'evil',
    } as any)
    expect(r.counterKey).toBe('corch:w1')
    expect(r.token).toBe('corch-run:r1')
    expect(r.prompt).toBe('hi')
  })
})

describe('defaults fail closed (LD-11)', () => {
  test('workspace and pr lookup', async () => {
    expect(await DEFAULT_WORKSPACE.resolve({} as any)).toEqual({ ok: false, reason: 'workspace_unavailable' })
    expect(await DEFAULT_PR_LOOKUP.lookup({} as any)).toEqual({ kind: 'unavailable' })
  })
})

// ── dispatcher with fake deps (CORCH-R1.11, R3.4, R3.5) ──────────────────────

import { createCorchDispatcher } from '../src/corch/dispatcher.ts'

function mkWorld(opts: { attempts?: number; maxAttempts?: number; prLookup?: any; dispatchOutcome?: any } = {}) {
  const w = {
    attempts: opts.attempts ?? 0,
    maxAttempts: opts.maxAttempts ?? 3,
    status: 'running' as string,
    ended: new Set<string>(),
    ends: [] as Array<{ runId: string; input: any; result: any }>,
    prOpen: [] as string[],
    notifications: [] as any[],
    releases: [] as any[],
    reserves: [] as any[],
    gateCalls: [] as any[],
    runLog: [] as any[],
    launchCalls: 0,
    allowedChecks: [] as any[],
    running: [] as string[],
    launched: [] as any[],
    claims: 0,
    pending: 1,
    dispatched: [] as Array<{ req: any; pdeps: any }>,
    outcome: opts.dispatchOutcome ?? { kind: 'dispatched', runId: 'x' },
    gateReason: null as string | null,
    launchThrows: false,
    earliest: null as Date | null,
    setTimeouts: [] as number[],
    clearTimeouts: 0,
  }
  const claim = () => ({
    run: { id: 'run-1', user_id: 'u1', project_id: 'p1', work_item_id: 'w1' },
    item: { id: 'w1', branch: 'corch/w1', title: 't', body: 'b', source: 'manual', source_ref: 'r' },
    project: { id: 'p1', repo_ident: 'github://acme/app', daily_token_budget: 1000 },
  })
  const store: any = {
    claimNext: async () => {
      w.claims++
      return w.pending-- > 0 ? claim() : null
    },
    attachSession: async () => true,
    markRunLaunched: async (id: string, sup: string) => void w.launched.push([id, sup]),
    markRunRunning: async (id: string) => (w.running.push(id), !w.ended.has(id)),
    endRunAndRequeue: async (runId: string, input: any) => {
      let result: any
      if (w.ended.has(runId)) result = { changed: false }
      else {
        w.ended.add(runId)
        if (input.consumeAttempt) {
          w.attempts++
          w.status = w.attempts >= w.maxAttempts ? 'blocked' : 'queued'
        } else w.status = 'queued'
        result = { changed: true, workItemId: 'w1', userId: 'u1', itemStatus: w.status, attempts: w.attempts }
      }
      w.ends.push({ runId, input, result })
      return result
    },
    endRunMarkPrOpen: async (runId: string, url: string) => {
      if (w.ended.has(runId)) return { changed: false }
      w.ended.add(runId)
      w.prOpen.push(url)
      return { changed: true, workItemId: 'w1', userId: 'u1', itemStatus: 'pr_open', attempts: w.attempts }
    },
    earliestFutureNotBefore: async () => w.earliest,
    usersWithDueItems: async () => [],
    runContext: async () => null,
  }
  const launch: any = {
    tzForUser: async () => 'UTC',
    checkGates: async (...a: any[]) => (w.gateCalls.push(a), w.gateReason),
    reserve: async (a: any) => (w.reserves.push(a), { ok: true }),
    release: async (a: any) => void w.releases.push(a),
    isRepoAutospawnAllowed: async (u: string, r: string) => (w.allowedChecks.push([u, r]), true),
    supervisorOnlineForUser: async () => true,
    getTokenCapStatus: async () => ({ over: false }),
    countAutospawnLaunchesToday: async () => 0,
    isOverAutospawnDailyLaunchCap: () => false,
    graceParkPending: () => false,
    launchSessionForUser: async () => {
      w.launchCalls++
      if (w.launchThrows) throw new Error('boom')
      return { ok: true, runId: 'sup-run', supervisorId: 'sup-1' }
    },
    appendRunLog: async (row: any) => void w.runLog.push(row),
  }
  const deps: any = {
    store,
    workspace: { resolve: async () => ({ ok: true, sessionId: 's1', worktreePath: 'C:/wt/app' }) },
    launch,
    launchCommand: 'corch_test_launch',
    quota: DEFAULT_QUOTA_PROVIDER,
    pipeline: { isOnline: async () => true, send: async () => {} },
    dispatch: async (req: any, pdeps: any) => (w.dispatched.push({ req, pdeps }), w.outcome),
    prLookup: opts.prLookup ?? DEFAULT_PR_LOOKUP,
    notify: async (n: any) => void w.notifications.push(n),
    timers: {
      setTimeout: (_fn: () => void, ms: number) => (w.setTimeouts.push(ms), { id: w.setTimeouts.length }),
      clearTimeout: () => void w.clearTimeouts++,
    },
  }
  return { w, deps }
}

describe('dispatcher (CORCH-R1.11, R3.4, R3.5)', () => {
  test('governedLaunch gets the corch policy: enrollment check, launch command, preLaunch governor over the SAME gate list', async () => {
    process.env.REMO_CORCH_ENABLED = '1'
    const { w, deps } = mkWorld()
    await createCorchDispatcher(deps).evaluateUser('u1')
    expect(w.allowedChecks).toEqual([['u1', 'github://acme/app']])
    expect(w.runLog[0].command).toBe('corch_test_launch')
    expect(w.runLog[0].repo_key).toBe('github://acme/app')
    expect(w.reserves[0]).toMatchObject({ enforceRate: true, actor: 'corch', counterKey: 'corch:w1', token: 'corch-run:run-1', sessionId: 's1' })
    expect(w.gateCalls[0][0].counterKey).toBe('corch:w1')
    expect(w.gateCalls[0][1]).toBe(w.dispatched[0]!.pdeps.gates) // same list object (heal pattern)
    expect(w.launched).toEqual([['run-1', 'sup-1']])
    expect(w.running).toEqual(['run-1'])
  })

  test('flag OFF: evaluateUser never reaches the store or launch', async () => {
    delete process.env.REMO_CORCH_ENABLED
    const { w, deps } = mkWorld()
    expect(await createCorchDispatcher(deps).evaluateUser('u1')).toEqual({ kind: 'disabled' })
    expect(w.claims).toBe(0)
    expect(w.launchCalls).toBe(0)
  })

  test('refused quota_no_snapshot: no attempt, wait_reason set, no timer (event-driven)', async () => {
    process.env.REMO_CORCH_ENABLED = '1'
    const { w, deps } = mkWorld()
    w.gateReason = 'quota_no_snapshot'
    await createCorchDispatcher(deps).evaluateUser('u1')
    expect(w.ends[0]!.input).toEqual({ endReason: 'quota_no_snapshot', consumeAttempt: false, waitReason: 'quota_no_snapshot', notBefore: null })
    expect(w.attempts).toBe(0)
    expect(w.launchCalls).toBe(0)
  })

  test('refused automation_halted:global normalizes end_reason, keeps full wait_reason, no attempt', async () => {
    process.env.REMO_CORCH_ENABLED = '1'
    const { w, deps } = mkWorld()
    w.gateReason = 'automation_halted:global'
    await createCorchDispatcher(deps).evaluateUser('u1')
    expect(w.ends[0]!.input).toMatchObject({ endReason: 'automation_halted', waitReason: 'automation_halted:global', consumeAttempt: false })
    expect(w.attempts).toBe(0)
  })

  test('a daily-cost refusal schedules the next local midnight in the user tz', async () => {
    process.env.REMO_CORCH_ENABLED = '1'
    const { w, deps } = mkWorld()
    w.gateReason = 'over_daily_cost_cap:$10.42>=$10.00'
    await createCorchDispatcher(deps).evaluateUser('u1')
    expect(w.ends[0]!.input.notBefore).toEqual({ midnightTz: 'UTC' })
  })

  test('governedLaunch failed: attempt consumed with end_reason launch_failed', async () => {
    process.env.REMO_CORCH_ENABLED = '1'
    const { w, deps } = mkWorld()
    w.launchThrows = true
    await createCorchDispatcher(deps).evaluateUser('u1')
    expect(w.ends[0]!.input).toMatchObject({ endReason: 'launch_failed', consumeAttempt: true })
    expect(w.attempts).toBe(1)
    expect(w.releases.length).toBe(1) // governedLaunch released its own reservation through the closure
  })

  test('launched then dispatch skipped automation_halted:user: no attempt, reservation released once even on double delivery', async () => {
    process.env.REMO_CORCH_ENABLED = '1'
    const { w, deps } = mkWorld({ dispatchOutcome: { kind: 'skipped', reason: 'automation_halted:user' } })
    await createCorchDispatcher(deps).evaluateUser('u1')
    const first = w.ends.filter((e) => e.result.changed)
    expect(first.length).toBe(1)
    expect(first[0]!.input).toMatchObject({ endReason: 'automation_halted', consumeAttempt: false })
    // the pipeline's own markSkipped callback delivers the same transition again
    await w.dispatched[0]!.pdeps.store.markSkipped('corch-run:run-1', 'automation_halted:user')
    expect(w.attempts).toBe(0)
    expect(w.releases.length).toBe(1)
  })

  test('parked_offline then onParkExpire: spawn_timeout with an attempt and one release', async () => {
    process.env.REMO_CORCH_ENABLED = '1'
    const { w, deps } = mkWorld({ dispatchOutcome: { kind: 'parked_offline' } })
    await createCorchDispatcher(deps).evaluateUser('u1')
    expect(w.ends.length).toBe(0)
    await w.dispatched[0]!.pdeps.onParkExpire(w.dispatched[0]!.req)
    expect(w.ends[0]!.input).toMatchObject({ endReason: 'spawn_timeout', consumeAttempt: true })
    expect(w.releases.length).toBe(1)
  })

  test('dropped_busy consumes an attempt and releases', async () => {
    process.env.REMO_CORCH_ENABLED = '1'
    const { w, deps } = mkWorld({ dispatchOutcome: { kind: 'dropped_busy' } })
    await createCorchDispatcher(deps).evaluateUser('u1')
    expect(w.ends[0]!.input).toMatchObject({ endReason: 'dropped_busy', consumeAttempt: true })
    expect(w.releases.length).toBe(1)
  })

  test('onFinalize with PrLookup open => PR recorded, then evaluateUser re-triggered once', async () => {
    process.env.REMO_CORCH_ENABLED = '1'
    const { w, deps } = mkWorld({ prLookup: { lookup: async () => ({ kind: 'open', url: 'https://github.com/acme/app/pull/1' }) } })
    await createCorchDispatcher(deps).evaluateUser('u1')
    const before = w.claims
    await w.dispatched[0]!.pdeps.store.onFinalize('corch-run:run-1', 'done')
    expect(w.prOpen).toEqual(['https://github.com/acme/app/pull/1'])
    expect(w.attempts).toBe(0)
    expect(w.claims).toBe(before + 1)
  })

  test('onFinalize with PrLookup none => no_pr attempt; unavailable (default) => pr_lookup_unavailable attempt', async () => {
    process.env.REMO_CORCH_ENABLED = '1'
    for (const [lookup, reason] of [
      [{ lookup: async () => ({ kind: 'none' }) }, 'no_pr'],
      [DEFAULT_PR_LOOKUP, 'pr_lookup_unavailable'],
    ] as const) {
      const { w, deps } = mkWorld({ prLookup: lookup })
      await createCorchDispatcher(deps).evaluateUser('u1')
      const before = w.claims
      await w.dispatched[0]!.pdeps.store.onFinalize('corch-run:run-1', 'done')
      expect(w.ends.at(-1)!.input).toMatchObject({ endReason: reason, consumeAttempt: true })
      expect(w.attempts).toBe(1)
      expect(w.claims).toBe(before + 1)
    }
  })

  test('third consumed attempt blocks the item and notifies exactly once, even when delivered twice', async () => {
    process.env.REMO_CORCH_ENABLED = '1'
    const { w, deps } = mkWorld({ attempts: 2, dispatchOutcome: { kind: 'failed', reason: 'send_threw' } })
    await createCorchDispatcher(deps).evaluateUser('u1')
    await w.dispatched[0]!.pdeps.store.markFailed('corch-run:run-1', 'send_threw') // callback delivery
    expect(w.status).toBe('blocked')
    expect(w.attempts).toBe(3)
    expect(w.notifications.length).toBe(1)
    expect(w.notifications[0]).toMatchObject({ kind: 'blocked', workItemId: 'w1', repoIdent: 'github://acme/app', attempts: 3, endReason: 'dispatch_failed' })
    expect(Object.keys(w.notifications[0]).sort()).toEqual(['attempts', 'endReason', 'kind', 'repoIdent', 'sessionId', 'userId', 'workItemId'])
  })

  test('armNotBeforeTimer: one timer for the earliest future not_before (clamped), clears the previous, none when empty', async () => {
    process.env.REMO_CORCH_ENABLED = '1'
    const { w, deps } = mkWorld()
    const d = createCorchDispatcher(deps)
    w.earliest = null
    await d.armNotBeforeTimer()
    expect(w.setTimeouts).toEqual([])
    w.earliest = new Date(Date.now() + 3_600_000)
    await d.armNotBeforeTimer()
    expect(w.setTimeouts.length).toBe(1)
    expect(Math.abs(w.setTimeouts[0]! - 3_600_000)).toBeLessThan(5_000)
    w.earliest = new Date(Date.now() + 10 * 365 * 86_400_000)
    await d.armNotBeforeTimer()
    expect(w.setTimeouts.length).toBe(2)
    expect(w.setTimeouts[1]).toBe(2147483647)
    expect(w.clearTimeouts).toBe(1) // the first timer was cleared before the second was set
    w.earliest = null
    await d.armNotBeforeTimer()
    expect(w.setTimeouts.length).toBe(2)
    expect(w.clearTimeouts).toBe(2)
  })
})

// ── reconciler (CORCH-R3.3): positive-knowledge reclaim ──────────────────────

import { reconcilePass } from '../src/corch/reconciler.ts'

type Inv = { fresh: boolean; sessionIds: Set<string> }

function mkRecon(opts: { runs?: any[]; inv?: Record<string, Inv>; userInv?: Inv; online?: boolean } = {}) {
  const { w, deps } = mkWorld({ attempts: 0 })
  w.pending = 0 // follow-up evaluations must not claim anything
  const r = {
    runs: opts.runs ?? [],
    readLimits: [] as number[],
    touched: [] as string[][],
    stalledCalls: [] as string[],
    stalledSet: new Set<string>(),
    releases: [] as Array<[string, string]>,
    supervisorRuns: [] as any[],
  }
  deps.store.liveRunsPage = async (afterId: string | null, limit: number) => {
    r.readLimits.push(limit)
    return [...r.runs].sort((a, b) => (a.id < b.id ? -1 : 1)).filter((x) => afterId === null || x.id > afterId).slice(0, limit)
  }
  deps.store.touchHeartbeat = async (ids: string[]) => void r.touched.push(ids)
  deps.store.markStalled = async (id: string) => {
    r.stalledCalls.push(id)
    if (r.stalledSet.has(id)) return false
    r.stalledSet.add(id)
    return true
  }
  deps.store.liveRunsForSupervisor = async () => r.supervisorRuns
  deps.pipeline.releaseByToken = async (token: string, reason: string) => void r.releases.push([token, reason])
  deps.inventory = {
    forSupervisor: (id: string): Inv => opts.inv?.[id] ?? { fresh: false, sessionIds: new Set() },
    forUser: (): Inv => opts.userInv ?? { fresh: false, sessionIds: new Set() },
    isOnline: () => opts.online ?? false,
  }
  const d = createCorchDispatcher(deps)
  return { w, deps, r, d }
}

const LEASE = 120_000
function liveRun(over: Record<string, unknown> = {}) {
  return {
    id: 'run-1',
    work_item_id: 'w1',
    project_id: 'p1',
    user_id: 'u1',
    supervisor_id: 'sup-1',
    session_id: 's1',
    status: 'running',
    heartbeat_at: new Date(Date.now() - LEASE - 30_000),
    started_at: new Date(Date.now() - LEASE - 60_000),
    repo_ident: 'github://acme/app',
    item_attempts: 0,
    ...over,
  }
}

describe('reconciler (CORCH-R3.3)', () => {
  test('a listed session gets a heartbeat and nothing else', async () => {
    process.env.REMO_CORCH_ENABLED = '1'
    const { w, r, d, deps } = mkRecon({ runs: [liveRun()], inv: { 'sup-1': { fresh: true, sessionIds: new Set(['s1']) } } })
    await reconcilePass(deps, d)
    expect(r.touched).toEqual([['run-1']])
    expect(w.ends).toEqual([])
    expect(w.notifications).toEqual([])
  })

  test('fresh inventory lacking the session beyond the lease reclaims session_absent with an attempt', async () => {
    process.env.REMO_CORCH_ENABLED = '1'
    const { w, r, d, deps } = mkRecon({ runs: [liveRun()], inv: { 'sup-1': { fresh: true, sessionIds: new Set(['other']) } } })
    await reconcilePass(deps, d)
    expect(w.ends.map((e) => e.input)).toMatchObject([{ endReason: 'session_absent', consumeAttempt: true }])
    expect(w.attempts).toBe(1)
    expect(r.releases).toEqual([['corch-run:run-1', 'session_absent']]) // disarms the reclaimed run's pipeline hook
    expect(r.stalledCalls).toEqual([])
    expect(w.releases).toEqual([]) // the reservation is not released on reclaim (the send happened)
  })

  test('fresh and not listed but still inside the lease: nothing', async () => {
    process.env.REMO_CORCH_ENABLED = '1'
    const { w, r, d, deps } = mkRecon({
      runs: [liveRun({ heartbeat_at: new Date(Date.now() - 10_000) })],
      inv: { 'sup-1': { fresh: true, sessionIds: new Set() } },
    })
    await reconcilePass(deps, d)
    expect(w.ends).toEqual([])
    expect(r.touched.flat()).toEqual([])
    expect(r.stalledCalls).toEqual([])
  })

  test('no fresh inventory beyond the lease: stalled once and ONE notification across two passes, never reclaimed', async () => {
    process.env.REMO_CORCH_ENABLED = '1'
    const { w, r, d, deps } = mkRecon({ runs: [liveRun()] }) // inventory unknown for sup-1
    await reconcilePass(deps, d)
    await reconcilePass(deps, d)
    expect(r.stalledCalls).toEqual(['run-1', 'run-1'])
    expect(w.notifications.length).toBe(1)
    expect(w.notifications[0]).toMatchObject({ kind: 'stalled', workItemId: 'w1', repoIdent: 'github://acme/app', endReason: 'no_fresh_inventory' })
    expect(w.ends).toEqual([]) // unknown is never "gone"
  })

  test('a stalled run that is listed again is heartbeated (store flips it back to running)', async () => {
    process.env.REMO_CORCH_ENABLED = '1'
    const { r, d, deps } = mkRecon({ runs: [liveRun({ status: 'stalled' })], inv: { 'sup-1': { fresh: true, sessionIds: new Set(['s1']) } } })
    await reconcilePass(deps, d)
    expect(r.touched).toEqual([['run-1']])
  })

  test('without a supervisor id another supervisor inventory is never proof of absence (stalled, not reclaimed)', async () => {
    process.env.REMO_CORCH_ENABLED = '1'
    const { w, r, d, deps } = mkRecon({ runs: [liveRun({ supervisor_id: null })], userInv: { fresh: true, sessionIds: new Set(['x']) } })
    await reconcilePass(deps, d)
    expect(w.ends).toEqual([])
    expect(r.stalledCalls).toEqual(['run-1'])
  })

  test('without a supervisor id a fresh inventory that LISTS the session is positive proof of life', async () => {
    process.env.REMO_CORCH_ENABLED = '1'
    const { w, r, d, deps } = mkRecon({ runs: [liveRun({ supervisor_id: null })], userInv: { fresh: true, sessionIds: new Set(['s1']) } })
    await reconcilePass(deps, d)
    expect(r.touched).toEqual([['run-1']])
    expect(w.ends).toEqual([])
  })

  test('no session id, not in flight, older than the lease: claim_orphaned consumes an attempt (bounded, QC MED 2)', async () => {
    process.env.REMO_CORCH_ENABLED = '1'
    const { w, d, deps } = mkRecon({ runs: [liveRun({ session_id: null, supervisor_id: null })] })
    await reconcilePass(deps, d)
    expect(w.ends.map((e) => e.input)).toMatchObject([{ endReason: 'claim_orphaned', consumeAttempt: true }])
    expect(w.attempts).toBe(1)
  })

  test('runs of this process in-flight launches are skipped', async () => {
    process.env.REMO_CORCH_ENABLED = '1'
    const { w, d, deps } = mkRecon({ runs: [liveRun({ session_id: null, supervisor_id: null })] })
    d.inFlight.add('w1')
    await reconcilePass(deps, d)
    expect(w.ends).toEqual([])
  })

  test('reads at most 100 runs per pass', async () => {
    process.env.REMO_CORCH_ENABLED = '1'
    const { r, d, deps } = mkRecon()
    await reconcilePass(deps, d)
    expect(r.readLimits).toEqual([100])
  })

  test('an overlapping pass is skipped', async () => {
    process.env.REMO_CORCH_ENABLED = '1'
    const { r, d, deps } = mkRecon()
    let release!: () => void
    const gate = new Promise<void>((res) => (release = res))
    deps.store.liveRunsPage = async (_afterId: string | null, limit: number) => {
      r.readLimits.push(limit)
      await gate
      return []
    }
    const first = reconcilePass(deps, d)
    await reconcilePass(deps, d) // returns immediately: the first pass is still running
    release()
    await first
    expect(r.readLimits).toEqual([100])
    await reconcilePass(deps, d) // and the guard is released afterwards
    expect(r.readLimits).toEqual([100, 100])
  })

  test('supervisor socket close seen by this process reclaims its live runs (supervisor_closed, attempt)', async () => {
    process.env.REMO_CORCH_ENABLED = '1'
    const { w, r, d } = mkRecon({ online: false })
    r.supervisorRuns = [liveRun()]
    await d.onSupervisorClosed('sup-1')
    expect(w.ends.map((e) => e.input)).toMatchObject([{ endReason: 'supervisor_closed', consumeAttempt: true }])
    expect(w.attempts).toBe(1)
  })

  test('a close that a reconnect already replaced reclaims nothing', async () => {
    process.env.REMO_CORCH_ENABLED = '1'
    const { w, r, d } = mkRecon({ online: true })
    r.supervisorRuns = [liveRun()]
    await d.onSupervisorClosed('sup-1')
    expect(w.ends).toEqual([])
  })
})

// ── QC round 1 (Codex 1-6, Claude MED 1/2) ───────────────────────────────────

describe('QC round 1 - C1: an ended run never sends', () => {
  const live = (ended: Date | null) => async () => ({ ...ctx(), run: { id: 'run-1', user_id: 'u1', project_id: 'p1', work_item_id: 'w1', ended_at: ended } })

  test('all three corch gates refuse an ended run (corch_run_not_live)', async () => {
    const store = fakeStore({ runContext: live(new Date()) })
    for (const g of [corchProjectBudgetGate(store), corchConcurrencyGate(store), corchQuotaGate({ snapshotFor: async () => ({ ok: true }) } as any, store)]) {
      expect(await g.check(req())).toEqual({ ok: false, reason: 'corch_run_not_live' })
    }
  })

  test('a parked replay after the run ended does not call dispatch; while live it does', async () => {
    process.env.REMO_CORCH_ENABLED = '1'
    const { w, deps } = mkWorld({ dispatchOutcome: { kind: 'parked_offline' } })
    let endedAt: Date | null = null
    deps.store.runContext = async () => (await live(endedAt)())
    await createCorchDispatcher(deps).evaluateUser('u1')
    const { req: r0, pdeps } = w.dispatched[0]!
    await pdeps.replay(r0)
    expect(w.dispatched.length).toBe(2) // live: replay re-enters dispatch
    endedAt = new Date()
    w.ended.add('run-1')
    await pdeps.replay(r0)
    expect(w.dispatched.length).toBe(2) // ended: nothing
  })

  test('markDispatched (called right before the send) throws for an ended run so the pipeline never sends', async () => {
    process.env.REMO_CORCH_ENABLED = '1'
    const { w, deps } = mkWorld()
    await createCorchDispatcher(deps).evaluateUser('u1')
    const store = w.dispatched[0]!.pdeps.store
    await store.markDispatched('corch-run:run-1') // live: fine
    w.ended.add('run-1')
    await expect(store.markDispatched('corch-run:run-1')).rejects.toThrow('corch_run_not_live')
  })
})

describe('QC round 1 - C3: not_before rearm is race-safe', () => {
  test('an older, slower query that returns null cannot cancel the timer a newer query armed', async () => {
    process.env.REMO_CORCH_ENABLED = '1'
    const { w, deps } = mkWorld()
    const d = createCorchDispatcher(deps)
    const FUTURE = new Date(Date.now() + 3_600_000)
    let n = 0
    let releaseFirst!: () => void
    deps.store.earliestFutureNotBefore = async () => {
      if (++n === 1) {
        await new Promise<void>((res) => (releaseFirst = res))
        return null
      }
      return FUTURE
    }
    const p1 = d.armNotBeforeTimer()
    const p2 = d.armNotBeforeTimer()
    await new Promise((r) => setTimeout(r, 5))
    releaseFirst()
    await Promise.all([p1, p2])
    expect(w.setTimeouts.length - w.clearTimeouts).toBe(1) // exactly one armed timer remains
  })
})

describe('QC round 1 - C4: the reconciler does not starve behind unknown-inventory runs', () => {
  test('150 stalled-forever runs: two passes touch all 150, not the same 100 twice (the short page resets the cursor)', async () => {
    process.env.REMO_CORCH_ENABLED = '1'
    const runs = Array.from({ length: 150 }, (_, i) =>
      liveRun({ id: `run-${String(i).padStart(3, '0')}`, work_item_id: `w${i}`, supervisor_id: 'sup-x' }),
    )
    const { r, d, deps } = mkRecon({ runs }) // sup-x inventory unknown: every run is stalled, heartbeat unchanged
    await reconcilePass(deps, d)
    await reconcilePass(deps, d)
    expect(new Set(r.stalledCalls).size).toBe(150)
    expect(r.readLimits).toEqual([100, 100])
  })
})

describe('QC round 1 - C5: session_busy consumes an attempt', () => {
  test('the real pipeline order (markSkipped session_busy, THEN return dropped_busy) is one attempt-consuming end, no hot loop', async () => {
    process.env.REMO_CORCH_ENABLED = '1'
    const { w, deps } = mkWorld()
    deps.dispatch = async (req: any, pdeps: any) => {
      w.dispatched.push({ req, pdeps })
      await pdeps.store.markSkipped(req.token, 'session_busy')
      return { kind: 'dropped_busy' }
    }
    await createCorchDispatcher(deps).evaluateUser('u1')
    expect(w.ends.filter((e) => e.result.changed).map((e) => e.input)).toMatchObject([{ endReason: 'dropped_busy', consumeAttempt: true }])
    expect(w.attempts).toBe(1)
    expect(w.releases.length).toBe(1)
  })
})

describe('QC round 1 - C6: boot evaluates already-due backlog once', () => {
  test('startCorchWith evaluates due users once (event-driven) and arms the timer', async () => {
    process.env.REMO_CORCH_ENABLED = '1'
    const { startCorchWith } = await import('../src/corch/reconciler.ts')
    const { w, deps } = mkWorld()
    deps.store.usersWithDueItems = async () => ['u1']
    const d = createCorchDispatcher(deps)
    const stop = await startCorchWith(d)
    stop()
    expect(w.claims).toBeGreaterThanOrEqual(1) // the due item was claimed at boot without any other trigger
  })

  test('flag OFF: startCorchWith touches nothing', async () => {
    delete process.env.REMO_CORCH_ENABLED
    const { startCorchWith } = await import('../src/corch/reconciler.ts')
    const { w, deps } = mkWorld()
    deps.store.usersWithDueItems = async () => ['u1']
    const stop = await startCorchWith(createCorchDispatcher(deps))
    stop()
    expect(w.claims).toBe(0)
  })
})

describe('QC round 1 - Claude MED 1: a throw in launch never leaves a live run', () => {
  test('a throwing gate store (checkGates rejects): run ended as failure, evaluateUser resolves, timer re-armed', async () => {
    process.env.REMO_CORCH_ENABLED = '1'
    const { w, deps } = mkWorld()
    deps.launch.checkGates = async () => {
      throw new Error('db down')
    }
    const d = createCorchDispatcher(deps)
    const r = await d.evaluateUser('u1')
    expect(r.kind).toBe('done')
    expect(w.ends.map((e) => e.input)).toMatchObject([{ endReason: 'launch_error', consumeAttempt: true }])
    expect(w.attempts).toBe(1)
  })

  test('markRunLaunched throwing: run ended as failure with the reservation released, nothing dispatched', async () => {
    process.env.REMO_CORCH_ENABLED = '1'
    const { w, deps } = mkWorld()
    deps.store.markRunLaunched = async () => {
      throw new Error('db down')
    }
    await createCorchDispatcher(deps).evaluateUser('u1')
    expect(w.ends.map((e) => e.input)).toMatchObject([{ endReason: 'launch_error', consumeAttempt: true }])
    expect(w.dispatched.length).toBe(0)
    expect(w.releases.length).toBe(1)
  })
})

describe('QC round 1 - Claude MED 2: workspace/orphan failures are bounded', () => {
  test('workspace.resolve throwing consumes an attempt; the third blocks with ONE notification', async () => {
    process.env.REMO_CORCH_ENABLED = '1'
    const { w, deps } = mkWorld({ attempts: 2 })
    deps.workspace = {
      resolve: async () => {
        throw new Error('worktree boom')
      },
    }
    const d = createCorchDispatcher(deps)
    await d.evaluateUser('u1')
    expect(w.ends.map((e) => e.input)).toMatchObject([{ endReason: 'workspace_error', consumeAttempt: true }])
    expect(w.status).toBe('blocked')
    expect(w.notifications.length).toBe(1)
    expect(w.launchCalls).toBe(0)
  })

  test('claim_orphaned at the last attempt blocks with ONE notification', async () => {
    process.env.REMO_CORCH_ENABLED = '1'
    const { w, d, deps } = mkRecon({ runs: [liveRun({ session_id: null, supervisor_id: null })] })
    w.attempts = 2
    await reconcilePass(deps, d)
    expect(w.status).toBe('blocked')
    expect(w.notifications.length).toBe(1)
  })
})
