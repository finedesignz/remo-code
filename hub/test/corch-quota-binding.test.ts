// CORCH-02 QC F5: the selected quota account is bound to the launch. The corch launch targets exactly the
// supervisor advertising the run's account_slot; with no binding the item is refused `quota:supervisor_unbound`
// (no attempt consumed). Fakes only: no DB.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-chars-long-aaaaaaaa'

import { describe, test, expect, afterEach } from 'bun:test'
import { createCorchDispatcher } from '../src/corch/dispatcher.ts'
import { governedLaunch } from '../src/dispatch/governed-launch.ts'

const savedFlag = process.env.REMO_CORCH_ENABLED
afterEach(() => {
  if (savedFlag === undefined) delete process.env.REMO_CORCH_ENABLED
  else process.env.REMO_CORCH_ENABLED = savedFlag
})

function world(opts: { accountSlot: string | null; supervisorFor?: (u: string, a: string) => Promise<string | null> }) {
  const ends: any[] = []
  const launches: any[] = []
  const dispatched: any[] = []
  let pending = 1
  const store: any = {
    claimNext: async () =>
      pending-- > 0
        ? {
            run: { id: 'run-1', user_id: 'u1', project_id: 'p1', work_item_id: 'w1' },
            item: { id: 'w1', branch: 'corch/w1', title: 't', body: 'b', source: 'manual', source_ref: 'r' },
            project: { id: 'p1', repo_ident: 'github://acme/app', daily_token_budget: 1000 },
          }
        : null,
    attachSession: async () => true,
    markRunLaunched: async () => {},
    markRunRunning: async () => true,
    endRunAndRequeue: async (_id: string, input: any) => (ends.push(input), { changed: true, workItemId: 'w1', userId: 'u1', itemStatus: 'queued', attempts: 0 }),
    endRunMarkPrOpen: async () => ({ changed: true }),
    earliestFutureNotBefore: async () => null,
    usersWithDueItems: async () => [],
    runContext: async () => ({ run: { id: 'run-1', user_id: 'u1', account_slot: opts.accountSlot, ended_at: null } }),
  }
  const launch: any = {
    tzForUser: async () => 'UTC', checkGates: async () => null, reserve: async () => ({ ok: true }), release: async () => {},
    isRepoAutospawnAllowed: async () => true, supervisorOnlineForUser: async () => true, getTokenCapStatus: async () => ({ over: false }),
    countAutospawnLaunchesToday: async () => 0, isOverAutospawnDailyLaunchCap: () => false, graceParkPending: () => false,
    launchSessionForUser: async (a: any) => (launches.push(a), { ok: true, runId: 'sup-run', supervisorId: a.targetSupervisorId ?? 'sup-default' }),
    appendRunLog: async () => {},
  }
  const quota: any = {
    snapshotFor: async () => ({ ok: true, account_slot: opts.accountSlot, supervisor_id: null }),
    earliestEligibleAt: async () => null,
    supervisorFor: opts.supervisorFor,
  }
  const deps: any = {
    store, workspace: { resolve: async () => ({ ok: true, sessionId: 's1', worktreePath: 'C:/wt/app' }) }, launch,
    launchCommand: 'corch_test_launch', quota, pipeline: { isOnline: async () => true, send: async () => {} },
    dispatch: async (req: any, pdeps: any) => (dispatched.push({ req, pdeps }), { kind: 'dispatched', runId: 'x' }),
    prLookup: { lookup: async () => ({ kind: 'none' }) }, notify: async () => {}, timers: { setTimeout: () => ({}), clearTimeout: () => {} },
  }
  return { ends, launches, dispatched, deps }
}

const SUPS: Record<string, string> = { acct_a: 'sup-A', acct_b: 'sup-B' }
const lookup = async (_u: string, a: string) => SUPS[a] ?? null

describe('CORCH-02 QC F5: account bound to the launch supervisor', () => {
  test('selected account A launches only on A supervisor; selected B only on B (two-supervisor mismatch cannot happen)', async () => {
    process.env.REMO_CORCH_ENABLED = '1'
    for (const [acct, sup] of [['acct_a', 'sup-A'], ['acct_b', 'sup-B']] as const) {
      const w = world({ accountSlot: acct, supervisorFor: lookup })
      await createCorchDispatcher(w.deps).evaluateUser('u1')
      expect(w.launches.length).toBe(1)
      expect(w.launches[0]).toMatchObject({ userId: 'u1', machine: true, targetSupervisorId: sup })
      expect(w.dispatched.length).toBe(1)
    }
  })

  test('no supervisor advertises the account => quota:supervisor_unbound, no launch, no attempt, item waits', async () => {
    process.env.REMO_CORCH_ENABLED = '1'
    const w = world({ accountSlot: 'acct_zz', supervisorFor: lookup })
    await createCorchDispatcher(w.deps).evaluateUser('u1')
    expect(w.launches.length).toBe(0)
    expect(w.dispatched.length).toBe(0)
    expect(w.ends[0]).toMatchObject({ endReason: 'quota:supervisor_unbound', consumeAttempt: false, waitReason: 'quota:supervisor_unbound' })
  })

  test('run holds no account, or the lookup throws => the same refusal (fail closed)', async () => {
    process.env.REMO_CORCH_ENABLED = '1'
    for (const w of [
      world({ accountSlot: null, supervisorFor: lookup }),
      world({ accountSlot: 'acct_a', supervisorFor: async () => { throw new Error('boom') } }),
    ]) {
      await createCorchDispatcher(w.deps).evaluateUser('u1')
      expect(w.launches.length).toBe(0)
      expect(w.ends[0]).toMatchObject({ endReason: 'quota:supervisor_unbound', consumeAttempt: false })
    }
  })

  test('a provider without supervisorFor (the CORCH-01 seam fakes) launches untargeted, unchanged', async () => {
    process.env.REMO_CORCH_ENABLED = '1'
    const w = world({ accountSlot: 'acct_a' })
    await createCorchDispatcher(w.deps).evaluateUser('u1')
    expect(w.launches.length).toBe(1)
    expect('targetSupervisorId' in w.launches[0]).toBe(false)
  })
})

describe('CORCH-02 QC F5: governedLaunch target is opt-in (non-corch callers unchanged)', () => {
  const baseDeps = (calls: any[]): any => ({
    isRepoAutospawnAllowed: async () => true, supervisorOnlineForUser: async () => true, getTokenCapStatus: async () => ({ over: false }),
    countAutospawnLaunchesToday: async () => 0, isOverAutospawnDailyLaunchCap: () => false, graceParkPending: () => false,
    launchSessionForUser: async (a: any) => (calls.push(a), { ok: true, runId: 'r', supervisorId: 's' }), appendRunLog: async () => {},
  })
  const governor = { checkGates: async () => null, reserve: async () => ({ ok: true as const }), release: async () => {} }
  const args = (extra: object = {}): any => ({ userId: 'u', sessionId: 's', repoIdent: 'r', tz: 'UTC', armed: true, ledger: { repoKey: 'r', command: 'c', rationale: () => 'x' }, preLaunch: governor, ...extra })

  test('without resolveTarget the launch call carries no targetSupervisorId', async () => {
    const calls: any[] = []
    await governedLaunch(args(), baseDeps(calls))
    expect(calls.length).toBe(1)
    expect('targetSupervisorId' in calls[0]).toBe(false)
  })

  test('resolveTarget ok => passed through; refused => returned verbatim and nothing launches', async () => {
    const calls: any[] = []
    await governedLaunch(args({ resolveTarget: async () => ({ ok: true, supervisorId: 'sup-X' }) }), baseDeps(calls))
    expect(calls[0]).toMatchObject({ machine: true, targetSupervisorId: 'sup-X' })
    const calls2: any[] = []
    const r = await governedLaunch(args({ resolveTarget: async () => ({ ok: false, reason: 'quota:supervisor_unbound' }) }), baseDeps(calls2))
    expect(r).toEqual({ kind: 'refused', reason: 'quota:supervisor_unbound' })
    expect(calls2.length).toBe(0)
  })
})
