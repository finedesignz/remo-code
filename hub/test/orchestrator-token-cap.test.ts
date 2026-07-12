/**
 * BSA-04 — non-bypassable daily TOKEN ceiling + autospawn launch-count cap.
 *
 * `dailyTokenCapGate` mirrors `dailyCostCapGate`: count today's REAL tokens from
 * token_usage (tz-day boundary) and refuse the NEXT dispatch when at/over the
 * configured cap. It is ADDED ALONGSIDE the cost cap — these tests assert it
 * blocks/allows correctly and that the launch-count cap predicate is pure. We mock
 * the two data deps so this is pure-logic + reason-string coverage.
 */
import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test'

const state = {
  tz: 'UTC',
  tokens: 0,
}

mock.module('../src/db/postgres.ts', () => ({
  sql: async () => [{ tz: state.tz }],
}))
mock.module('../src/db/token-usage-dal.ts', () => ({
  getTodayTokenTotal: async () => state.tokens,
  // dailyCostCapGate's import must still resolve even though we don't exercise it.
  getTodayTokenCostUsd: async () => 0,
}))

const TOKEN_KEY = 'REMO_ORCHESTRATOR_DAILY_TOKEN_CAP'
const LAUNCH_KEY = 'REMO_ORCHESTRATOR_AUTOSPAWN_DAILY_LAUNCHES'
const origToken = process.env[TOKEN_KEY]
const origLaunch = process.env[LAUNCH_KEY]

const gatesUrl = `../src/dispatch/gates.ts?t=${Date.now()}${Math.random()}`
const {
  dailyTokenCapGate,
  getTokenCapStatus,
  isOverTokenCap,
  isOverAutospawnDailyLaunchCap,
  autospawnDailyLaunchCap,
} = await import(gatesUrl)

const req = { userId: 'u1', sessionId: 's1', token: 't1', prompt: 'hi' }

beforeEach(() => {
  state.tz = 'UTC'
  state.tokens = 0
  delete process.env[TOKEN_KEY]
  delete process.env[LAUNCH_KEY]
})
afterEach(() => {
  if (origToken === undefined) delete process.env[TOKEN_KEY]
  else process.env[TOKEN_KEY] = origToken
  if (origLaunch === undefined) delete process.env[LAUNCH_KEY]
  else process.env[LAUNCH_KEY] = origLaunch
})

describe('BSA-04 daily token cap gate', () => {
  test('allows when today tokens are under the (default 50M) cap', async () => {
    state.tokens = 49_999_999
    const r = await dailyTokenCapGate.check(req)
    expect(r.ok).toBe(true)
  })

  test('blocks the NEXT dispatch at the cap boundary (>=)', async () => {
    state.tokens = 50_000_000
    const r = await dailyTokenCapGate.check(req)
    expect(r.ok).toBe(false)
    expect((r as { reason: string }).reason).toBe('over_daily_token_cap:50000000>=50000000')
  })

  test('honors REMO_ORCHESTRATOR_DAILY_TOKEN_CAP override', async () => {
    process.env[TOKEN_KEY] = '1000'
    state.tokens = 1000
    const r = await dailyTokenCapGate.check(req)
    expect(r.ok).toBe(false)
    expect((r as { reason: string }).reason).toBe('over_daily_token_cap:1000>=1000')
  })

  // fix/stop-the-bleed: this test used to pin FAIL-OPEN ('0' / '-5' disabled the
  // ceiling). That made one typo in Coolify env silently convert the product's hard
  // spend guarantee into an unbounded spend path — the same invisible-failure class
  // as the 2.83B-token incident. A bad value now FAILS CLOSED (default ceiling), and
  // only the explicit REMO_ORCHESTRATOR_DAILY_TOKEN_CAP_DISABLED flag turns it off.
  test('zero / negative cap FAILS CLOSED — falls back to the default ceiling, still capped', async () => {
    state.tokens = 9_999_999_999
    for (const bad of ['0', '-5']) {
      process.env[TOKEN_KEY] = bad
      expect(await isOverTokenCap('u1', 'UTC')).toBe(true)
      expect((await getTokenCapStatus('u1', 'UTC')).cap).toBe(50_000_000)
    }
  })

  test('only the explicit DISABLED flag turns the ceiling off', async () => {
    delete process.env[TOKEN_KEY]
    state.tokens = 9_999_999_999
    process.env.REMO_ORCHESTRATOR_DAILY_TOKEN_CAP_DISABLED = '1'
    try {
      expect(await isOverTokenCap('u1', 'UTC')).toBe(false)
      expect(await getTokenCapStatus('u1', 'UTC')).toEqual({ over: false, tokens: 0, cap: 0 })
    } finally {
      delete process.env.REMO_ORCHESTRATOR_DAILY_TOKEN_CAP_DISABLED
    }
  })

  test('getTokenCapStatus reports tokens + cap when capped', async () => {
    process.env[TOKEN_KEY] = '500'
    state.tokens = 700
    expect(await getTokenCapStatus('u1', 'UTC')).toEqual({ over: true, tokens: 700, cap: 500 })
  })
})

describe('BSA-04 autospawn launch-count cap', () => {
  test('default cap is 20', () => {
    expect(autospawnDailyLaunchCap()).toBe(20)
  })

  test('blocks at/over the cap, allows under', () => {
    expect(isOverAutospawnDailyLaunchCap(19)).toBe(false)
    expect(isOverAutospawnDailyLaunchCap(20)).toBe(true)
    expect(isOverAutospawnDailyLaunchCap(21)).toBe(true)
  })

  test('honors override + disables on 0/neg (fail-open)', () => {
    process.env[LAUNCH_KEY] = '3'
    expect(autospawnDailyLaunchCap()).toBe(3)
    expect(isOverAutospawnDailyLaunchCap(3)).toBe(true)
    process.env[LAUNCH_KEY] = '0'
    expect(isOverAutospawnDailyLaunchCap(9999)).toBe(false)
  })
})
