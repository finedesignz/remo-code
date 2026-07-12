/**
 * The daily TOKEN cap must actually FIRE (fix/stop-the-bleed, CONCERNS item 1/4).
 *
 * 2026-07-11: a wedged orchestrator tick loop burned ~1.4 BILLION tokens/day
 * against a 50M default ceiling — 28x over — and killed the owner's
 * subscription. The gate existed and was in the inject gate list; it never fired,
 * because `getTodayTokenTotal` counted only input+output while the burn was
 * almost entirely CACHE-READ (#335, fixed by #342). Nobody had ever proven the
 * gate BLOCKS.
 *
 * Pure-logic proof here (the deps are mocked); the same predicate is proven
 * end-to-end against real Postgres + the real dispatch pipeline in
 * hub/test/e2e/orchestrator-tokencap.e2e.test.ts.
 */
import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test'

const state = {
  tz: 'UTC',
  /** what getTodayTokenTotal reports (all four buckets, post-#342). */
  tokens: 0,
}

mock.module('../src/db/postgres.ts', () => ({
  sql: async () => [{ tz: state.tz, cap: '100000.00', bound: null }],
}))
mock.module('../src/db/token-usage-dal.ts', () => ({
  getTodayTokenCostUsd: async () => 0,
  getTodayTokenTotal: async () => state.tokens,
}))

const gatesUrl = `../src/dispatch/gates.ts?t=${Date.now()}${Math.random()}`
const { dailyTokenCapGate, getTokenCapStatus, isOverTokenCap, assertTokenCapConfig } = await import(gatesUrl)

const req = { userId: 'u1', sessionId: 's1', token: 't1', prompt: 'hi' }
const DEFAULT_CAP = 50_000_000

beforeEach(() => {
  state.tz = 'UTC'
  state.tokens = 0
  delete process.env.REMO_ORCHESTRATOR_DAILY_TOKEN_CAP
})

afterEach(() => {
  delete process.env.REMO_ORCHESTRATOR_DAILY_TOKEN_CAP
})

describe('dailyTokenCapGate fires', () => {
  test('ships a 50M default ceiling', async () => {
    state.tokens = 1
    expect((await getTokenCapStatus('u1', 'UTC')).cap).toBe(DEFAULT_CAP)
  })

  test('allows under the cap', async () => {
    state.tokens = DEFAULT_CAP - 1
    expect((await dailyTokenCapGate.check(req)).ok).toBe(true)
  })

  test('BLOCKS at the boundary (tokens >= cap)', async () => {
    state.tokens = DEFAULT_CAP
    const r = await dailyTokenCapGate.check(req)
    expect(r.ok).toBe(false)
    expect((r as { reason: string }).reason).toBe(`over_daily_token_cap:${DEFAULT_CAP}>=${DEFAULT_CAP}`)
  })

  test('BLOCKS the incident shape: 1.4B tokens/day, 28x the ceiling', async () => {
    state.tokens = 1_400_000_000
    const r = await dailyTokenCapGate.check(req)
    expect(r.ok).toBe(false)
    expect((r as { reason: string }).reason).toBe(`over_daily_token_cap:1400000000>=${DEFAULT_CAP}`)
    expect(await isOverTokenCap('u1', 'UTC')).toBe(true)
  })

  test('honours REMO_ORCHESTRATOR_DAILY_TOKEN_CAP at call time', async () => {
    process.env.REMO_ORCHESTRATOR_DAILY_TOKEN_CAP = '1000'
    state.tokens = 1_500
    expect((await dailyTokenCapGate.check(req)).ok).toBe(false)
    state.tokens = 500
    expect((await dailyTokenCapGate.check(req)).ok).toBe(true)
  })

  // SAFETY: a bad cap value must FAIL CLOSED. The previous behaviour — '0' or '-1'
  // silently DISABLING the ceiling — meant one typo in Coolify env turned the
  // product's headline guarantee ("a hard spend ceiling you set") into an unbounded
  // spend path, invisibly. That is the same class of failure as the 2.83B-token
  // incident, and the old test PINNED it. It does not any more.
  test('a non-positive / unparseable cap FAILS CLOSED (falls back to the default, still capped)', async () => {
    state.tokens = 9_999_999_999
    for (const bad of ['0', '-1', 'nonsense', '5O']) {
      process.env.REMO_ORCHESTRATOR_DAILY_TOKEN_CAP = bad
      const r = await dailyTokenCapGate.check(req)
      expect(r.ok).toBe(false) // still blocking — the ceiling is NOT disabled
      expect((await getTokenCapStatus('u1', 'UTC')).cap).toBe(DEFAULT_CAP)
    }
  })

  test('a bad cap value REFUSES TO BOOT (assertTokenCapConfig throws)', () => {
    for (const bad of ['0', '-1', 'nonsense']) {
      process.env.REMO_ORCHESTRATOR_DAILY_TOKEN_CAP = bad
      expect(() => assertTokenCapConfig()).toThrow(/positive/i)
    }
    process.env.REMO_ORCHESTRATOR_DAILY_TOKEN_CAP = '1000'
    expect(() => assertTokenCapConfig()).not.toThrow()
    delete process.env.REMO_ORCHESTRATOR_DAILY_TOKEN_CAP
    expect(() => assertTokenCapConfig()).not.toThrow() // unset ⇒ 50M default
  })

  test('the ONLY way to disable the ceiling is the explicit, self-describing flag', async () => {
    state.tokens = 9_999_999_999
    process.env.REMO_ORCHESTRATOR_DAILY_TOKEN_CAP_DISABLED = '1'
    try {
      expect((await dailyTokenCapGate.check(req)).ok).toBe(true)
      expect((await getTokenCapStatus('u1', 'UTC')).cap).toBe(0)
      expect(() => assertTokenCapConfig()).not.toThrow() // deliberate ⇒ boots (loudly)
    } finally {
      delete process.env.REMO_ORCHESTRATOR_DAILY_TOKEN_CAP_DISABLED
    }
    // And with the flag gone, the ceiling is back.
    expect((await dailyTokenCapGate.check(req)).ok).toBe(false)
  })
})
