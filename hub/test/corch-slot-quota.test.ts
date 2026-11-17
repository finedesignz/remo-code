// CORCH-14: the built-in quota source. A slot_quota_report is stored only for the reporting connection's own
// registered slot, as a live reading keyed by the slot, and makes the account eligible under the unchanged rules.
import { describe, test, expect } from 'bun:test'
import { handleSlotQuotaReport, type SlotQuotaDeps } from '../src/corch/slot-quota.ts'
import { AgentInbound } from '../src/ws/agent-protocol.ts'
import { evaluateAccounts } from '../src/corch/quota-eligibility.ts'
import type { QuotaAccountInput } from '../src/corch/quota-store.ts'

const NOW = new Date('2026-11-17T12:00:10Z')
const frame = (over: Record<string, unknown> = {}) => ({
  type: 'slot_quota_report', account_slot: 'acct-2', five_h_pct: 25, seven_d_pct: 50,
  resets_5h: '2026-11-17T15:00:00.000Z', resets_7d: '2026-11-22T15:00:00.000Z', fetched_at: '2026-11-17T12:00:00.000Z', ...over,
})
const parse = (over: Record<string, unknown> = {}) => AgentInbound.safeParse(frame(over))

function setup() {
  const upserts: Array<{ userId: string; accounts: QuotaAccountInput[] }> = []
  const evaluated: string[] = []
  const deps: SlotQuotaDeps = {
    upsertSnapshot: async (userId, accounts) => { upserts.push({ userId, accounts }); return accounts.length },
    evaluate: async (userId) => { evaluated.push(userId) },
    now: () => NOW,
  }
  return { deps, upserts, evaluated }
}
const msg = (over: Record<string, unknown> = {}) => {
  const p = parse(over)
  if (!p.success || p.data.type !== 'slot_quota_report') throw new Error('fixture did not parse')
  return p.data
}

describe('slot_quota_report schema', () => {
  test('a well-formed frame parses', () => {
    expect(parse().success).toBe(true)
    expect(parse({ resets_5h: null, resets_7d: null }).success).toBe(true)
  })

  test('out-of-range percentages, a bad slot and a non-ISO instant are rejected', () => {
    for (const bad of [{ five_h_pct: 101 }, { seven_d_pct: -1 }, { account_slot: 'bad slot!' }, { fetched_at: 'yesterday' }, { fetched_at: null }]) {
      expect(parse(bad).success).toBe(false)
    }
  })
})

describe('handleSlotQuotaReport', () => {
  test('the registered slot stores one live row keyed by the slot and triggers one evaluation', async () => {
    const { deps, upserts, evaluated } = setup()
    expect(await handleSlotQuotaReport(deps, { userId: 'user-A', registeredSlot: 'acct-2', msg: msg() })).toBe('stored')
    expect(upserts).toEqual([{
      userId: 'user-A',
      accounts: [{
        account_id: 'acct-2', slot: 'acct-2', five_h_pct: 25, seven_d_pct: 50,
        resets_5h: '2026-11-17T15:00:00.000Z', resets_7d: '2026-11-22T15:00:00.000Z', fetched_at: '2026-11-17T12:00:00.000Z',
        source: 'live', enabled: true, blocked: false,
      }],
    }])
    expect(evaluated).toEqual(['user-A'])
  })

  test('another slot, or a connection that registered no slot, writes nothing', async () => {
    for (const registeredSlot of ['acct-3', null, undefined, '']) {
      const { deps, upserts, evaluated } = setup()
      expect(await handleSlotQuotaReport(deps, { userId: 'user-A', registeredSlot, msg: msg() })).toBe('slot_mismatch')
      expect(upserts).toEqual([])
      expect(evaluated).toEqual([])
    }
  })

  test('a reading dated more than 120s ahead of the hub clock writes nothing', async () => {
    const { deps, upserts } = setup()
    expect(await handleSlotQuotaReport(deps, { userId: 'user-A', registeredSlot: 'acct-2', msg: msg({ fetched_at: '2026-11-17T12:02:11Z' }) })).toBe('future_dated')
    expect(await handleSlotQuotaReport(deps, { userId: 'user-A', registeredSlot: 'acct-2', msg: msg({ fetched_at: '2026-11-17T12:02:09Z' }) })).toBe('stored')
    expect(upserts.length).toBe(1)
  })

  test('a failing evaluation trigger does not undo the stored reading', async () => {
    const { deps, upserts } = setup()
    deps.evaluate = async () => { throw new Error('dispatcher down') }
    expect(await handleSlotQuotaReport(deps, { userId: 'user-A', registeredSlot: 'acct-2', msg: msg() })).toBe('stored')
    expect(upserts.length).toBe(1)
  })

  test('the stored row is eligible under the unchanged rules, and over the ceiling it is not', async () => {
    const { deps, upserts } = setup()
    await handleSlotQuotaReport(deps, { userId: 'user-A', registeredSlot: 'acct-2', msg: msg() })
    const a = upserts[0]!.accounts[0]!
    const row = {
      account_id: a.account_id, slot: a.slot, five_h_pct: a.five_h_pct, seven_d_pct: a.seven_d_pct,
      resets_5h: new Date(a.resets_5h!), resets_7d: new Date(a.resets_7d!), fetched_at: new Date(a.fetched_at!),
      source: a.source, enabled: a.enabled, cug_blocked: a.blocked, received_at: NOW, blocked_until: null, blocked_at: null,
    }
    expect(evaluateAccounts([row], { now: NOW, ceilingPct: 55 })[0]).toMatchObject({ eligible: true, reason: null })
    expect(evaluateAccounts([{ ...row, seven_d_pct: 60 }], { now: NOW, ceilingPct: 55 })[0]).toMatchObject({ eligible: false, reason: 'quota:over_ceiling' })
  })
})
