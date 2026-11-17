// CORCH-02 Task 6: a quota death blocks the account until reset and requeues with no attempt (SC5; CORCH-R2.5).
// Samples are the verbatim strings recorded in CORCH-02-RESEARCH.md Q1. Fakes only: no DB.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-chars-long-aaaaaaaa'

import { describe, test, expect, afterEach } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { classifyQuotaDeath } from '../src/corch/quota-death.ts'
import { createCorchDispatcher } from '../src/corch/dispatcher.ts'

const savedFlag = process.env.REMO_CORCH_ENABLED
afterEach(() => {
  if (savedFlag === undefined) delete process.env.REMO_CORCH_ENABLED
  else process.env.REMO_CORCH_ENABLED = savedFlag
})

const LEGACY = 'Claude AI usage limit reached|1760000000'
const SESSION = "You've hit your session limit · resets 3pm (America/Los_Angeles)"
const WEEKLY = "You've hit your weekly limit · resets Nov 18 at 9am (UTC)"

describe('classifyQuotaDeath (LD-Q10, CORCH-R2.5)', () => {
  test('legacy sample => match with the epoch parsed to a Date', () => {
    const d = classifyQuotaDeath(LEGACY)
    expect(d).not.toBeNull()
    expect(d!.resetAt!.toISOString()).toBe(new Date(1760000000 * 1000).toISOString())
    expect(d!.window).toBeNull()
  })

  test('current samples => match, reset not parsed (null), window named', () => {
    expect(classifyQuotaDeath(SESSION)).toEqual({ resetAt: null, window: '5h' })
    expect(classifyQuotaDeath(WEEKLY)).toEqual({ resetAt: null, window: '7d' })
    expect(classifyQuotaDeath("You've hit your Opus limit · resets 2am (UTC)")).toEqual({ resetAt: null, window: '7d' })
    expect(classifyQuotaDeath('You\u2019ve hit your session limit')).toEqual({ resetAt: null, window: '5h' })
  })

  test('whitespace around the text is trimmed', () => {
    expect(classifyQuotaDeath(`\n  ${SESSION}  \n`)).not.toBeNull()
  })

  test('the same sample embedded in a 2,000-char assistant message => null', () => {
    const long = `${'I worked on the task. '.repeat(80)}${SESSION} ${'More text. '.repeat(80)}`
    expect(long.length).toBeGreaterThan(2000)
    expect(classifyQuotaDeath(long)).toBeNull()
    expect(classifyQuotaDeath(`Note: the CLI prints "${LEGACY}" when over the limit.`)).toBeNull()
    expect(classifyQuotaDeath(`${SESSION}\nand then I continued with more work`)).toBeNull()
  })

  test('a sample padded past 500 chars is null', () => {
    expect(classifyQuotaDeath(`${SESSION}${' x'.repeat(300)}`)).toBeNull()
  })

  test('empty, ordinary and non-window-limit messages => null', () => {
    for (const t of [
      '', '   ', 'no PR opened', 'Done. PR opened at https://github.com/acme/app/pull/1',
      "You've hit your monthly spend limit.", "You've hit your team's shared budget.", "You've hit your fast limit",
      'You are out of usage credits', 'rate limited', 'Claude AI usage limit reached', 'Claude AI usage limit reached|abc',
    ]) {
      expect(classifyQuotaDeath(t)).toBeNull()
    }
    expect(classifyQuotaDeath(null)).toBeNull()
    expect(classifyQuotaDeath(undefined)).toBeNull()
  })
})

const NOW = new Date('2026-11-13T10:00:00Z') // the injected dispatcher clock

interface WorldOpts {
  accountSlot: string | null
  markDeath?: (a: any) => Promise<Date | null>
  prKind?: 'open' | 'none' | 'unavailable'
}
function world(opts: WorldOpts) {
  const ends: any[] = []
  const markDeathCalls: any[] = []
  const prCalls: any[] = []
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
    endRunMarkPrOpen: async (_id: string, url: string) => (ends.push({ prOpen: url }), { changed: true, workItemId: 'w1', userId: 'u1', itemStatus: 'pr_open', attempts: 0 }),
    earliestFutureNotBefore: async () => null,
    usersWithDueItems: async () => [],
    runContext: async () => ({ run: { id: 'run-1', user_id: 'u1', account_slot: opts.accountSlot, ended_at: null } }),
  }
  const launch: any = {
    tzForUser: async () => 'UTC',
    checkGates: async () => null,
    reserve: async () => ({ ok: true }),
    release: async () => {},
    isRepoAutospawnAllowed: async () => true,
    supervisorOnlineForUser: async () => true,
    getTokenCapStatus: async () => ({ over: false }),
    countAutospawnLaunchesToday: async () => 0,
    isOverAutospawnDailyLaunchCap: () => false,
    graceParkPending: () => false,
    launchSessionForUser: async () => ({ ok: true, runId: 'sup-run', supervisorId: 'sup-1' }),
    appendRunLog: async () => {},
  }
  const quota: any = {
    snapshotFor: async () => ({ ok: true, account_slot: opts.accountSlot, supervisor_id: null }),
    markDeath: async (a: any) => (markDeathCalls.push(a), opts.markDeath ? opts.markDeath(a) : null),
  }
  const deps: any = {
    store,
    workspace: { resolve: async () => ({ ok: true, sessionId: 's1', worktreePath: 'C:/wt/app' }) },
    launch,
    launchCommand: 'corch_test_launch',
    quota,
    pipeline: { isOnline: async () => true, send: async () => {} },
    dispatch: async (req: any, pdeps: any) => (dispatched.push({ req, pdeps }), { kind: 'dispatched', runId: 'x' }),
    prLookup: {
      lookup: async (a: any) => {
        prCalls.push(a)
        return opts.prKind === 'open' ? { kind: 'open', url: 'https://github.com/acme/app/pull/1' } : { kind: opts.prKind ?? 'none' }
      },
    },
    notify: async () => {},
    timers: { setTimeout: () => ({}), clearTimeout: () => {} },
    now: () => NOW,
  }
  return { ends, markDeathCalls, prCalls, dispatched, deps, clock: NOW }
}

describe('CORCH-R2.5 SC5: handleRunEnd on a death sample', () => {
  test('onFinalize with a death sample and account_slot acct_a: markDeath once, quota_death requeue, no PR lookup', async () => {
    process.env.REMO_CORCH_ENABLED = '1'
    const until = new Date('2026-11-13T20:00:00Z')
    const w = world({ accountSlot: 'acct_a', markDeath: async () => until })
    await createCorchDispatcher(w.deps).evaluateUser('u1')
    expect(w.ends.length).toBe(0) // dispatched, still running
    await w.dispatched[0].pdeps.store.onFinalize('corch-run:run-1', SESSION)
    expect(w.markDeathCalls).toEqual([{ userId: 'u1', accountId: 'acct_a', resetAt: null, window: '5h' }])
    // QC2 G1: the block was recorded, so the account block alone governs quota; the item only backs off 600s.
    expect(w.ends[0]).toEqual({ endReason: 'quota_death', consumeAttempt: false, waitReason: 'quota:death', notBefore: { at: new Date(w.clock.getTime() + 600_000).toISOString() } })
    expect(w.prCalls.length).toBe(0)
  })

  test('QC2 G1: once the block is recorded the item is NOT held to the death deadline (a clearing snapshot can release it after 600s)', async () => {
    process.env.REMO_CORCH_ENABLED = '1'
    const farDeadline = new Date(NOW.getTime() + 7 * 86_400_000)
    const w = world({ accountSlot: 'acct_a', markDeath: async () => farDeadline })
    await createCorchDispatcher(w.deps).evaluateUser('u1')
    await w.dispatched[0].pdeps.store.onFinalize('corch-run:run-1', WEEKLY)
    expect(Date.parse(w.ends[0].notBefore.at)).toBe(w.clock.getTime() + 600_000)
  })

  test('QC2 G1: markDeath resolving to undefined (block not recorded) => fail-closed now+5h hold', async () => {
    process.env.REMO_CORCH_ENABLED = '1'
    const w = world({ accountSlot: 'acct_a', markDeath: async () => undefined as any })
    await createCorchDispatcher(w.deps).evaluateUser('u1')
    await w.dispatched[0].pdeps.store.onFinalize('corch-run:run-1', SESSION)
    expect(Date.parse(w.ends[0].notBefore.at)).toBe(w.clock.getTime() + 5 * 3600_000)
  })

  test('the legacy epoch is passed through as resetAt', async () => {
    process.env.REMO_CORCH_ENABLED = '1'
    const w = world({ accountSlot: 'acct_a' })
    await createCorchDispatcher(w.deps).evaluateUser('u1')
    await w.dispatched[0].pdeps.store.onFinalize('corch-run:run-1', LEGACY)
    expect(w.markDeathCalls[0].resetAt.toISOString()).toBe(new Date(1760000000 * 1000).toISOString())
  })

  test('markFailed with a death sample => same outcome', async () => {
    process.env.REMO_CORCH_ENABLED = '1'
    const w = world({ accountSlot: 'acct_a', markDeath: async () => new Date('2026-11-13T20:00:00Z') })
    await createCorchDispatcher(w.deps).evaluateUser('u1')
    await w.dispatched[0].pdeps.store.markFailed('corch-run:run-1', WEEKLY)
    expect(w.markDeathCalls.length).toBe(1)
    expect(w.ends[0]).toMatchObject({ endReason: 'quota_death', consumeAttempt: false, waitReason: 'quota:death' })
    expect(w.prCalls.length).toBe(0)
  })

  test('markFailed with any other error keeps the dispatch_failed path (attempt consumed)', async () => {
    process.env.REMO_CORCH_ENABLED = '1'
    const w = world({ accountSlot: 'acct_a' })
    await createCorchDispatcher(w.deps).evaluateUser('u1')
    await w.dispatched[0].pdeps.store.markFailed('corch-run:run-1', 'socket closed')
    expect(w.markDeathCalls.length).toBe(0)
    expect(w.ends[0]).toMatchObject({ endReason: 'dispatch_failed', consumeAttempt: true })
  })

  test('run.account_slot NULL => no markDeath, requeue with no attempt and notBefore null', async () => {
    process.env.REMO_CORCH_ENABLED = '1'
    const w = world({ accountSlot: null })
    await createCorchDispatcher(w.deps).evaluateUser('u1')
    await w.dispatched[0].pdeps.store.onFinalize('corch-run:run-1', SESSION)
    expect(w.markDeathCalls.length).toBe(0)
    expect(w.ends[0]).toEqual({ endReason: 'quota_death', consumeAttempt: false, waitReason: 'quota:death', notBefore: null })
    expect(w.prCalls.length).toBe(0)
  })

  test('QC2 G1: markDeath returning null (block not recorded) => fail-closed now+5h hold, never an immediate requeue', async () => {
    process.env.REMO_CORCH_ENABLED = '1'
    const w = world({ accountSlot: 'acct_a', markDeath: async () => null })
    await createCorchDispatcher(w.deps).evaluateUser('u1')
    await w.dispatched[0].pdeps.store.onFinalize('corch-run:run-1', SESSION)
    expect(w.ends[0]).toMatchObject({ endReason: 'quota_death', consumeAttempt: false })
    expect(Date.parse(w.ends[0].notBefore.at)).toBe(NOW.getTime() + 5 * 3600_000)
  })

  const fiveHoursOut = (at: string) => Date.parse(at) === NOW.getTime() + 5 * 3600_000

  test('F3: a throwing markDeath requeues without an attempt but NOT immediately: not_before = now+5h (fail closed)', async () => {
    process.env.REMO_CORCH_ENABLED = '1'
    const w = world({ accountSlot: 'acct_a', markDeath: async () => { throw new Error('db down') } })
    await createCorchDispatcher(w.deps).evaluateUser('u1')
    await w.dispatched[0].pdeps.store.onFinalize('corch-run:run-1', SESSION)
    expect(w.ends[0]).toMatchObject({ endReason: 'quota_death', consumeAttempt: false, waitReason: 'quota:death' })
    expect(fiveHoursOut(w.ends[0].notBefore.at)).toBe(true)
  })

  test('F3: a throwing runContext (account unknown) also requeues with not_before = now+5h', async () => {
    process.env.REMO_CORCH_ENABLED = '1'
    const w = world({ accountSlot: 'acct_a' })
    await createCorchDispatcher(w.deps).evaluateUser('u1')
    w.deps.store.runContext = async () => { throw new Error('db down') }
    await w.dispatched[0].pdeps.store.onFinalize('corch-run:run-1', SESSION)
    expect(w.markDeathCalls.length).toBe(0)
    expect(w.ends[0]).toMatchObject({ endReason: 'quota_death', consumeAttempt: false })
    expect(fiveHoursOut(w.ends[0].notBefore.at)).toBe(true)
  })

  test('non-death content keeps the CORCH-01 path: PR lookup runs, no_pr consumes an attempt', async () => {
    process.env.REMO_CORCH_ENABLED = '1'
    const w = world({ accountSlot: 'acct_a', prKind: 'none' })
    await createCorchDispatcher(w.deps).evaluateUser('u1')
    await w.dispatched[0].pdeps.store.onFinalize('corch-run:run-1', 'I finished the task, no changes needed.')
    expect(w.prCalls.length).toBe(1)
    expect(w.markDeathCalls.length).toBe(0)
    expect(w.ends[0]).toMatchObject({ endReason: 'no_pr', consumeAttempt: true })
  })
})

describe('log hygiene (T-CORCH02-10)', () => {
  test('the death path logs no content or error text', () => {
    const d = readFileSync(join(import.meta.dir, '..', 'src/corch/dispatcher.ts'), 'utf8')
    const fn = d.slice(d.indexOf('async function endQuotaDeath'), d.indexOf('async function handleRunEnd'))
    // only errMsg(err) of the failing operation is interpolated, never the CLI text / death value
    expect(fn).not.toMatch(/\$\{\s*(text|content|error|death|msg)\b/)
  })
})
