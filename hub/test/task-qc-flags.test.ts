/** PTYCAP-08 flags / cadence / frozen bounds (DB-free). */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  ENABLED_ENV,
  AUTOFIX_ENV,
  FAIL_STREAK_ENV,
  CADENCE_ENV,
  DEFAULT_CADENCE_CRON,
  TASK_QC_BOUNDS,
  clampBounds,
  isTaskQcAutofixEnabled,
  isTaskQcEnabled,
  taskQcCadenceCron,
  taskQcFailStreak,
  validateTaskQcCadence,
} from '../src/task-qc/flags.ts'

const KEYS = [ENABLED_ENV, AUTOFIX_ENV, FAIL_STREAK_ENV, CADENCE_ENV]
const saved: Record<string, string | undefined> = {}
beforeEach(() => {
  for (const k of KEYS) {
    saved[k] = process.env[k]
    delete process.env[k]
  }
})
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})

describe('task-qc flags', () => {
  test('ENABLED is false when unset and for non-truthy values', () => {
    expect(isTaskQcEnabled()).toBe(false)
    for (const v of ['', '0', 'false', 'no', 'off', 'maybe', '2']) {
      process.env[ENABLED_ENV] = v
      expect(isTaskQcEnabled()).toBe(false)
    }
  })

  test('ENABLED is true only for trimmed lowercase 1/true/yes/on, re-read every call', () => {
    for (const v of ['1', 'true', 'YES', ' On ', 'TRUE']) {
      process.env[ENABLED_ENV] = v
      expect(isTaskQcEnabled()).toBe(true)
    }
    process.env[ENABLED_ENV] = '0'
    expect(isTaskQcEnabled()).toBe(false)
  })

  test('AUTOFIX truth table: inert without ENABLED', () => {
    const cases: Array<[string | undefined, string | undefined, boolean]> = [
      [undefined, undefined, false],
      ['1', undefined, false],
      [undefined, '1', false], // AUTOFIX without ENABLED is off
      ['1', '1', true],
      ['1', '0', false],
      ['0', '1', false],
      ['yes', 'on', true],
    ]
    for (const [en, af, want] of cases) {
      if (en === undefined) delete process.env[ENABLED_ENV]
      else process.env[ENABLED_ENV] = en
      if (af === undefined) delete process.env[AUTOFIX_ENV]
      else process.env[AUTOFIX_ENV] = af
      expect(isTaskQcAutofixEnabled()).toBe(want)
    }
  })

  test('FAIL_STREAK: positive finite integer else 3, never 0', () => {
    expect(taskQcFailStreak()).toBe(3)
    process.env[FAIL_STREAK_ENV] = '5'
    expect(taskQcFailStreak()).toBe(5)
    for (const v of ['0', '-1', 'NaN', 'abc', '', '2.5', 'Infinity', '1e999']) {
      process.env[FAIL_STREAK_ENV] = v
      expect(taskQcFailStreak()).toBe(3)
    }
  })
})

describe('task-qc cadence', () => {
  test('default is 0 9 * * * when unset', () => {
    expect(DEFAULT_CADENCE_CRON).toBe('0 9 * * *')
    expect(taskQcCadenceCron()).toBe('0 9 * * *')
  })

  test('valid hourly-or-slower expression is accepted', () => {
    process.env[CADENCE_ENV] = '30 */2 * * *'
    expect(taskQcCadenceCron()).toBe('30 */2 * * *')
    process.env[CADENCE_ENV] = '0 * * * *'
    expect(taskQcCadenceCron()).toBe('0 * * * *')
  })

  test('garbage and faster-than-hourly fall back to the default', () => {
    for (const v of ['not a cron', '* * * * *', '*/5 * * * *', '0,10 * * * *', '']) {
      process.env[CADENCE_ENV] = v
      expect(taskQcCadenceCron()).toBe('0 9 * * *')
    }
  })

  test('validateTaskQcCadence reasons', () => {
    expect(validateTaskQcCadence('0 9 * * *', 'UTC')).toEqual({ ok: true })
    expect(validateTaskQcCadence('zzz', 'UTC')).toMatchObject({ ok: false, reason: 'invalid_cron' })
    expect(validateTaskQcCadence('0 9 * * *', 'Not/AZone')).toMatchObject({ ok: false, reason: 'invalid_timezone' })
    expect(validateTaskQcCadence('*/10 * * * *', 'UTC')).toMatchObject({ ok: false, reason: 'faster_than_hourly' })
    // a burst hidden behind a long gap is still caught
    expect(validateTaskQcCadence('0,5 9 * * *', 'UTC')).toMatchObject({ ok: false, reason: 'faster_than_hourly' })
  })
})

describe('task-qc bounds', () => {
  test('frozen constants', () => {
    expect(Object.isFrozen(TASK_QC_BOUNDS)).toBe(true)
    expect(TASK_QC_BOUNDS).toEqual({
      maxAuditedTasks: 500,
      maxRunsPerTask: 50,
      maxAutoFixesPerPass: 25,
      maxRowsWrittenPerRun: 200,
      passTimeoutMs: 60000,
    })
    expect(() => {
      ;(TASK_QC_BOUNDS as any).maxAuditedTasks = 1e9
    }).toThrow()
    expect(TASK_QC_BOUNDS.maxAuditedTasks).toBe(500)
  })

  test('clampBounds can only lower, never raise', () => {
    expect(clampBounds()).toEqual({ ...TASK_QC_BOUNDS })
    const c = clampBounds({ maxAuditedTasks: 10, maxRunsPerTask: 1e9, passTimeoutMs: 1000 })
    expect(c.maxAuditedTasks).toBe(10)
    expect(c.maxRunsPerTask).toBe(50)
    expect(c.passTimeoutMs).toBe(1000)
    expect(c.maxAutoFixesPerPass).toBe(25)
  })

  test('clampBounds ignores non-finite or non-positive requests', () => {
    for (const bad of [0, -5, NaN, Infinity, -Infinity, '7' as any, null as any]) {
      const c = clampBounds({ maxAuditedTasks: bad, maxRowsWrittenPerRun: bad })
      expect(c.maxAuditedTasks).toBe(500)
      expect(c.maxRowsWrittenPerRun).toBe(200)
    }
    expect(clampBounds({ maxAuditedTasks: 7.9 }).maxAuditedTasks).toBe(7)
  })
})

describe('task-qc hygiene', () => {
  const dir = join(import.meta.dir, '..', 'src', 'task-qc')
  const files = readdirSync(dir).filter((f) => f.endsWith('.ts'))

  test('no token-cap knob is read anywhere in hub/src/task-qc', () => {
    for (const f of files) {
      const src = readFileSync(join(dir, f), 'utf8')
      // comments may name the dropped knob; code must not read it
      const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
      expect(code, f).not.toMatch(/TOKEN_CAP/i)
    }
  })

  test('flags.ts is a leaf: no db/postgres import', () => {
    const src = readFileSync(join(dir, 'flags.ts'), 'utf8')
    expect(src).not.toMatch(/from\s+['"][^'"]*db\/postgres/)
    expect(src).not.toMatch(/from\s+['"][^'"]*dispatch/)
  })
})
