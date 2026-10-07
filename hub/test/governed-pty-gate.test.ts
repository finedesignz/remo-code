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
  _setGovernorsForTests,
  _resetGovernorsForTests,
  type GovernorGate,
} from '../src/dispatch/governed-pty.ts'

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
