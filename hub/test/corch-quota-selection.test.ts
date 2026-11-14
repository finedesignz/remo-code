// CORCH-02 Task 4: hello account_slot, registry accessor, real provider selection and recording
// (SC4; CORCH-R2.7). Fakes only: no DB.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-chars-long-aaaaaaaa'

import { describe, test, expect, mock } from 'bun:test'
import { SupervisorHello } from '../src/ws/supervisor-protocol.ts'
import { createQuotaProvider, type QuotaProviderDeps } from '../src/corch/quota-provider.ts'
import { corchQuotaGate } from '../src/corch/gates.ts'
import type { QuotaAccountRow } from '../src/corch/quota-eligibility.ts'

// Registry: stub the DB layer before importing (mirrors ws-protocol-cluster.test.ts).
mock.module('../src/db/supervisor-dal', () => ({
  setSupervisorState: async () => {},
  touchSupervisor: async () => {},
  listSupervisorsForUser: async () => [],
}))
const reg = await import('../src/ws/supervisor-registry.ts')

const NOW = new Date('2026-11-13T12:00:00Z')

function row(id: string, over: Partial<QuotaAccountRow> = {}): QuotaAccountRow {
  return {
    account_id: id, slot: id, five_h_pct: 5, seven_d_pct: 10, resets_5h: new Date(NOW.getTime() + 3_600_000),
    resets_7d: new Date(NOW.getTime() + 86_400_000), fetched_at: new Date(NOW.getTime() - 10_000), source: 'live',
    enabled: true, cug_blocked: false, received_at: new Date(NOW.getTime() - 10_000), blocked_until: null, blocked_at: null,
    ...over,
  }
}

interface Fake {
  deps: QuotaProviderDeps
  claims: Array<{ runId: string; userId: string; accountId: string; capacity: number }>
}
function fake(opts: {
  rows: QuotaAccountRow[]
  supervisors?: Array<{ supervisorId: string; accountSlot: string; maxConcurrent: number }>
  busy?: Record<string, number>
  claimOk?: boolean
}): Fake {
  const claims: Fake['claims'] = []
  const deps: QuotaProviderDeps = {
    accountsFor: async () => opts.rows,
    liveRunsByAccount: async () => opts.busy ?? {},
    onlineSlotSupervisors: () => opts.supervisors ?? [],
    claimAccountSlot: async (runId, userId, accountId, capacity) => {
      claims.push({ runId, userId, accountId, capacity })
      return opts.claimOk ?? true
    },
    now: () => NOW,
    ceilingPct: () => 55,
  }
  return { deps, claims }
}
const A = { userId: 'u1', projectId: 'p1', workItemId: 'w1', runId: 'r1' }
const sup = (slot: string, max = 1, id = `sup-${slot}`) => ({ supervisorId: id, accountSlot: slot, maxConcurrent: max })

describe('CORCH-R2.7: SupervisorHello account_slot', () => {
  const base = { type: 'supervisor.hello', version: '1', os: 'linux', hostname: 'h', roots: [] }
  test('parses without account_slot and with a valid one', () => {
    expect(SupervisorHello.safeParse(base).success).toBe(true)
    const ok = SupervisorHello.safeParse({ ...base, account_slot: 'acct_a' })
    expect(ok.success).toBe(true)
    expect((ok as any).data.account_slot).toBe('acct_a')
  })
  test("rejects 'a.b', '' and a 65-char value", () => {
    for (const v of ['a.b', '', 'a'.repeat(65), 'has space']) {
      expect(SupervisorHello.safeParse({ ...base, account_slot: v }).success).toBe(false)
    }
    expect(SupervisorHello.safeParse({ ...base, account_slot: 'a'.repeat(64) }).success).toBe(true)
  })
})

describe('CORCH-R2.7: registry listOnlineSlotSupervisorsForUser', () => {
  const ws = (n: string) => ({ n, close() {}, send() {} }) as any
  test('returns only slot-advertising online supervisors; none after unregister; slot null when absent', () => {
    reg.registerSupervisor({ ws: ws('1'), supervisorId: 'sup-1', userId: 'user-X', apiKeyId: 'key-1', roots: [], accountSlot: 'acct_a', maxConcurrent: 2 })
    reg.registerSupervisor({ ws: ws('2'), supervisorId: 'sup-2', userId: 'user-X', apiKeyId: 'key-2', roots: [] })
    reg.registerSupervisor({ ws: ws('3'), supervisorId: 'sup-3', userId: 'user-Y', apiKeyId: 'key-3', roots: [], accountSlot: 'acct_z' })
    expect(reg.listOnlineSlotSupervisorsForUser('user-X')).toEqual([{ supervisorId: 'sup-1', accountSlot: 'acct_a', maxConcurrent: 2 }])
    expect(reg.getSupervisor('sup-2')?.accountSlot ?? null).toBeNull()
    expect(reg.getSupervisor('sup-2')?.maxConcurrent ?? 1).toBe(1)
    expect(reg.listOnlineSlotSupervisorsForUser('user-Y').length).toBe(1)
    reg.unregisterSupervisor('sup-1')
    expect(reg.listOnlineSlotSupervisorsForUser('user-X')).toEqual([])
    reg.unregisterSupervisor('sup-2')
    reg.unregisterSupervisor('sup-3')
  })
})

describe('CORCH-R2.7 SC4: createQuotaProvider selection', () => {
  const rows3 = () => [row('a', { seven_d_pct: 30 }), row('b', { seven_d_pct: 10 }), row('c', { seven_d_pct: 10 })]

  test('picks the lowest max(5h,7d), tie-break account_id ascending: b over c, a never', async () => {
    const f = fake({ rows: rows3(), supervisors: [sup('a'), sup('b'), sup('c')] })
    const r = await createQuotaProvider(f.deps).snapshotFor(A)
    expect(r).toEqual({ ok: true, account_slot: 'b', supervisor_id: 'sup-b' })
    expect(f.claims).toEqual([{ runId: 'r1', userId: 'u1', accountId: 'b', capacity: 1 }])
  })

  test('uses max(5h, 7d) as the score: a low 7d with a high 5h loses to an even account', async () => {
    const f = fake({
      rows: [row('a', { five_h_pct: 40, seven_d_pct: 5 }), row('b', { five_h_pct: 20, seven_d_pct: 25 })],
      supervisors: [sup('a'), sup('b')],
    })
    expect(((await createQuotaProvider(f.deps).snapshotFor(A)) as any).account_slot).toBe('b')
  })

  test('b has no online slot supervisor => picks c', async () => {
    const f = fake({ rows: rows3(), supervisors: [sup('a'), sup('c')] })
    expect(((await createQuotaProvider(f.deps).snapshotFor(A)) as any).account_slot).toBe('c')
  })

  test("b's supervisor is full (busy 2, maxConcurrent 2) => picks c", async () => {
    const f = fake({ rows: rows3(), supervisors: [sup('a'), sup('b', 2), sup('c')], busy: { b: 2 } })
    expect(((await createQuotaProvider(f.deps).snapshotFor(A)) as any).account_slot).toBe('c')
  })

  test('capacity is the largest max_concurrent among that slot supervisors', async () => {
    const f = fake({ rows: [row('b')], supervisors: [sup('b', 1, 's1'), sup('b', 3, 's2')], busy: { b: 2 } })
    const r = await createQuotaProvider(f.deps).snapshotFor(A)
    expect(r.ok).toBe(true)
    expect(f.claims[0]!.capacity).toBe(3)
  })

  test('only a supervisor without account_slot online => quota:no_slot_supervisor', async () => {
    const f = fake({ rows: rows3(), supervisors: [] })
    expect(await createQuotaProvider(f.deps).snapshotFor(A)).toEqual({ ok: false, reason: 'quota:no_slot_supervisor' })
    expect(f.claims.length).toBe(0)
  })

  test('null-5h account with busy 1 and maxConcurrent 3 is skipped (cap 1); with busy 0 capacity is capped at 1', async () => {
    const skipped = fake({
      rows: [row('n', { five_h_pct: null, seven_d_pct: 5 }), row('m', { seven_d_pct: 30 })],
      supervisors: [sup('n', 3), sup('m')],
      busy: { n: 1 },
    })
    expect(((await createQuotaProvider(skipped.deps).snapshotFor(A)) as any).account_slot).toBe('m')

    const free = fake({ rows: [row('n', { five_h_pct: null, seven_d_pct: 5 })], supervisors: [sup('n', 3)] })
    const r = await createQuotaProvider(free.deps).snapshotFor(A)
    expect(r.ok).toBe(true)
    expect(free.claims[0]!.capacity).toBe(1)
  })

  test("a run already carrying account_slot 'a' only considers a (never moved), and no second claim is made", async () => {
    const f = fake({ rows: rows3(), supervisors: [sup('a'), sup('b'), sup('c')] })
    const r = await createQuotaProvider(f.deps).snapshotFor({ ...A, accountSlot: 'a' })
    expect(r).toEqual({ ok: true, account_slot: 'a', supervisor_id: 'sup-a' })
    expect(f.claims.length).toBe(0)
  })

  test('a pinned account that is ineligible refuses with ITS reason, never moves to b', async () => {
    const f = fake({
      rows: [row('a', { seven_d_pct: 80 }), row('b', { seven_d_pct: 5 })],
      supervisors: [sup('a'), sup('b')],
    })
    expect(await createQuotaProvider(f.deps).snapshotFor({ ...A, accountSlot: 'a' })).toEqual({ ok: false, reason: 'quota:over_ceiling' })
    expect(f.claims.length).toBe(0)
  })

  test('claimAccountSlot false => quota:slot_taken', async () => {
    const f = fake({ rows: [row('b')], supervisors: [sup('b')], claimOk: false })
    expect(await createQuotaProvider(f.deps).snapshotFor(A)).toEqual({ ok: false, reason: 'quota:slot_taken' })
    expect(f.claims.length).toBe(1)
  })

  test('no rows => quota:no_snapshot', async () => {
    const f = fake({ rows: [] })
    expect(await createQuotaProvider(f.deps).snapshotFor(A)).toEqual({ ok: false, reason: 'quota:no_snapshot' })
  })

  test('all accounts over ceiling => quota:over_ceiling (shared reason)', async () => {
    const f = fake({ rows: [row('a', { seven_d_pct: 70 }), row('b', { five_h_pct: 90 })], supervisors: [sup('a'), sup('b')] })
    expect(await createQuotaProvider(f.deps).snapshotFor(A)).toEqual({ ok: false, reason: 'quota:over_ceiling' })
  })

  test('mixed reasons => quota:no_eligible_account', async () => {
    const f = fake({ rows: [row('a', { seven_d_pct: 70 }), row('b', { source: 'fetch_failed' })], supervisors: [sup('a'), sup('b')] })
    expect(await createQuotaProvider(f.deps).snapshotFor(A)).toEqual({ ok: false, reason: 'quota:no_eligible_account' })
  })

  test('a supervisor for an account NOT in the snapshot is never a target', async () => {
    const f = fake({ rows: [row('a')], supervisors: [sup('zzz')] })
    expect(await createQuotaProvider(f.deps).snapshotFor(A)).toEqual({ ok: false, reason: 'quota:no_slot_supervisor' })
  })

  test('F5: the selection carries the supervisor advertising the chosen account (lowest id on a tie); supervisorFor resolves it, null when none', async () => {
    const f = fake({
      rows: [row('a', { seven_d_pct: 30 }), row('b', { seven_d_pct: 10 })],
      supervisors: [sup('b', 1, 'sup-b2'), sup('b', 1, 'sup-b1'), sup('a')],
    })
    const p = createQuotaProvider(f.deps)
    expect(await p.snapshotFor(A)).toEqual({ ok: true, account_slot: 'b', supervisor_id: 'sup-b1' })
    expect(await p.supervisorFor!('u1', 'a')).toBe('sup-a')
    expect(await p.supervisorFor!('u1', 'b')).toBe('sup-b1')
    expect(await p.supervisorFor!('u1', 'nobody')).toBeNull()
  })

  test('without a runId nothing is claimed but a candidate is still chosen', async () => {
    const f = fake({ rows: [row('a')], supervisors: [sup('a')] })
    const r = await createQuotaProvider(f.deps).snapshotFor({ userId: 'u1', projectId: 'p1', workItemId: 'w1' })
    expect(r).toEqual({ ok: true, account_slot: 'a', supervisor_id: 'sup-a' })
    expect(f.claims.length).toBe(0)
  })
})

describe('CORCH-R2.6 earliestEligibleAt', () => {
  test('two accounts over ceiling with resets T1 < T2 => T1', async () => {
    const t1 = new Date(NOW.getTime() + 1_800_000)
    const t2 = new Date(NOW.getTime() + 7_200_000)
    const f = fake({
      rows: [row('a', { seven_d_pct: 70, resets_7d: t2 }), row('b', { five_h_pct: 90, resets_5h: t1 })],
    })
    expect((await createQuotaProvider(f.deps).earliestEligibleAt!('u1'))?.toISOString()).toBe(t1.toISOString())
  })

  test('one over ceiling + one stale => NULL (only an event can change the stale one)', async () => {
    const f = fake({ rows: [row('a', { seven_d_pct: 70 }), row('b', { fetched_at: null })] })
    expect(await createQuotaProvider(f.deps).earliestEligibleAt!('u1')).toBeNull()
  })

  test('no rows or every account eligible => NULL', async () => {
    expect(await createQuotaProvider(fake({ rows: [] }).deps).earliestEligibleAt!('u1')).toBeNull()
    expect(await createQuotaProvider(fake({ rows: [row('a')] }).deps).earliestEligibleAt!('u1')).toBeNull()
  })
})

describe('CORCH-R2.7: corchQuotaGate passes runId and run.account_slot', () => {
  test('snapshotFor receives runId and accountSlot; refusal behaviour unchanged', async () => {
    const seen: unknown[] = []
    const quota = {
      snapshotFor: async (a: unknown) => {
        seen.push(a)
        return { ok: true as const, account_slot: 'a', supervisor_id: null }
      },
    }
    const store = {
      runContext: async () => ({
        run: { id: 'r1', user_id: 'u1', project_id: 'p1', work_item_id: 'w1', account_slot: 'acct_a', ended_at: null },
        item: { id: 'w1' }, project: { id: 'p1' }, maxConcurrent: 1, tz: 'UTC',
      }),
    } as any
    const gate = corchQuotaGate(quota as any, store)
    expect(await gate.check({ userId: 'u1', sessionId: 's1', token: 'corch-run:r1', prompt: 'p' } as any)).toEqual({ ok: true })
    expect(seen[0]).toEqual({ userId: 'u1', projectId: 'p1', workItemId: 'w1', runId: 'r1', accountSlot: 'acct_a' })

    const refuse = corchQuotaGate({ snapshotFor: async () => ({ ok: false as const, reason: 'quota:over_ceiling' }) } as any, store)
    expect(await refuse.check({ userId: 'u1', sessionId: 's1', token: 'corch-run:r1', prompt: 'p' } as any)).toEqual({
      ok: false, reason: 'quota:over_ceiling',
    })
  })
})
