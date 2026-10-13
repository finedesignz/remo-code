/**
 * PTYCAP Phase 2 (`.planning/phases/PTYCAP-02-pty-preflight-gate/`) — the PTY
 * pre-flight gate chain (`hub/src/dispatch/pty-preflight.ts`).
 *
 * SC-1: a programmatic ("automation") PTY turn passes
 *   [thresholdGate, dailyTokenCapGate, dailyCostCapGate, sessionInjectRateGate]
 *   or it does not happen.
 * SC-2: covered by `hub/test/token-cap-coverage.test.ts`'s extended
 *   "known dispatchers" list + its generic `gates: [ ... ]` scan (this file's
 *   `ptyPreflightDispatchConfig` literal is discovered by that scan).
 * SC-3: a human turn is NEVER gated by the inject-rate ceiling.
 *
 * Strategy mirrors `hub/test/cost-cap-real-tokens.test.ts`: mock the leaf DAL/
 * usage modules `gates.ts` calls into, then exercise the REAL gate objects
 * through the REAL `checkPtyTurnPreflight`. `bun run check-baseline` runs each
 * hub/test file in its own process (see tools/regression-baseline.json), so
 * these `mock.module` registrations cannot collide with another test file's.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-chars-long-aaaaaaaa'

import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test'
import { automationControlsLeaf } from './fixtures/automation-controls-leaf.ts'

const state = {
  thresholdAllowed: true,
  cap: '10.00' as string | null,
  tz: 'UTC',
  costSpent: 0,
  tokenTotal: 0,
  injectsInWindow: 0,
  haltBound: null as string | null,
  creditUsed: 0,
  thresholdMode: 'normal' as 'normal' | 'throw' | 'hang',
}

mock.module('../src/usage/threshold.ts', () => ({
  checkUserThreshold: async () => {
    if (state.thresholdMode === 'throw') throw new Error('db down')
    if (state.thresholdMode === 'hang') return new Promise(() => {})
    return state.thresholdAllowed
      ? { allowed: true }
      : {
          allowed: false,
          reason: 'session_threshold',
          utilization_pct: 99,
          threshold_pct: 80,
        }
  },
}))

mock.module('../src/usage/store.ts', () => ({
  getUsage: () => ({ usage: { programmatic_credit: { claimed: true, used_usd: state.creditUsed } } }),
}))

// gates.ts resolves tz + the dollar cap + the programmatic-halt bound via `sql`.
// One generic row satisfies all three call sites (bound is always null here —
// the opt-in programmatic-credit hard-halt stays OFF for these tests).
mock.module('../src/db/postgres.ts', () => ({
  sql: async () => [{ cap: state.cap, tz: state.tz, bound: state.haltBound }],
}))

mock.module('../src/db/token-usage-dal.ts', () => ({
  getTodayTokenCostUsd: async () => state.costSpent,
  getTodayTokenTotal: async () => state.tokenTotal,
}))

mock.module('../src/db/orchestrator-rows-dal.ts', () => ({
  countSessionInjectsSince: async () => state.injectsInWindow,
}))

// PTYCAP-04-04: governed-pty.ts and pty-preflight.ts delegate to the controls
// module. Leaf-mock it with controllable fakes (DB-free); the SQL is proven in
// the automation-controls tests and the CI-only real-Postgres checks.
const ctl = {
  haltScope: null as string | null,
  rateCount: 0,
  reserveMode: 'ok' as 'ok' | 'exhausted' | 'rate' | 'throw' | 'hang',
  reserveCalls: [] as Array<Record<string, unknown>>,
  order: [] as string[],
  ledger: new Set<string>(),
}
async function fakeKillSwitchCheck() {
  ctl.order.push('kill_switch')
  if (ctl.haltScope) return { ok: false as const, reason: `automation_halted:${ctl.haltScope}` }
  return { ok: true as const }
}
async function fakeLifetimeCounterCheck(req: any) {
  ctl.order.push('lifetime_counter')
  if (!req.counterKey) return { ok: false as const, reason: 'lifetime_counter_key_missing' }
  return { ok: true as const }
}
mock.module('../src/dispatch/automation-controls.ts', () => ({
  ...automationControlsLeaf(),
  killSwitchCheck: fakeKillSwitchCheck,
  lifetimeCounterCheck: fakeLifetimeCounterCheck,
  automationKillSwitchGate: { name: 'automation_kill_switch', check: fakeKillSwitchCheck },
  automationLifetimeCounterGate: { name: 'lifetime_counter', check: fakeLifetimeCounterCheck },
  countRateUnion: async () => ctl.rateCount,
  reserveInject: async (args: Record<string, unknown>) => {
    ctl.order.push('reserve')
    ctl.reserveCalls.push(args)
    if (ctl.reserveMode === 'throw') throw new Error('reserve boom')
    if (ctl.reserveMode === 'hang') return new Promise(() => {})
    if (ctl.reserveMode === 'exhausted') return { ok: false, reason: 'lifetime_inject_exhausted:1000>=1000' }
    if (ctl.reserveMode === 'rate') return { ok: false, reason: 'over_session_inject_rate:4>=4' }
    ctl.ledger.add(`${args.counterKey}|${args.token}`)
    return { ok: true }
  },
}))

const modUrl = `../src/dispatch/pty-preflight.ts?t=${Date.now()}${Math.random()}`
const {
  checkPtyTurnPreflight,
  PTY_AUTOMATION_TURN_GATES,
  PTY_HUMAN_TURN_GATES,
  ptyPreflightDispatchConfig,
  isPtySubmit,
  classifyPtyInput,
  _setPtyPreflightTimeoutForTests,
  _resetPtyPreflightTimeoutForTests,
} = await import(modUrl)
const { sessionInjectRateGate } = await import('../src/dispatch/gates.ts')
const {
  _setGovernorsForTests,
  _resetGovernorsForTests,
  PRODUCTION_GOVERNORS,
  tokenCapGovernor,
  injectRateGovernor,
} = await import('../src/dispatch/governed-pty.ts')

const GOVERNED_ENV = ['REMO_GOVERNED_AUTOMATION_PTY', 'REMO_ORCHESTRATOR_MAX_INJECTS_PER_HOUR', 'REMO_ORCHESTRATOR_DAILY_TOKEN_CAP_DISABLED'] as const
const savedEnv: Record<string, string | undefined> = {}

type SpyName = 'kill_switch' | 'token_cap' | 'inject_rate' | 'lifetime_counter'
const SPY_ORDER: SpyName[] = ['kill_switch', 'token_cap', 'inject_rate', 'lifetime_counter']

/** Four all-pass governors that record the order they were checked in. */
function makeSpies(overrides: Partial<Record<SpyName, () => Promise<{ ok: true } | { ok: false; reason: string }>>> = {}) {
  const calls: string[] = []
  const governors = SPY_ORDER.map((name) => ({
    name,
    async check() {
      calls.push(name)
      ctl.order.push(name)
      return overrides[name] ? overrides[name]!() : { ok: true as const }
    },
  }))
  return { calls, governors }
}

beforeEach(() => {
  for (const k of GOVERNED_ENV) {
    savedEnv[k] = process.env[k]
    delete process.env[k]
  }
  _resetGovernorsForTests()
  ctl.haltScope = null
  ctl.rateCount = 0
  ctl.reserveMode = 'ok'
  ctl.reserveCalls.length = 0
  ctl.order.length = 0
  ctl.ledger.clear()
  state.thresholdAllowed = true
  state.cap = '10.00'
  state.tz = 'UTC'
  state.costSpent = 0
  state.tokenTotal = 0
  state.injectsInWindow = 0
  state.haltBound = null
  state.creditUsed = 0
  state.thresholdMode = 'normal'
  _resetPtyPreflightTimeoutForTests()
})

afterEach(() => {
  for (const k of GOVERNED_ENV) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
  _resetGovernorsForTests()
})

describe('PTYCAP Phase 2 — chain shape', () => {
  test('SC-1: automation chain is EXACTLY the ROADMAP order: threshold -> token cap -> cost cap -> inject-rate', () => {
    expect(PTY_AUTOMATION_TURN_GATES.map((g: { name: string }) => g.name)).toEqual([
      'threshold',
      'daily_token_cap',
      'daily_cost_cap',
      'session_inject_rate',
    ])
  })

  test('SC-3: the human chain never contains sessionInjectRateGate', () => {
    expect(PTY_HUMAN_TURN_GATES).not.toContain(sessionInjectRateGate)
    expect(PTY_HUMAN_TURN_GATES.map((g: { name: string }) => g.name)).toEqual([
      'threshold',
      'daily_token_cap',
      'daily_cost_cap',
    ])
  })

  test('SC-2: the scanned literal `gates: [...]` IS the array that runs — not a decorative copy', () => {
    const names = ptyPreflightDispatchConfig.gates.map((g: { name: string }) => g.name)
    expect(names).toContain('daily_token_cap')
    expect(names).toContain('daily_cost_cap')
    // Same object identity: editing the scanned literal edits the real chain.
    expect(PTY_AUTOMATION_TURN_GATES).toBe(ptyPreflightDispatchConfig.gates)
  })

  test('the human chain is the automation chain minus the inject-rate gate (cannot drift apart)', () => {
    expect(PTY_HUMAN_TURN_GATES).toEqual(PTY_AUTOMATION_TURN_GATES.filter((g: unknown) => g !== sessionInjectRateGate))
  })
})

describe('PTYCAP Phase 2 — human turns (SC-3)', () => {
  test('a human turn under every ceiling passes', async () => {
    const r = await checkPtyTurnPreflight({ userId: 'u1', sessionId: 's1', actor: 'human' })
    expect(r.ok).toBe(true)
  })

  test('a human turn over the daily COST cap is blocked', async () => {
    state.costSpent = 999
    const r = await checkPtyTurnPreflight({ userId: 'u1', sessionId: 's1', actor: 'human' })
    expect(r.ok).toBe(false)
    expect((r as { reason: string }).reason).toContain('over_daily_cost_cap')
  })

  test('a human turn over the daily TOKEN cap is blocked', async () => {
    state.tokenTotal = 999_999_999
    const r = await checkPtyTurnPreflight({ userId: 'u1', sessionId: 's1', actor: 'human' })
    expect(r.ok).toBe(false)
    expect((r as { reason: string }).reason).toContain('over_daily_token_cap')
  })

  test('a human turn over the CLAUDE USAGE THRESHOLD is blocked', async () => {
    state.thresholdAllowed = false
    const r = await checkPtyTurnPreflight({ userId: 'u1', sessionId: 's1', actor: 'human' })
    expect(r.ok).toBe(false)
    expect((r as { reason: string }).reason).toContain('quota_threshold_reached')
  })

  test('SC-3 (the absolute): a human turn is NEVER blocked by the inject-rate ceiling, even when it would trip it', async () => {
    state.injectsInWindow = 999_999
    const r = await checkPtyTurnPreflight({ userId: 'u1', sessionId: 's1', actor: 'human' })
    expect(r.ok).toBe(true)
  })
})

const keyed = { counterKey: 'task:T1', turnToken: 'turn-1' } as const

describe('PTYCAP Phase 2 — non-human ("automation") turns (SC-1)', () => {
  // The automation branch is gated by the governed-automation flag (default OFF)
  // and, when ON, runs the spend chain and then the governors. governedAutomationPtyGate
  // rejects every non-eligible source upstream and plan 03-03's caller pin keeps
  // the 'automation' actor inside hub/src/orchestrator/ - these prove the chain
  // ITSELF is correct, with the flag ON and four all-pass spy governors installed.
  beforeEach(() => {
    process.env.REMO_GOVERNED_AUTOMATION_PTY = '1'
    _setGovernorsForTests(makeSpies().governors)
  })

  test('a non-human actor under every ceiling passes the FULL chain', async () => {
    const r = await checkPtyTurnPreflight({ userId: 'u1', sessionId: 's1', actor: 'automation', ...keyed })
    expect(r.ok).toBe(true)
  })

  test('SC-1: a non-human actor over the inject-rate ceiling IS blocked (unlike a human)', async () => {
    state.injectsInWindow = 999_999
    const r = await checkPtyTurnPreflight({ userId: 'u1', sessionId: 's1', actor: 'automation' })
    expect(r.ok).toBe(false)
    expect((r as { reason: string }).reason).toContain('over_session_inject_rate')
  })

  test('a non-human actor over the daily cost cap is blocked', async () => {
    state.costSpent = 999
    const r = await checkPtyTurnPreflight({ userId: 'u1', sessionId: 's1', actor: 'automation' })
    expect(r.ok).toBe(false)
    expect((r as { reason: string }).reason).toContain('over_daily_cost_cap')
  })

  test('gate order — FIRST block wins: threshold fails before the inject-rate check would even run', async () => {
    state.thresholdAllowed = false
    state.injectsInWindow = 999_999 // would ALSO fail — threshold must win, being first
    const r = await checkPtyTurnPreflight({ userId: 'u1', sessionId: 's1', actor: 'automation' })
    expect(r.ok).toBe(false)
    expect((r as { reason: string }).reason).toContain('quota_threshold_reached')
  })
})

describe('PTYCAP Phase 2 — programmatic-credit halt applies to automation only', () => {
  test('a human turn is exempt from the programmatic-credit halt (gates.ts invariant)', async () => {
    state.haltBound = '5'
    state.creditUsed = 50
    const r = await checkPtyTurnPreflight({ userId: 'u1', sessionId: 's1', actor: 'human' })
    expect(r.ok).toBe(true)
  })

  test('an automation turn IS stopped by the same programmatic-credit halt', async () => {
    process.env.REMO_GOVERNED_AUTOMATION_PTY = '1'
    _setGovernorsForTests(makeSpies().governors)
    state.haltBound = '5'
    state.creditUsed = 50
    const r = await checkPtyTurnPreflight({ userId: 'u1', sessionId: 's1', actor: 'automation' })
    expect(r.ok).toBe(false)
    expect((r as { reason: string }).reason).toContain('programmatic_credit_halt')
  })

  test('the halt exemption never exempts a human from the daily cost cap itself', async () => {
    state.haltBound = '5'
    state.creditUsed = 50
    state.costSpent = 999
    const r = await checkPtyTurnPreflight({ userId: 'u1', sessionId: 's1', actor: 'human' })
    expect(r.ok).toBe(false)
    expect((r as { reason: string }).reason).toContain('over_daily_cost_cap')
  })
})

describe('PTYCAP Phase 2 — fail closed', () => {
  test('a gate that THROWS is a rejection, never a pass', async () => {
    state.thresholdMode = 'throw'
    const r = await checkPtyTurnPreflight({ userId: 'u1', sessionId: 's1', actor: 'human' })
    expect(r).toEqual({ ok: false, reason: 'pty_preflight_error' })
  })

  test('a gate that never settles times out as a rejection instead of hanging the writer', async () => {
    state.thresholdMode = 'hang'
    _setPtyPreflightTimeoutForTests(20)
    const r = await checkPtyTurnPreflight({ userId: 'u1', sessionId: 's1', actor: 'human' })
    expect(r).toEqual({ ok: false, reason: 'pty_preflight_timeout' })
  })
})

describe('PTYCAP Phase 3 -- governed automation branch', () => {
  const automation = { userId: 'u1', sessionId: 's1', actor: 'automation', ...keyed } as const

  test('flag OFF: the block precedes every DB gate (a throwing threshold gate does not change the result)', async () => {
    state.thresholdMode = 'throw'
    const r = await checkPtyTurnPreflight(automation)
    expect(r).toEqual({ ok: false, reason: 'automation_blocked_on_pty:automation' })
  })

  test('flag OFF: with every ceiling passing, automation is still refused (OFF admits nothing)', async () => {
    const spies = makeSpies()
    _setGovernorsForTests(spies.governors)
    const r = await checkPtyTurnPreflight(automation)
    expect(r).toEqual({ ok: false, reason: 'automation_blocked_on_pty:automation' })
    expect(spies.calls).toEqual([])
  })

  test('flag ON + production governors: kill switch engaged is refused with the real reason', async () => {
    process.env.REMO_GOVERNED_AUTOMATION_PTY = '1'
    _setGovernorsForTests(PRODUCTION_GOVERNORS)
    ctl.haltScope = 'global'
    const r = await checkPtyTurnPreflight(automation)
    expect(r).toEqual({
      ok: false,
      reason: 'automation_blocked_on_pty:automation:automation_halted:global',
    })
    expect(ctl.reserveCalls).toEqual([])
  })

  test('flag ON + production governors: no counter key is refused lifetime_counter_key_missing, nothing reserved', async () => {
    process.env.REMO_GOVERNED_AUTOMATION_PTY = '1'
    _setGovernorsForTests(PRODUCTION_GOVERNORS)
    const r = await checkPtyTurnPreflight({ userId: 'u1', sessionId: 's1', actor: 'automation', turnToken: 'turn-1' })
    expect(r).toEqual({
      ok: false,
      reason: 'automation_blocked_on_pty:automation:lifetime_counter_key_missing',
    })
    expect(ctl.reserveCalls).toEqual([])
  })

  test('flag ON + four all-pass governors: admitted, governors ran in the fixed order', async () => {
    process.env.REMO_GOVERNED_AUTOMATION_PTY = '1'
    const spies = makeSpies()
    _setGovernorsForTests(spies.governors)
    const r = await checkPtyTurnPreflight(automation)
    expect(r).toEqual({ ok: true })
    expect(spies.calls).toEqual(['kill_switch', 'token_cap', 'inject_rate', 'lifetime_counter'])
  })

  test('flag ON: the spend gates run BEFORE the governors (inject-rate block leaves zero governor calls)', async () => {
    process.env.REMO_GOVERNED_AUTOMATION_PTY = '1'
    const spies = makeSpies()
    _setGovernorsForTests(spies.governors)
    state.injectsInWindow = 999_999
    const r = await checkPtyTurnPreflight(automation)
    expect(r.ok).toBe(false)
    expect((r as { reason: string }).reason).toContain('over_session_inject_rate')
    expect((r as { reason: string }).reason.startsWith('automation_blocked_on_pty')).toBe(false)
    expect(spies.calls).toEqual([])
  })

  test('flag ON: inject-rate cap 0 is refused by the inject_rate governor (the spend gate is fail-open at 0)', async () => {
    process.env.REMO_GOVERNED_AUTOMATION_PTY = '1'
    process.env.REMO_ORCHESTRATOR_MAX_INJECTS_PER_HOUR = '0'
    const passKill = { name: 'kill_switch' as const, check: async () => ({ ok: true as const }) }
    const passLife = { name: 'lifetime_counter' as const, check: async () => ({ ok: true as const }) }
    _setGovernorsForTests([passKill, tokenCapGovernor, injectRateGovernor, passLife])
    const r = await checkPtyTurnPreflight(automation)
    expect(r).toEqual({
      ok: false,
      reason: 'automation_blocked_on_pty:automation:governor_unconfigured:inject_rate',
    })
  })

  test('flag ON: an explicitly disabled daily token cap is refused by the token_cap governor', async () => {
    process.env.REMO_GOVERNED_AUTOMATION_PTY = '1'
    process.env.REMO_ORCHESTRATOR_DAILY_TOKEN_CAP_DISABLED = '1'
    const passKill = { name: 'kill_switch' as const, check: async () => ({ ok: true as const }) }
    const passLife = { name: 'lifetime_counter' as const, check: async () => ({ ok: true as const }) }
    _setGovernorsForTests([passKill, tokenCapGovernor, injectRateGovernor, passLife])
    const r = await checkPtyTurnPreflight(automation)
    expect(r).toEqual({
      ok: false,
      reason: 'automation_blocked_on_pty:automation:governor_unconfigured:token_cap',
    })
  })

  test('flag ON: a governor that THROWS is pty_preflight_error, never a pass', async () => {
    process.env.REMO_GOVERNED_AUTOMATION_PTY = '1'
    _setGovernorsForTests(makeSpies({ kill_switch: async () => { throw new Error('governor down') } }).governors)
    const r = await checkPtyTurnPreflight(automation)
    expect(r).toEqual({ ok: false, reason: 'pty_preflight_error' })
  })

  test('flag ON: a governor that never settles is pty_preflight_timeout', async () => {
    process.env.REMO_GOVERNED_AUTOMATION_PTY = '1'
    _setGovernorsForTests(makeSpies({ kill_switch: () => new Promise(() => {}) }).governors)
    _setPtyPreflightTimeoutForTests(20)
    const r = await checkPtyTurnPreflight(automation)
    expect(r).toEqual({ ok: false, reason: 'pty_preflight_timeout' })
  })
})

describe('PTYCAP Phase 4 -- the door counts the turn', () => {
  const automation = { userId: 'u1', sessionId: 's1', actor: 'automation', ...keyed } as const
  beforeEach(() => {
    process.env.REMO_GOVERNED_AUTOMATION_PTY = '1'
  })

  test('all gates and governors pass: reserve called exactly once AFTER the last governor, with the per-turn token, counter key and enforceRate', async () => {
    _setGovernorsForTests(makeSpies().governors)
    const r = await checkPtyTurnPreflight(automation)
    expect(r).toEqual({ ok: true })
    expect(ctl.reserveCalls).toEqual([
      { userId: 'u1', sessionId: 's1', token: 'turn-1', counterKey: 'task:T1', actor: 'automation', enforceRate: true },
    ])
    expect(ctl.order).toEqual(['kill_switch', 'token_cap', 'inject_rate', 'lifetime_counter', 'reserve'])
  })

  test('missing turnToken: pty_turn_token_missing, reserve not called', async () => {
    _setGovernorsForTests(makeSpies().governors)
    const r = await checkPtyTurnPreflight({ userId: 'u1', sessionId: 's1', actor: 'automation', counterKey: 'task:T1' })
    expect(r).toEqual({ ok: false, reason: 'automation_blocked_on_pty:automation:pty_turn_token_missing' })
    expect(ctl.reserveCalls).toEqual([])
  })

  test('missing counterKey: lifetime_counter_key_missing, reserve not called', async () => {
    _setGovernorsForTests(makeSpies().governors)
    const r = await checkPtyTurnPreflight({ userId: 'u1', sessionId: 's1', actor: 'automation', turnToken: 'turn-1' })
    expect(r).toEqual({ ok: false, reason: 'automation_blocked_on_pty:automation:lifetime_counter_key_missing' })
    expect(ctl.reserveCalls).toEqual([])
  })

  test('reserve returns exhausted: lifetime_inject_exhausted surfaces under the composed prefix', async () => {
    _setGovernorsForTests(makeSpies().governors)
    ctl.reserveMode = 'exhausted'
    const r = await checkPtyTurnPreflight(automation)
    expect(r).toEqual({
      ok: false,
      reason: 'automation_blocked_on_pty:automation:lifetime_inject_exhausted:1000>=1000',
    })
  })

  test('reserve returns the rate reason: over_session_inject_rate surfaces under the composed prefix', async () => {
    _setGovernorsForTests(makeSpies().governors)
    ctl.reserveMode = 'rate'
    const r = await checkPtyTurnPreflight(automation)
    expect(r).toEqual({
      ok: false,
      reason: 'automation_blocked_on_pty:automation:over_session_inject_rate:4>=4',
    })
  })

  test('reserve throws: pty_preflight_error, never a pass', async () => {
    _setGovernorsForTests(makeSpies().governors)
    ctl.reserveMode = 'throw'
    expect(await checkPtyTurnPreflight(automation)).toEqual({ ok: false, reason: 'pty_preflight_error' })
  })

  test('reserve never settles: pty_preflight_timeout', async () => {
    _setGovernorsForTests(makeSpies().governors)
    ctl.reserveMode = 'hang'
    _setPtyPreflightTimeoutForTests(20)
    expect(await checkPtyTurnPreflight(automation)).toEqual({ ok: false, reason: 'pty_preflight_timeout' })
  })

  test('the same turnToken twice: one ledger row (idempotent), both calls ok; a distinct token counts again', async () => {
    _setGovernorsForTests(makeSpies().governors)
    expect(await checkPtyTurnPreflight(automation)).toEqual({ ok: true })
    expect(await checkPtyTurnPreflight(automation)).toEqual({ ok: true })
    expect(ctl.ledger.size).toBe(1)
    expect(await checkPtyTurnPreflight({ ...automation, turnToken: 'turn-2' })).toEqual({ ok: true })
    expect(ctl.ledger.size).toBe(2)
  })

  test('a spend gate or governor block never reserves', async () => {
    _setGovernorsForTests(makeSpies({ inject_rate: async () => ({ ok: false, reason: 'over_session_inject_rate:4>=4' }) }).governors)
    expect((await checkPtyTurnPreflight(automation)).ok).toBe(false)
    state.costSpent = 999
    expect((await checkPtyTurnPreflight(automation)).ok).toBe(false)
    expect(ctl.reserveCalls).toEqual([])
  })

  test('flag OFF: refused before any gate, governor or reserve', async () => {
    delete process.env.REMO_GOVERNED_AUTOMATION_PTY
    _setGovernorsForTests(makeSpies().governors)
    expect(await checkPtyTurnPreflight(automation)).toEqual({ ok: false, reason: 'automation_blocked_on_pty:automation' })
    expect(ctl.reserveCalls).toEqual([])
    expect(ctl.order).toEqual([])
  })

  test('human turns never reserve and never run a governor, even when handed a key and token', async () => {
    _setGovernorsForTests(makeSpies().governors)
    const r = await checkPtyTurnPreflight({ userId: 'u1', sessionId: 's1', actor: 'human', ...keyed })
    expect(r.ok).toBe(true)
    expect(ctl.reserveCalls).toEqual([])
    expect(ctl.order).toEqual([])
  })
})

describe('PTYCAP Phase 3 -- the human chain never runs a governor (D-07)', () => {
  const human = { userId: 'u1', sessionId: 's1', actor: 'human' } as const

  test('no governor is a member of either chain constant, and the human chain names are unchanged', () => {
    for (const g of PRODUCTION_GOVERNORS) {
      expect(PTY_HUMAN_TURN_GATES).not.toContain(g)
      expect(PTY_AUTOMATION_TURN_GATES).not.toContain(g)
    }
    expect(PTY_HUMAN_TURN_GATES.map((g: { name: string }) => g.name)).toEqual([
      'threshold',
      'daily_token_cap',
      'daily_cost_cap',
    ])
  })

  test('flag ON + fail-closed production governors: a human turn under every ceiling still passes', async () => {
    process.env.REMO_GOVERNED_AUTOMATION_PTY = '1'
    _setGovernorsForTests(PRODUCTION_GOVERNORS)
    const r = await checkPtyTurnPreflight(human)
    expect(r.ok).toBe(true)
  })

  test('flag ON + spy governors: a human turn passes and zero governor checks run', async () => {
    process.env.REMO_GOVERNED_AUTOMATION_PTY = '1'
    const spies = makeSpies()
    _setGovernorsForTests(spies.governors)
    const r = await checkPtyTurnPreflight(human)
    expect(r.ok).toBe(true)
    expect(spies.calls).toEqual([])
  })

  test('flag ON: a human turn is never blocked by the inject-rate ceiling (Phase-2 SC-3 preserved)', async () => {
    process.env.REMO_GOVERNED_AUTOMATION_PTY = '1'
    _setGovernorsForTests(PRODUCTION_GOVERNORS)
    state.injectsInWindow = 999_999
    const r = await checkPtyTurnPreflight(human)
    expect(r.ok).toBe(true)
  })
})

describe('PTYCAP Phase 2 — isPtySubmit', () => {
  const b64 = (s: string) => btoa(s)
  test('Enter, and a paste ending in a newline, are submits', () => {
    expect(isPtySubmit(b64('\r'))).toBe(true)
    expect(isPtySubmit(b64('hello world\n'))).toBe(true)
  })
  test('plain typing, Ctrl-C, Esc and arrow keys are NOT submits', () => {
    expect(isPtySubmit(b64('a'))).toBe(false)
    expect(isPtySubmit(b64('\x03'))).toBe(false)
    expect(isPtySubmit(b64('\x1b'))).toBe(false)
    expect(isPtySubmit(b64('\x1b[A'))).toBe(false)
  })
  test('undecodable input fails closed (treated as a submit)', () => {
    expect(isPtySubmit('!!!not base64!!!')).toBe(true)
  })
})

// Security panel (blocking): Enter has encodings with NO CR/LF byte. The Claude
// CLI's key parser maps the kitty/CSI-u sequences `ESC[13u` / `ESC[57414u` to
// "return" whether or not kitty mode was enabled — a bypass of a CR/LF-only
// check. Anything with ESC that is not a known-safe sequence must be checked.
describe('PTYCAP Phase 2 — classifyPtyInput (non-CR/LF encodings of Enter)', () => {
  // UTF-8 encode, as xterm's onData → TextEncoder does, then base64.
  const b64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)))
  test('kitty / CSI-u Enter encodings are submits', () => {
    for (const seq of ['\x1b[13u', '\x1b[57414u', '\x1b[13;1u', '\x1b[13;1:1u', 'hi\x1b[13u']) {
      expect(isPtySubmit(b64(seq))).toBe(true)
    }
  })
  test('keypad Enter in application mode (ESC O M) and C1 CSI/SS3 are submits', () => {
    expect(isPtySubmit(b64('\x1bOM'))).toBe(true)
    expect(isPtySubmit(btoa(String.fromCharCode(0xc2, 0x9b)) )).toBe(true) // U+009B as UTF-8
    expect(isPtySubmit(btoa(String.fromCharCode(0xc2, 0x8f)) )).toBe(true) // U+008F as UTF-8
  })
  // ai-review (codex, blocking): a non-fatal decoder turned a raw C1 byte into
  // U+FFFD, so raw `9b 31 33 75` (8-bit CSI 13u) passed as plain text — while
  // the supervisor writes the raw bytes to the PTY.
  test('raw (non-UTF-8) C1 bytes and any invalid UTF-8 are submits', () => {
    expect(isPtySubmit(btoa(String.fromCharCode(0x9b, 0x31, 0x33, 0x75)))).toBe(true)
    expect(isPtySubmit(btoa(String.fromCharCode(0x8f, 0x4d)))).toBe(true)
    expect(isPtySubmit(btoa(String.fromCharCode(0x61, 0xff)))).toBe(true)
  })
  test('an unknown or incomplete escape fails closed', () => {
    expect(isPtySubmit(b64('\x1b[1'))).toBe(true)
    expect(isPtySubmit(b64('\x1b['))).toBe(true)
    expect(isPtySubmit(b64('\x1bO'))).toBe(true)
    expect(isPtySubmit(b64('\x1b[<0;10;5M'))).toBe(true)
  })
  test('navigation, editing and cancel keys are NOT submits', () => {
    for (const seq of [
      '\x1b[B', '\x1b[C', '\x1b[D', '\x1b[H', '\x1b[F', '\x1b[Z', '\x1b[I', '\x1b[O',
      '\x1b[1;5C', '\x1b[1;2A', '\x1b[3~', '\x1b[5~', '\x1b[6~', '\x1b[3;5~',
      '\x1bOA', '\x1bOH', '\x1b\x1b', '\x7f', '\t', '\x1bb', '\x1b[200~pasted\x1b[201~', 'héllo ✓',
    ]) {
      expect({ seq, submit: isPtySubmit(b64(seq)) }).toEqual({ seq, submit: false })
    }
  })
  test('a trailing lone Esc is carried as the tail; nothing else is', () => {
    expect(classifyPtyInput(b64('\x1b'))).toEqual({ submit: false, tail: '\x1b' })
    expect(classifyPtyInput(b64('abc\x1b\x1b'))).toEqual({ submit: false, tail: '\x1b' })
    expect(classifyPtyInput(b64('\x1b[A'))).toEqual({ submit: false, tail: '' })
  })
  // ai-review (codex, blocking) on 8c0ca80: only a lone ESC was carried, so a
  // checked-and-passed `ESC[` could be completed later by an unchecked `13u`.
  test('ANY open escape prefix is carried as the tail (and is itself a submit)', () => {
    expect(classifyPtyInput(b64('\x1b['))).toEqual({ submit: true, tail: '\x1b[' })
    expect(classifyPtyInput(b64('\x1b[13'))).toEqual({ submit: true, tail: '\x1b[13' })
    expect(classifyPtyInput(b64('\x1bO'))).toEqual({ submit: true, tail: '\x1bO' })
    expect(classifyPtyInput(b64('go\r\x1b['))).toEqual({ submit: true, tail: '\x1b[' }) // tail kept after a CR
    expect(classifyPtyInput(b64('3'), '\x1b[1')).toEqual({ submit: true, tail: '\x1b[13' })
    expect(classifyPtyInput(b64('u'), '\x1b[13').submit).toBe(true)
    expect(classifyPtyInput(b64('A'), '\x1b[')).toEqual({ submit: false, tail: '' }) // completes to an arrow
    expect(classifyPtyInput(b64('\x1b[' + '1'.repeat(200))).tail.length).toBe(64)
  })
  test('a sequence SPLIT across frames is judged joined with the previous tail', () => {
    expect(classifyPtyInput(b64('[13u'), '\x1b').submit).toBe(true)
    expect(classifyPtyInput(b64('OM'), '\x1b').submit).toBe(true)
    expect(classifyPtyInput(b64('[A'), '\x1b')).toEqual({ submit: false, tail: '' })
    expect(classifyPtyInput(b64('h'), '\x1b')).toEqual({ submit: false, tail: '' }) // Alt+h
    expect(classifyPtyInput(b64('[13u')).submit).toBe(false) // without a tail it is plain text
  })
  // QC panel (security lens, run 3): the "Alt+printable" catch-all let ESC +
  // a C1 string-introducer (OSC/DCS/SOS/PM/APC), and ESC + 'E' (7-bit NEL),
  // through as harmless Alt+key input, and no ESC prefix at all was required
  // for the Unicode NEL/LS/PS codepoints — real bypasses of the "unknown
  // escape = possible submit" fail-closed design this module documents.
  test('C1 string-introducer escapes (OSC/DCS/SOS/PM/APC) are submits, not Alt+printable', () => {
    expect(isPtySubmit(b64('\x1b]0;pwned\x07'))).toBe(true) // OSC
    expect(isPtySubmit(b64('\x1bPqDATA\x1b\\'))).toBe(true) // DCS
    expect(isPtySubmit(b64('\x1bXsos\x1b\\'))).toBe(true) // SOS
    expect(isPtySubmit(b64('\x1b^pm\x1b\\'))).toBe(true) // PM
    expect(isPtySubmit(b64('\x1b_apc\x1b\\'))).toBe(true) // APC
  })
  test('7-bit NEL (ESC E) is a submit', () => {
    expect(isPtySubmit(b64('\x1bE'))).toBe(true)
  })
  test('standalone Unicode line/paragraph separators are submits with no ESC prefix', () => {
    expect(isPtySubmit(b64('\u0085'))).toBe(true) // NEL
    expect(isPtySubmit(b64(' '))).toBe(true) // LINE SEPARATOR
    expect(isPtySubmit(b64(' '))).toBe(true) // PARAGRAPH SEPARATOR
    expect(isPtySubmit(b64('plain text\u0085more'))).toBe(true)
  })
  test('ordinary Alt+printable is unaffected by the narrower catch-all', () => {
    for (const seq of ['\x1bh', '\x1ba', '\x1b1', '\x1b~']) {
      expect({ seq, submit: isPtySubmit(b64(seq)) }).toEqual({ seq, submit: false })
    }
  })
})
