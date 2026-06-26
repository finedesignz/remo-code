/**
 * Phase 18 (R-PTY-18, T-18-05) — the opt-in programmatic-credit hard-halt.
 *
 * Asserts:
 *  - the `isOverProgrammaticHalt` predicate is OFF by default (null bound) and
 *    only fires when a configured bound is crossed on a claimed bucket;
 *  - `dailyCostCapGate` extends the SINGLE chokepoint with this predicate: with
 *    the bound crossed, programmatic/automation dispatch is denied with the typed
 *    reason `programmatic_credit_halt`;
 *  - default-off never halts;
 *  - the human interactive PTY path is NOT subject to this denial (it does not
 *    flow through dailyCostCapGate for this reason — the human-only guard +
 *    interactive pool keep it off the programmatic path; asserted via the guard
 *    predicate from gates.ts).
 */
import { describe, test, expect, mock, beforeEach } from 'bun:test'
import { isOverProgrammaticHalt } from '../src/usage/programmatic-leak'
import type { ProgrammaticCredit } from '../src/usage/store'

const claimed = (used: number): ProgrammaticCredit => ({
  used_usd: used, limit_usd: 100, resets_at: 'x', claimed: true,
})

describe('isOverProgrammaticHalt (default-off predicate)', () => {
  test('null/undefined bound => OFF (never halts)', () => {
    expect(isOverProgrammaticHalt(null, claimed(9999))).toBe(false)
    expect(isOverProgrammaticHalt(undefined, claimed(9999))).toBe(false)
  })
  test('non-positive bound => OFF', () => {
    expect(isOverProgrammaticHalt(0, claimed(9999))).toBe(false)
    expect(isOverProgrammaticHalt(-5, claimed(9999))).toBe(false)
  })
  test('bound set + used below => not halted', () => {
    expect(isOverProgrammaticHalt(50, claimed(49.99))).toBe(false)
  })
  test('bound set + used at/over => halted', () => {
    expect(isOverProgrammaticHalt(50, claimed(50))).toBe(true)
    expect(isOverProgrammaticHalt(50, claimed(75))).toBe(true)
  })
  test('absent / unclaimed credit => not halted', () => {
    expect(isOverProgrammaticHalt(50, null)).toBe(false)
    expect(isOverProgrammaticHalt(50, { ...claimed(75), claimed: false })).toBe(false)
  })
})

// ── Gate integration: the halt rides the single dailyCostCapGate ──────────────
const state = {
  cap: '1000.00' as string | null, // high cap so cost-cap never trips here
  tz: 'UTC',
  bound: null as string | null,
  spent: 0,
  used: 0,
}

mock.module('../src/db/postgres.ts', () => ({
  // gates.ts issues three single-row reads (tz, cap, bound). Return a row that
  // satisfies whichever column the query aliases — all keys present.
  sql: async () => [{ cap: state.cap, tz: state.tz, bound: state.bound }],
}))
mock.module('../src/db/token-usage-dal.ts', () => ({
  getTodayTokenCostUsd: async () => state.spent,
  getTodayTokenTotal: async () => 0,
}))
mock.module('../src/usage/store.ts', () => ({
  getUsage: () => ({
    usage: { programmatic_credit: claimed(state.used) },
    updated_at: 'x',
  }),
}))

const gatesUrl = `../src/dispatch/gates.ts?t=${Date.now()}${Math.random()}`
const { dailyCostCapGate, getProgrammaticHaltStatus, humanOnlyRejectsActor } = await import(gatesUrl)
const req = { userId: 'u1', sessionId: 's1', token: 't1', prompt: 'hi' }

beforeEach(() => {
  state.cap = '1000.00'; state.tz = 'UTC'; state.bound = null; state.spent = 0; state.used = 0
})

describe('dailyCostCapGate + hard-halt (single chokepoint)', () => {
  test('default-off (null bound) => never halts', async () => {
    state.used = 9999
    const r = await dailyCostCapGate.check(req)
    expect(r.ok).toBe(true)
  })

  test('bound set + credit crossed => programmatic dispatch denied (typed reason)', async () => {
    state.bound = '50.0000'; state.used = 75
    const r = await dailyCostCapGate.check(req)
    expect(r.ok).toBe(false)
    expect((r as { reason: string }).reason).toBe('programmatic_credit_halt:$75.00>=$50.00')
  })

  test('bound set + credit under bound => allowed', async () => {
    state.bound = '50.0000'; state.used = 49
    const r = await dailyCostCapGate.check(req)
    expect(r.ok).toBe(true)
  })

  test('getProgrammaticHaltStatus reflects config + snapshot', async () => {
    state.bound = '20.0000'; state.used = 25
    const s = await getProgrammaticHaltStatus('u1')
    expect(s).toEqual({ halt: true, bound: 20, used_usd: 25 })
  })

  test('human interactive PTY turn is NOT an automation actor on the PTY surface', () => {
    // The human path does not pass dailyCostCapGate for the halt reason — the
    // human-only guard governs the PTY surface and only rejects automation.
    expect(humanOnlyRejectsActor('human', 'pty-interactive')).toBe(false)
    expect(humanOnlyRejectsActor('scheduler', 'pty-interactive')).toBe(true)
  })
})
