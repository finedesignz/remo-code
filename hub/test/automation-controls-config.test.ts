/**
 * PTYCAP-04: env parsing, boot assertions and drift pins for automation-controls.
 * DB-free: the sql tag is a fake; the drift tests import the ORIGINALS the
 * controls module duplicates (to avoid a gates.ts import cycle, D-11).
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createFakeSql } from './fixtures/automation-fake-sql.ts'

const fake = createFakeSql()
const { state } = fake
mock.module('../src/db/postgres.ts', () => ({ sql: fake.sql }))

const C = await import(`../src/dispatch/automation-controls.ts?t=${Date.now()}`)
const gates = await import(`../src/dispatch/gates.ts?t=${Date.now()}`)
const { INJECT_OUTCOMES } = await import(`../src/db/orchestrator-rows-dal.ts?t=${Date.now()}`)
const pipeline = await import(`../src/dispatch/pipeline.ts?t=${Date.now()}`)

const KEYS = ['REMO_AUTOMATION_LIFETIME_INJECT_CAP', 'REMO_TOKEN_CAP_ALARM_PCT', 'REMO_ORCHESTRATOR_MAX_INJECTS_PER_HOUR']
const saved: Record<string, string | undefined> = {}
beforeEach(() => {
  for (const k of KEYS) {
    saved[k] = process.env[k]
    delete process.env[k]
  }
  state.tables = { ledger: true, kill_switch: true, alarms: true }
})
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})
afterAll(() => {
  mock.restore()
})

describe('lifetimeInjectCap', () => {
  test('unset gives 1000', () => {
    expect(C.lifetimeInjectCap()).toBe(1000)
    expect(C.DEFAULT_LIFETIME_INJECT_CAP).toBe(1000)
  })
  test('a positive finite number is accepted', () => {
    process.env.REMO_AUTOMATION_LIFETIME_INJECT_CAP = '37'
    expect(C.lifetimeInjectCap()).toBe(37)
  })
  test('garbage, zero or negative give 1000 (never unbounded)', () => {
    for (const bad of ['abc', '0', '-5', 'NaN', 'Infinity', '  ']) {
      process.env.REMO_AUTOMATION_LIFETIME_INJECT_CAP = bad
      expect(C.lifetimeInjectCap()).toBe(1000)
    }
  })
})

describe('alarmPct', () => {
  test('default 60; garbage is 60 (never off); clamped into (0,100]', () => {
    expect(C.alarmPct()).toBe(60)
    for (const bad of ['x', '0', '-3']) {
      process.env.REMO_TOKEN_CAP_ALARM_PCT = bad
      expect(C.alarmPct()).toBe(60)
    }
    process.env.REMO_TOKEN_CAP_ALARM_PCT = '75'
    expect(C.alarmPct()).toBe(75)
    process.env.REMO_TOKEN_CAP_ALARM_PCT = '250'
    expect(C.alarmPct()).toBe(100)
  })
})

describe('drift pins against the originals', () => {
  test('sessionInjectRateCap equals gates.maxInjectsPerHour for unset, numeric, zero, negative and garbage', () => {
    const cases: Array<string | undefined> = [undefined, '', '  ', '7', '0', '-2', '2.5', 'abc', 'Infinity']
    for (const v of cases) {
      if (v === undefined) delete process.env.REMO_ORCHESTRATOR_MAX_INJECTS_PER_HOUR
      else process.env.REMO_ORCHESTRATOR_MAX_INJECTS_PER_HOUR = v
      expect(C.sessionInjectRateCap()).toBe(gates.maxInjectsPerHour())
    }
  })

  test('RATE_INJECT_OUTCOMES equals INJECT_OUTCOMES from orchestrator-rows-dal', () => {
    expect([...C.RATE_INJECT_OUTCOMES]).toEqual([...INJECT_OUTCOMES])
  })

  test('gate-name constants match pipeline.ts and gates.ts', () => {
    expect(C.AUTOMATION_KILL_SWITCH_GATE_NAME).toBe(pipeline.KILL_SWITCH_GATE_NAME)
    expect(gates.sessionInjectRateGate.name).toBe(pipeline.SESSION_INJECT_RATE_GATE_NAME)
  })

  test('import discipline: no gates.ts / governed-pty.ts import; pipeline.ts has no top-level controls import', () => {
    const src = readFileSync(join(import.meta.dir, '..', 'src', 'dispatch', 'automation-controls.ts'), 'utf8')
    expect(src).not.toMatch(/from '\.\/gates/)
    expect(src).not.toMatch(/from '\.\/governed-pty/)
    const pipe = readFileSync(join(import.meta.dir, '..', 'src', 'dispatch', 'pipeline.ts'), 'utf8')
    expect(pipe).not.toMatch(/^import[^\n]*automation-controls/m)
  })
})

describe('assertAutomationControlsEnv', () => {
  test('a bad lifetime cap throws naming the env var and saying the hub refuses to boot', () => {
    process.env.REMO_AUTOMATION_LIFETIME_INJECT_CAP = 'lots'
    expect(() => C.assertAutomationControlsEnv()).toThrow(/REMO_AUTOMATION_LIFETIME_INJECT_CAP/)
    expect(() => C.assertAutomationControlsEnv()).toThrow(/refuses to boot/)
    process.env.REMO_AUTOMATION_LIFETIME_INJECT_CAP = '-1'
    expect(() => C.assertAutomationControlsEnv()).toThrow(/REMO_AUTOMATION_LIFETIME_INJECT_CAP/)
  })

  test('unset or valid cap does not throw', () => {
    expect(() => C.assertAutomationControlsEnv()).not.toThrow()
    process.env.REMO_AUTOMATION_LIFETIME_INJECT_CAP = '50'
    expect(() => C.assertAutomationControlsEnv()).not.toThrow()
  })

  test('a garbage alarm pct only warns', () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {})
    process.env.REMO_TOKEN_CAP_ALARM_PCT = 'sixty'
    expect(() => C.assertAutomationControlsEnv()).not.toThrow()
    expect(warn).toHaveBeenCalled()
    expect(C.alarmPct()).toBe(60)
    warn.mockRestore()
  })
})

describe('assertAutomationControlsTables', () => {
  test('resolves when to_regclass finds all three tables', async () => {
    await expect(C.assertAutomationControlsTables()).resolves.toBeUndefined()
  })

  test('rejects naming the missing ones', async () => {
    state.tables = { ledger: true, kill_switch: false, alarms: false }
    await expect(C.assertAutomationControlsTables()).rejects.toThrow(/automation_kill_switch, token_cap_alarms/)
  })
})
