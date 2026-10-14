/**
 * PTYCAP Phase 3 (`.planning/phases/PTYCAP-03-governed-automation-guard/`) --
 * `governedAutomationPtyGate` (hub/src/dispatch/governed-pty.ts).
 *
 * SC-3: with REMO_GOVERNED_AUTOMATION_PTY unset/garbage the gate is a TRUE no-op
 *   versus the legacy human-only decision. `legacyDecision` below is a FROZEN
 *   COPY of that legacy semantics (deliberately NOT imported from production
 *   code) so it is an independent oracle.
 * SC-1 (structural): an eligible actor is admitted only when every governor
 *   passes -- provable only under the test-only DI setter, because the
 *   production kill_switch / lifetime_counter slots fail closed in Phase 3.
 *
 * DB-free: no DB access and no skipped tests (D-13).
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-chars-long-aaaaaaaa'

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import {
  governedAutomationEnabled,
  governedAutomationPtyGate,
  killSwitchGovernor,
  tokenCapGovernor,
  injectRateGovernor,
  lifetimeCounterGovernor,
  PRODUCTION_GOVERNORS,
  GOVERNOR_ORDER,
  activeGovernors,
  _setGovernorsForTests,
  _resetGovernorsForTests,
  type GovernorGate,
} from '../src/dispatch/governed-pty.ts'
import * as governedNs from '../src/dispatch/governed-pty.ts'
import * as gatesNs from '../src/dispatch/gates.ts'
import { AUTOMATION_ACTORS, isDailyTokenCapEnforced } from '../src/dispatch/gates.ts'

type Decision = { ok: true } | { ok: false; reason: string }

/** FROZEN legacy oracle -- the pre-Phase-3 humanOnlyPtyGate decision, by value. */
function legacyDecision(actor: string, runnerType: string): Decision {
  if (runnerType !== 'pty-interactive') return { ok: true }
  if (actor !== 'human') return { ok: false, reason: 'automation_blocked_on_pty:' + actor }
  return { ok: true }
}

const FLAG = 'REMO_GOVERNED_AUTOMATION_PTY'
const ENV_KEYS = [
  FLAG,
  'REMO_ORCHESTRATOR_DAILY_TOKEN_CAP_DISABLED',
  'REMO_ORCHESTRATOR_MAX_INJECTS_PER_HOUR',
]
const saved: Record<string, string | undefined> = {}

const baseReq = { userId: 'u1', sessionId: 's1', token: 't1', prompt: 'hi' }

/** Spy governor: records its name into `calls`, optionally blocks / throws. */
function spy(
  name: GovernorGate['name'],
  calls: string[],
  mode: 'pass' | { block: string } | 'throw' = 'pass',
): GovernorGate {
  return {
    name,
    async check() {
      calls.push(name)
      if (mode === 'throw') throw new Error('boom:' + name)
      if (mode !== 'pass') return { ok: false, reason: mode.block }
      return { ok: true }
    },
  }
}

function allPass(calls: string[]): GovernorGate[] {
  return [
    spy('kill_switch', calls),
    spy('token_cap', calls),
    spy('inject_rate', calls),
    spy('lifetime_counter', calls),
  ]
}

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k]
    delete process.env[k]
  }
  _resetGovernorsForTests()
})

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  _resetGovernorsForTests()
})

const OFF_VALUES: Array<string | undefined> = [
  undefined, '', ' ', '0', 'false', 'off', 'no', '2', 'enabled', 'tru', 'y',
]
const ACTORS = [
  'human', 'scheduler', 'orchestrator-background', 'auto-dev', 'error-capture', 'agent',
  'external-ask', 'external-work', 'unknown-actor', '', 'Human', 'HUMAN', 'human ',
]
const RUNNER_TYPES = ['pty-interactive', 'stream-json', 'codex', '', 'PTY-INTERACTIVE', 'unknown']

describe('PTYCAP Phase 3 -- OFF == legacy differential (SC-3, D-04)', () => {
  for (const off of OFF_VALUES) {
    test(`flag ${off === undefined ? '<unset>' : JSON.stringify(off)}: full (actor x runnerType) matrix matches the frozen legacy oracle; resolver called once; zero governors`, async () => {
      const calls: string[] = []
      _setGovernorsForTests(allPass(calls))
      if (off === undefined) delete process.env[FLAG]
      else process.env[FLAG] = off
      let compared = 0
      for (const actor of ACTORS) {
        for (const runnerType of RUNNER_TYPES) {
          let resolverCalls = 0
          const gate = governedAutomationPtyGate(async () => {
            resolverCalls++
            return { actor, runnerType }
          })
          const got = await gate.check(baseReq as any)
          expect(got).toEqual(legacyDecision(actor, runnerType))
          expect(resolverCalls).toBe(1)
          compared++
        }
      }
      expect(compared).toBe(ACTORS.length * RUNNER_TYPES.length)
      expect(calls).toEqual([])
    })
  }
})

describe('PTYCAP Phase 3 -- flag parsing (D-04)', () => {
  test('governedAutomationEnabled is true only for 1|true|yes|on (case-insensitive, trimmed)', () => {
    for (const on of ['1', 'true', 'TRUE', ' yes ', 'On']) {
      process.env[FLAG] = on
      expect(governedAutomationEnabled()).toBe(true)
    }
    for (const off of OFF_VALUES) {
      if (off === undefined) delete process.env[FLAG]
      else process.env[FLAG] = off
      expect(governedAutomationEnabled()).toBe(false)
    }
  })
})

describe('PTYCAP Phase 3 -- production governors with the flag ON (D-02, D-06)', () => {
  test('production list: scheduler on a pty-interactive session is blocked by the fail-closed kill_switch slot', async () => {
    process.env[FLAG] = '1'
    const gate = governedAutomationPtyGate(async () => ({ actor: 'scheduler', runnerType: 'pty-interactive' }))
    expect(await gate.check(baseReq as any)).toEqual({
      ok: false,
      reason: 'automation_blocked_on_pty:scheduler:governor_not_implemented:kill_switch',
    })
  })

  test('external-ask / external-work / empty / unknown actors keep the legacy reason, zero governor calls, even with every governor passing', async () => {
    process.env[FLAG] = '1'
    const calls: string[] = []
    _setGovernorsForTests(allPass(calls))
    for (const actor of ['external-ask', 'external-work', '', 'unknown-actor']) {
      const gate = governedAutomationPtyGate(async () => ({ actor, runnerType: 'pty-interactive' }))
      expect(await gate.check(baseReq as any)).toEqual({
        ok: false,
        reason: 'automation_blocked_on_pty:' + actor,
      })
    }
    expect(calls).toEqual([])
  })
})

const sched = (runnerType = 'pty-interactive') =>
  governedAutomationPtyGate(async () => ({ actor: 'scheduler', runnerType }))

describe('PTYCAP Phase 3 -- governor order and first-block-wins (D-02)', () => {
  test('flag ON + four all-pass governors: ok, evaluated in the fixed order', async () => {
    process.env[FLAG] = '1'
    const calls: string[] = []
    _setGovernorsForTests(allPass(calls))
    expect(await sched().check(baseReq as any)).toEqual({ ok: true })
    expect(calls).toEqual(['kill_switch', 'token_cap', 'inject_rate', 'lifetime_counter'])
  })

  test('the first blocking governor wins and later governors are not invoked', async () => {
    process.env[FLAG] = '1'
    const calls: string[] = []
    _setGovernorsForTests([
      spy('kill_switch', calls),
      spy('token_cap', calls, { block: 'x' }),
      spy('inject_rate', calls),
      spy('lifetime_counter', calls),
    ])
    expect(await sched().check(baseReq as any)).toEqual({
      ok: false,
      reason: 'automation_blocked_on_pty:scheduler:x',
    })
    expect(calls).toEqual(['kill_switch', 'token_cap'])
  })

  test('PRODUCTION_GOVERNORS names equal GOVERNOR_ORDER; the dollar cost cap is not a governor', () => {
    const names = PRODUCTION_GOVERNORS.map((g) => g.name)
    expect(names).toEqual([...GOVERNOR_ORDER])
    expect(names).toEqual(['kill_switch', 'token_cap', 'inject_rate', 'lifetime_counter'])
    expect(names).not.toContain('daily_cost_cap' as any)
  })

  test('every AUTOMATION_ACTORS member is admitted with the flag ON and four all-pass governors (admit path exists under DI)', async () => {
    process.env[FLAG] = '1'
    _setGovernorsForTests(allPass([]))
    expect(AUTOMATION_ACTORS.size).toBeGreaterThan(0)
    for (const actor of AUTOMATION_ACTORS) {
      const gate = governedAutomationPtyGate(async () => ({ actor, runnerType: 'pty-interactive' }))
      expect(await gate.check(baseReq as any)).toEqual({ ok: true })
    }
  })
})

describe('PTYCAP Phase 3 -- enabled rule (D-03)', () => {
  const enabledChain = (calls: string[]): GovernorGate[] => [
    spy('kill_switch', calls),
    tokenCapGovernor,
    injectRateGovernor,
    spy('lifetime_counter', calls),
  ]

  test('default env: token_cap and inject_rate are enabled, chain admits', async () => {
    process.env[FLAG] = '1'
    _setGovernorsForTests(enabledChain([]))
    expect(await sched().check(baseReq as any)).toEqual({ ok: true })
  })

  test('token cap explicitly disabled (1|true|yes|on) blocks governor_unconfigured:token_cap', async () => {
    process.env[FLAG] = '1'
    _setGovernorsForTests(enabledChain([]))
    for (const v of ['1', 'true', 'yes', 'on']) {
      process.env.REMO_ORCHESTRATOR_DAILY_TOKEN_CAP_DISABLED = v
      const r = await sched().check(baseReq as any)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.reason.endsWith(':governor_unconfigured:token_cap')).toBe(true)
    }
  })

  test('inject-rate ceiling 0, negative, garbage, NaN or Infinity blocks governor_unconfigured:inject_rate', async () => {
    process.env[FLAG] = '1'
    _setGovernorsForTests(enabledChain([]))
    for (const v of ['0', '-1', 'garbage', 'NaN', 'Infinity', '-Infinity']) {
      process.env.REMO_ORCHESTRATOR_MAX_INJECTS_PER_HOUR = v
      const r = await sched().check(baseReq as any)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.reason.endsWith(':governor_unconfigured:inject_rate')).toBe(true)
    }
  })

  test('isDailyTokenCapEnforced: unset true; 1|TRUE|" on " false; 0 and garbage true', () => {
    expect(isDailyTokenCapEnforced()).toBe(true)
    for (const v of ['1', 'TRUE', ' on ']) {
      process.env.REMO_ORCHESTRATOR_DAILY_TOKEN_CAP_DISABLED = v
      expect(isDailyTokenCapEnforced()).toBe(false)
    }
    for (const v of ['0', 'garbage']) {
      process.env.REMO_ORCHESTRATOR_DAILY_TOKEN_CAP_DISABLED = v
      expect(isDailyTokenCapEnforced()).toBe(true)
    }
  })
})

describe('PTYCAP Phase 3 -- fail-closed slots, throw, non-PTY, DI-only, no alias', () => {
  test('lifetime_counter slot fails closed even when every other governor passes', async () => {
    process.env[FLAG] = '1'
    _setGovernorsForTests([spy('kill_switch', []), tokenCapGovernor, injectRateGovernor, lifetimeCounterGovernor])
    expect(await sched().check(baseReq as any)).toEqual({
      ok: false,
      reason: 'automation_blocked_on_pty:scheduler:governor_not_implemented:lifetime_counter',
    })
  })

  test('the production kill_switch and lifetime_counter bodies always block with governor_not_implemented', async () => {
    expect(await killSwitchGovernor.check(baseReq as any)).toEqual({
      ok: false,
      reason: 'governor_not_implemented:kill_switch',
    })
    expect(await lifetimeCounterGovernor.check(baseReq as any)).toEqual({
      ok: false,
      reason: 'governor_not_implemented:lifetime_counter',
    })
  })

  test('a governor that throws yields a typed governor_error denial, never a pass (D-14)', async () => {
    process.env[FLAG] = '1'
    const calls: string[] = []
    _setGovernorsForTests([
      spy('kill_switch', calls, 'throw'),
      spy('token_cap', calls),
      spy('inject_rate', calls),
      spy('lifetime_counter', calls),
    ])
    expect(await sched().check(baseReq as any)).toEqual({
      ok: false,
      reason: 'automation_blocked_on_pty:scheduler:governor_error:kill_switch',
    })
    expect(calls).toEqual(['kill_switch'])
  })

  test('a non-PTY runner type is ok without consulting any governor, flag ON (D-17)', async () => {
    process.env[FLAG] = '1'
    const calls: string[] = []
    _setGovernorsForTests(allPass(calls))
    expect(await sched('stream-json').check(baseReq as any)).toEqual({ ok: true })
    expect(calls).toEqual([])
  })

  test('governors are injectable only through the test setter; reset restores PRODUCTION_GOVERNORS; the gate takes exactly one parameter (D-02)', () => {
    _setGovernorsForTests(allPass([]))
    expect(activeGovernors()).not.toBe(PRODUCTION_GOVERNORS)
    _resetGovernorsForTests()
    expect(activeGovernors()).toBe(PRODUCTION_GOVERNORS)
    expect(governedAutomationPtyGate.length).toBe(1)
  })

  test('hard rename (D-05): no humanOnlyPtyGate key in gates.ts or governed-pty.ts; the gate name is governed_automation_pty', () => {
    expect(Object.keys(gatesNs)).not.toContain('humanOnlyPtyGate')
    expect(Object.keys(governedNs)).not.toContain('humanOnlyPtyGate')
    expect(sched().name).toBe('governed_automation_pty')
  })
})
