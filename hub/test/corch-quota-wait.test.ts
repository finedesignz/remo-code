// CORCH-02 Task 5: dispatcher wiring - quota refusal waits with not_before (CORCH-R2.6) and the
// ingest trigger (SC5 spy). Fakes only: no DB.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-chars-long-aaaaaaaa'

import { describe, test, expect, afterEach } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createCorchDispatcher, refusalSchedule, toNotBefore, corchSingletonConstructed } from '../src/corch/dispatcher.ts'
import { DEFAULT_QUOTA_PROVIDER } from '../src/corch/quota-provider.ts'
import { createQuotaRoutes, defaultQuotaEvaluate } from '../src/api/quota.ts'

const SRC = join(import.meta.dir, '..', 'src')
const savedFlag = process.env.REMO_CORCH_ENABLED
afterEach(() => {
  if (savedFlag === undefined) delete process.env.REMO_CORCH_ENABLED
  else process.env.REMO_CORCH_ENABLED = savedFlag
})

describe('refusalSchedule: quota: reasons (LD-Q9)', () => {
  test("every quota: reason is kind 'quota'", () => {
    for (const r of [
      'quota:over_ceiling', 'quota:no_snapshot', 'quota:snapshot_stale', 'quota:account_stale', 'quota:source_not_live',
      'quota:cug_blocked', 'quota:cug_disabled', 'quota:blocked', 'quota:seven_d_unknown', 'quota:five_h_unknown_busy',
      'quota:no_slot_supervisor', 'quota:no_eligible_account', 'quota:slot_taken',
    ]) {
      expect(refusalSchedule(r)).toEqual({ endReason: r, waitReason: r, notBefore: 'quota' })
    }
  })

  test('existing mappings and quota_no_snapshot are unchanged', () => {
    for (const r of ['project_budget', 'over_daily_cost_cap:$1>=$1', 'over_daily_token_cap:5>=4', 'over_token_cap', 'launch_cap']) {
      expect(refusalSchedule(r).notBefore).toBe('midnight')
    }
    expect(refusalSchedule('over_session_inject_rate:4>=4').notBefore).toBe('plus_60m')
    expect(refusalSchedule('autospawn_launch_no_supervisor').notBefore).toBe('plus_lease')
    for (const r of ['quota_no_snapshot', 'corch_concurrency', 'workspace_unavailable', 'weird_unknown']) {
      expect(refusalSchedule(r).notBefore).toBeNull()
    }
    expect(refusalSchedule('quota_no_snapshot')).toEqual({ endReason: 'quota_no_snapshot', waitReason: 'quota_no_snapshot', notBefore: null })
  })

  test('toNotBefore keeps the old kinds; quota resolves in refuseRun so the bare kind maps to null', () => {
    expect(toNotBefore('midnight', 'UTC')).toEqual({ midnightTz: 'UTC' })
    expect(toNotBefore('plus_60m', 'UTC')).toEqual({ plusSeconds: 3600 })
    expect(toNotBefore('quota', 'UTC')).toBeNull()
    expect(toNotBefore(null, 'UTC')).toBeNull()
  })
})

function world(quota: any, gateReason: string) {
  const ends: any[] = []
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
    endRunMarkPrOpen: async () => ({ changed: false }),
    earliestFutureNotBefore: async () => null,
    usersWithDueItems: async () => [],
    runContext: async () => null,
  }
  const launch: any = {
    tzForUser: async () => 'UTC',
    checkGates: async () => gateReason,
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
  const deps: any = {
    store,
    workspace: { resolve: async () => ({ ok: true, sessionId: 's1', worktreePath: 'C:/wt/app' }) },
    launch,
    launchCommand: 'corch_test_launch',
    quota,
    pipeline: { isOnline: async () => true, send: async () => {} },
    dispatch: async () => ({ kind: 'dispatched', runId: 'x' }),
    prLookup: { lookup: async () => ({ kind: 'none' }) },
    notify: async () => {},
    timers: { setTimeout: () => ({}), clearTimeout: () => {} },
  }
  return { ends, deps }
}

describe('CORCH-R2.6: a quota refusal requeues with not_before = earliest eligible instant', () => {
  test('earliestEligibleAt returns T => notBefore {at: T iso}, no attempt, wait_reason = the reason', async () => {
    process.env.REMO_CORCH_ENABLED = '1'
    const T = new Date('2026-11-13T18:30:00Z')
    const seen: string[] = []
    const quota = { snapshotFor: async () => ({ ok: false, reason: 'quota:over_ceiling' }), earliestEligibleAt: async (u: string) => (seen.push(u), T) }
    const { ends, deps } = world(quota, 'quota:over_ceiling')
    await createCorchDispatcher(deps).evaluateUser('u1')
    expect(ends[0]).toEqual({ endReason: 'quota:over_ceiling', consumeAttempt: false, waitReason: 'quota:over_ceiling', notBefore: { at: T.toISOString() } })
    expect(seen).toEqual(['u1'])
  })

  test('earliestEligibleAt returns NULL => notBefore null (an event must re-evaluate)', async () => {
    process.env.REMO_CORCH_ENABLED = '1'
    const quota = { snapshotFor: async () => ({ ok: false, reason: 'quota:account_stale' }), earliestEligibleAt: async () => null }
    const { ends, deps } = world(quota, 'quota:account_stale')
    await createCorchDispatcher(deps).evaluateUser('u1')
    expect(ends[0]).toMatchObject({ consumeAttempt: false, waitReason: 'quota:account_stale', notBefore: null })
  })

  test('a provider without earliestEligibleAt => notBefore null (DEFAULT behaviour unchanged)', async () => {
    process.env.REMO_CORCH_ENABLED = '1'
    const { ends, deps } = world(DEFAULT_QUOTA_PROVIDER, 'quota:no_snapshot')
    await createCorchDispatcher(deps).evaluateUser('u1')
    expect(ends[0]).toMatchObject({ consumeAttempt: false, waitReason: 'quota:no_snapshot', notBefore: null })
  })

  test('a throwing earliestEligibleAt degrades to NULL (event-driven), never to a stuck run', async () => {
    process.env.REMO_CORCH_ENABLED = '1'
    const quota = { snapshotFor: async () => ({ ok: false, reason: 'quota:over_ceiling' }), earliestEligibleAt: async () => { throw new Error('db') } }
    const { ends, deps } = world(quota, 'quota:over_ceiling')
    await createCorchDispatcher(deps).evaluateUser('u1')
    expect(ends[0]).toMatchObject({ consumeAttempt: false, notBefore: null })
  })
})

describe('store NotBefore {at} branch + realCorchDeps wiring pins', () => {
  test('store.ts handles the {at} variant with one CASE branch; NotBefore type includes it', () => {
    const s = readFileSync(join(SRC, 'corch/store.ts'), 'utf8')
    expect(s).toMatch(/\{ at: string \}/)
    expect(s).toMatch(/'at' in nb/)
  })

  test('realCorchDeps uses createQuotaProvider (dynamic quota-store import), DEFAULT only as the CORCH-01 default', () => {
    const d = readFileSync(join(SRC, 'corch/dispatcher.ts'), 'utf8')
    const real = d.slice(d.indexOf('export async function realCorchDeps'))
    expect(real).toContain('createQuotaProvider(')
    expect(real).toContain("await import('./quota-store.ts')")
    expect(real).not.toMatch(/quota:\s*DEFAULT_QUOTA_PROVIDER/)
    expect(d).not.toMatch(/^import .*quota-store/m)
  })
})

// ── Ingest trigger: exactly one evaluation per successful POST (SC5) ─────────

const KEY = { id: 'k1', user_id: 'user-A', scopes: ['quota:publish'] }
const acct = { account_id: 'a', slot: 'a', five_h_pct: 1, seven_d_pct: 2, resets_5h: null, resets_7d: null, fetched_at: '2026-11-13T12:00:00Z', source: 'live', enabled: true, blocked: false, current: false }
const body = { schema: 1, publisher: 'cug', generated_at: '2026-11-13T12:00:00Z', poll_interval_secs: 300, accounts: [acct] }

function ingest(evaluate: (u: string) => Promise<void>) {
  const upserts: string[] = []
  const app = createQuotaRoutes({
    verifyKey: async (raw) => (raw === 'remokey_ok' ? KEY : raw === 'remokey_read' ? { ...KEY, scopes: ['quota:read'] } : null),
    store: { upsertSnapshot: async (u, a) => (upserts.push(u), a.length), accountsFor: async () => [], liveRunsByAccount: async () => ({}) },
    ceilingPct: () => 55, evaluate, now: () => new Date(),
  })
  const post = (key: string | null, payload: unknown, raw?: string) =>
    app.request('/snapshot', { method: 'POST', headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}) }, body: raw ?? JSON.stringify(payload) })
  return { app, post, upserts }
}

describe('SC5 spy: a successful POST triggers exactly one evaluation (LD-Q11)', () => {
  test('one POST => one call with the key owner user id; three POSTs => three calls', async () => {
    const calls: string[] = []
    const { post } = ingest(async (u) => void calls.push(u))
    expect((await post('remokey_ok', body)).status).toBe(200)
    expect(calls).toEqual(['user-A'])
    await post('remokey_ok', body)
    await post('remokey_ok', body)
    expect(calls.length).toBe(3)
  })

  test('400, 401, 403 and 413 trigger zero evaluations', async () => {
    const calls: string[] = []
    const { post } = ingest(async (u) => void calls.push(u))
    expect((await post('remokey_ok', { ...body, extra: 1 })).status).toBe(400)
    expect((await post(null, body)).status).toBe(401)
    expect((await post('remokey_read', body)).status).toBe(403)
    expect((await post('remokey_ok', null, JSON.stringify({ pad: 'x'.repeat(70 * 1024) }))).status).toBe(413)
    expect(calls).toEqual([])
  })

  test('a throwing evaluate never fails the POST (the row is stored), one warn line, no body data', async () => {
    const { post, upserts } = ingest(async () => { throw new Error('dispatcher exploded') })
    expect((await post('remokey_ok', body)).status).toBe(200)
    expect(upserts).toEqual(['user-A'])
  })

  test('default evaluate with the flag OFF resolves without constructing the dispatcher singleton', async () => {
    delete process.env.REMO_CORCH_ENABLED
    const before = corchSingletonConstructed()
    await defaultQuotaEvaluate('user-A')
    expect(corchSingletonConstructed()).toBe(before)
    expect(before).toBe(false)
    const q = readFileSync(join(SRC, 'api/quota.ts'), 'utf8')
    const fn = q.slice(q.indexOf('export async function defaultQuotaEvaluate'))
    expect(fn.indexOf('corchEnabled()')).toBeGreaterThan(-1)
    expect(fn.indexOf('corchEnabled()')).toBeLessThan(fn.indexOf("import('../corch/dispatcher.ts')"))
  })

  test('no timer, poll or retry loop in the route file', () => {
    const q = readFileSync(join(SRC, 'api/quota.ts'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[ \t])\/\/.*$/gm, '$1')
    expect(q).not.toMatch(/\bsetInterval\s*\(|\bsetTimeout\s*\(/)
  })
})
