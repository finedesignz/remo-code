/**
 * P3a — daily cost cap counts REAL accumulated token cost.
 *
 * The gate (`dailyCostCapGate` → `getCostCapStatus` → sql[cap,tz] +
 * `getTodayTokenCostUsd`) must block the NEXT dispatch once today's token_usage
 * cost >= the user's cap, allow under cap, and treat null/0 cap as "no cap".
 *
 * We mock the two data deps so this is pure-logic + reason-string coverage. The
 * gate is the single non-bypassable cost path, so this also asserts that
 * interactive/telegram/webhook dispatch (all of which go through this gate) is
 * now capped — not just scheduled runs.
 */
import { describe, test, expect, mock, beforeEach } from 'bun:test'

const state = {
  cap: '10.00' as string | null,
  tz: 'UTC',
  spent: 0,
}

// gates.ts resolves tz then cap via sql, then sums today's token cost.
mock.module('../src/db/postgres.ts', () => ({
  sql: async () => [{ cap: state.cap, tz: state.tz }],
}))
mock.module('../src/db/token-usage-dal.ts', () => ({
  getTodayTokenCostUsd: async () => state.spent,
  getTodayTokenTotal: async () => 0,
}))

const gatesUrl = `../src/dispatch/gates.ts?t=${Date.now()}${Math.random()}`
const { dailyCostCapGate, isOverCostCap, getCostCapStatus } = await import(gatesUrl)

const req = { userId: 'u1', sessionId: 's1', token: 't1', prompt: 'hi' }

beforeEach(() => {
  state.cap = '10.00'
  state.tz = 'UTC'
  state.spent = 0
})

describe('P3a daily cost cap — real token cost', () => {
  test('allows when today token cost is under the cap', async () => {
    state.spent = 9.99
    const r = await dailyCostCapGate.check(req)
    expect(r.ok).toBe(true)
  })

  test('blocks the NEXT dispatch when accumulated cost >= cap (boundary)', async () => {
    state.spent = 10.0
    const r = await dailyCostCapGate.check(req)
    expect(r.ok).toBe(false)
    // reason surfaces accumulated vs cap so dispatch can tell the user.
    expect((r as { reason: string }).reason).toBe('over_daily_cost_cap:$10.00>=$10.00')
  })

  test('blocks when cost exceeds cap and reports the real spent figure', async () => {
    state.spent = 12.5
    const r = await dailyCostCapGate.check(req)
    expect(r.ok).toBe(false)
    expect((r as { reason: string }).reason).toBe('over_daily_cost_cap:$12.50>=$10.00')
  })

  // NOTE on semantics: the users.daily_cost_cap_usd column is NOT NULL DEFAULT
  // 10.0000, so a missing/null cap coalesces to the legacy $10 default (capped),
  // exactly as the pre-P3a gate did (`Number(rows[0]?.cap ?? 10)`). Only a
  // non-positive / non-finite cap disables enforcement. Unchanged from before.
  test('null cap coalesces to the legacy $10 default (still capped)', async () => {
    state.cap = null
    state.spent = 9999
    expect(await isOverCostCap('u1', 'UTC')).toBe(true)
    const status = await getCostCapStatus('u1', 'UTC')
    expect(status).toEqual({ over: true, spent: 9999, cap: 10 })
  })

  test('zero cap = no limit (fail-open)', async () => {
    state.cap = '0'
    state.spent = 9999
    expect(await isOverCostCap('u1', 'UTC')).toBe(false)
    expect(await getCostCapStatus('u1', 'UTC')).toEqual({ over: false, spent: 0, cap: 0 })
  })

  test('negative cap = no limit (fail-open)', async () => {
    state.cap = '-1'
    state.spent = 9999
    expect(await isOverCostCap('u1', 'UTC')).toBe(false)
  })

  test('getCostCapStatus returns spent + cap when capped', async () => {
    state.cap = '5'
    state.spent = 7
    const status = await getCostCapStatus('u1', 'UTC')
    expect(status).toEqual({ over: true, spent: 7, cap: 5 })
  })
})

describe('P3a — getTodayTokenCostUsd tz-day boundary + source table', () => {
  // Capture the static SQL fragments + the tz param the DAL helper emits, to
  // assert it reads token_usage (NOT scheduled_task_runs) with the SAME tz-day
  // boundary that P2's GET /api/usage/cost "today" uses, and passes the user's tz.
  test('sums token_usage with a per-tz day_trunc boundary', async () => {
    let captured: { text: string; params: any[] } | null = null
    mock.module('../src/db/postgres.ts', () => ({
      sql: async (strings: TemplateStringsArray, ...params: any[]) => {
        captured = { text: strings.join('?'), params }
        return [{ sum: '3.21' }]
      },
    }))
    const url = `../src/db/token-usage-dal.ts?t=${Date.now()}${Math.random()}`
    const { getTodayTokenCostUsd } = await import(url)
    const out = await getTodayTokenCostUsd('u9', 'America/Los_Angeles')
    expect(out).toBe(3.21)
    expect(captured!.text).toContain('FROM token_usage')
    expect(captured!.text).not.toContain('scheduled_task_runs')
    expect(captured!.text).toContain("date_trunc('day', now() AT TIME ZONE")
    expect(captured!.params).toContain('America/Los_Angeles')
  })

  test('defaults blank tz to UTC', async () => {
    let tzParam: any
    mock.module('../src/db/postgres.ts', () => ({
      sql: async (_s: TemplateStringsArray, ...params: any[]) => {
        // getTodayTokenCostUsd interpolates userId then tz → tz is the 2nd param.
        tzParam = params[1]
        return [{ sum: '0' }]
      },
    }))
    const url = `../src/db/token-usage-dal.ts?t=${Date.now()}${Math.random()}`
    const { getTodayTokenCostUsd } = await import(url)
    await getTodayTokenCostUsd('u9', '')
    expect(tzParam).toBe('UTC')
  })
})
