/**
 * 2026-07 incident gates:
 *  (a) a day whose token usage is almost entirely cache_read TRIPS the daily
 *      token cap (cache-read is billed against the subscription rate limit), and
 *  (b) `sessionInjectRateGate` blocks the 5th orchestrator inject inside an hour
 *      (default cap 4) and allows it again once the rolling window has passed.
 *
 * Data deps are mocked, so this is pure gate-logic + reason-string coverage.
 */
import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test'

const state = {
  tz: 'UTC',
  tokens: 0,
  injectsInWindow: 0,
}

mock.module('../src/db/postgres.ts', () => ({
  sql: async () => [{ tz: state.tz, cap: '10.00' }],
}))
mock.module('../src/db/token-usage-dal.ts', () => ({
  getTodayTokenTotal: async () => state.tokens,
  getTodayTokenCostUsd: async () => 0,
}))
mock.module('../src/db/orchestrator-rows-dal.ts', () => ({
  countSessionInjectsSince: async () => state.injectsInWindow,
}))

const RATE_KEY = 'REMO_ORCHESTRATOR_MAX_INJECTS_PER_HOUR'
const TOKEN_KEY = 'REMO_ORCHESTRATOR_DAILY_TOKEN_CAP'
const origRate = process.env[RATE_KEY]
const origToken = process.env[TOKEN_KEY]

const gatesUrl = `../src/dispatch/gates.ts?t=${Date.now()}${Math.random()}`
const { dailyTokenCapGate, sessionInjectRateGate, maxInjectsPerHour } = await import(gatesUrl)

const req = { userId: 'u1', sessionId: 's1', token: 't1', prompt: 'hi' }

beforeEach(() => {
  state.tz = 'UTC'
  state.tokens = 0
  state.injectsInWindow = 0
  delete process.env[RATE_KEY]
  delete process.env[TOKEN_KEY]
})
afterEach(() => {
  if (origRate === undefined) delete process.env[RATE_KEY]
  else process.env[RATE_KEY] = origRate
  if (origToken === undefined) delete process.env[TOKEN_KEY]
  else process.env[TOKEN_KEY] = origToken
})

describe('daily token cap — cache-dominated day', () => {
  test('a day that is ~all cache_read trips the 50M default cap', async () => {
    // The incident shape: 214K real I/O tokens, 2.83B cache_read. The old
    // I/O-only sum (214_000) was nowhere near the cap; the all-buckets sum is.
    state.tokens = 214_000 + 2_830_000_000
    const r = await dailyTokenCapGate.check(req)
    expect(r.ok).toBe(false)
    expect((r as { reason: string }).reason).toBe('over_daily_token_cap:2830214000>=50000000')
  })

  test('the same day counted I/O-only (pre-fix) would NOT have tripped', async () => {
    state.tokens = 214_000 // what the pre-fix SQL summed
    expect((await dailyTokenCapGate.check(req)).ok).toBe(true)
  })
})

describe('sessionInjectRateGate', () => {
  test('default cap is 4 injects/hour', () => {
    expect(maxInjectsPerHour()).toBe(4)
  })

  test('allows injects 1-4 in the hour', async () => {
    for (const n of [0, 1, 2, 3]) {
      state.injectsInWindow = n
      expect((await sessionInjectRateGate.check(req)).ok).toBe(true)
    }
  })

  test('blocks the 5th inject inside the hour', async () => {
    state.injectsInWindow = 4
    const r = await sessionInjectRateGate.check(req)
    expect(r.ok).toBe(false)
    expect((r as { reason: string }).reason).toBe('over_session_inject_rate:4>=4')
  })

  test('allows again once the trailing-hour window has passed (rows aged out)', async () => {
    state.injectsInWindow = 4
    expect((await sessionInjectRateGate.check(req)).ok).toBe(false)
    state.injectsInWindow = 0 // an hour later the window is empty
    expect((await sessionInjectRateGate.check(req)).ok).toBe(true)
  })

  test('honors REMO_ORCHESTRATOR_MAX_INJECTS_PER_HOUR override', async () => {
    process.env[RATE_KEY] = '2'
    state.injectsInWindow = 2
    const r = await sessionInjectRateGate.check(req)
    expect(r.ok).toBe(false)
    expect((r as { reason: string }).reason).toBe('over_session_inject_rate:2>=2')
  })

  test('zero / negative / garbage-free disable semantics (fail-open)', async () => {
    state.injectsInWindow = 10_000
    process.env[RATE_KEY] = '0'
    expect((await sessionInjectRateGate.check(req)).ok).toBe(true)
    process.env[RATE_KEY] = '-1'
    expect((await sessionInjectRateGate.check(req)).ok).toBe(true)
    process.env[RATE_KEY] = 'nonsense' // non-finite ⇒ default 4 ⇒ still capped
    expect((await sessionInjectRateGate.check(req)).ok).toBe(false)
  })
})
