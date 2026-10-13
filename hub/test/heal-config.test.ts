/**
 * PTYCAP-07-01 -- heal flag + knob readers (D-01, SH-07, AM-F1-1, AM-F3-3).
 * DB-free. Env is read at call time, so each test sets/restores process.env.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import {
  healUnifiedEnabled,
  healAutospawnArmed,
  healDedupeWindowMs,
  healSpawnTimeoutMs,
  healMaxClaimsPerUserHour,
  healMaxPerRepoHour,
  healMaxPerTaskDay,
  healRetentionHours,
} from '../src/heal/config.ts'

const ENV_KEYS = [
  'REMO_HEAL_UNIFIED',
  'REMO_HEAL_DEDUPE_WINDOW_MS',
  'REMO_HEAL_SPAWN_TIMEOUT_MS',
  'REMO_HEAL_MAX_CLAIMS_PER_USER_HOUR',
  'REMO_HEAL_MAX_PER_REPO_HOUR',
  'REMO_HEAL_MAX_PER_TASK_DAY',
  'REMO_HEAL_RETENTION_HOURS',
  'REMO_ORCHESTRATOR_AUTOSPAWN',
  'REMO_ORCHESTRATOR_ENABLED',
]
let saved: Record<string, string | undefined> = {}

beforeEach(() => {
  saved = {}
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k]
    delete process.env[k]
  }
})
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})

describe('healUnifiedEnabled', () => {
  test('unset is OFF', () => {
    expect(healUnifiedEnabled()).toBe(false)
  })
  test.each(['', '0', 'false', 'no', 'off', 'maybe', '2', 'enabled', 'yes please'])(
    'unrecognized/negative value %p is OFF',
    (v) => {
      process.env.REMO_HEAL_UNIFIED = v
      expect(healUnifiedEnabled()).toBe(false)
    },
  )
  test.each(['1', 'true', 'yes', 'on', 'TRUE', 'On', ' yes ', '\tON\n'])('%p is ON', (v) => {
    process.env.REMO_HEAL_UNIFIED = v
    expect(healUnifiedEnabled()).toBe(true)
  })
  test('read at call time', () => {
    process.env.REMO_HEAL_UNIFIED = '1'
    expect(healUnifiedEnabled()).toBe(true)
    process.env.REMO_HEAL_UNIFIED = '0'
    expect(healUnifiedEnabled()).toBe(false)
  })
})

describe('numeric knobs', () => {
  const cases: Array<[string, () => number, string, number]> = [
    ['dedupe window', healDedupeWindowMs, 'REMO_HEAL_DEDUPE_WINDOW_MS', 900000],
    ['spawn timeout', healSpawnTimeoutMs, 'REMO_HEAL_SPAWN_TIMEOUT_MS', 25000],
    ['claims per user hour', healMaxClaimsPerUserHour, 'REMO_HEAL_MAX_CLAIMS_PER_USER_HOUR', 30],
    ['per repo hour', healMaxPerRepoHour, 'REMO_HEAL_MAX_PER_REPO_HOUR', 4],
    ['per task day', healMaxPerTaskDay, 'REMO_HEAL_MAX_PER_TASK_DAY', 3],
    ['retention hours', healRetentionHours, 'REMO_HEAL_RETENTION_HOURS', 48],
  ]
  for (const [name, fn, env, def] of cases) {
    test(`${name}: default ${def}`, () => {
      expect(fn()).toBe(def)
    })
    test(`${name}: "0", "-5", NaN, abc, Infinity, empty all yield the default`, () => {
      for (const bad of ['0', '-5', 'NaN', 'abc', 'Infinity', '']) {
        process.env[env] = bad
        expect(fn()).toBe(def)
      }
    })
  }
  test('a valid override is honored', () => {
    process.env.REMO_HEAL_DEDUPE_WINDOW_MS = '60000'
    expect(healDedupeWindowMs()).toBe(60000)
    process.env.REMO_HEAL_MAX_PER_REPO_HOUR = '9'
    expect(healMaxPerRepoHour()).toBe(9)
  })
  test('retention never drops below 24h', () => {
    process.env.REMO_HEAL_RETENTION_HOURS = '6'
    expect(healRetentionHours()).toBe(24)
    process.env.REMO_HEAL_RETENTION_HOURS = '72'
    expect(healRetentionHours()).toBe(72)
  })
})

describe('healAutospawnArmed', () => {
  test('true with heal ON + autospawn ON and REMO_ORCHESTRATOR_ENABLED unset', () => {
    process.env.REMO_HEAL_UNIFIED = '1'
    process.env.REMO_ORCHESTRATOR_AUTOSPAWN = '1'
    expect(process.env.REMO_ORCHESTRATOR_ENABLED).toBeUndefined()
    expect(healAutospawnArmed()).toBe(true)
  })
  test('false when either flag is OFF', () => {
    process.env.REMO_HEAL_UNIFIED = '1'
    expect(healAutospawnArmed()).toBe(false)
    process.env.REMO_ORCHESTRATOR_AUTOSPAWN = '1'
    process.env.REMO_HEAL_UNIFIED = '0'
    expect(healAutospawnArmed()).toBe(false)
  })
  test('REMO_ORCHESTRATOR_ENABLED alone arms nothing', () => {
    process.env.REMO_ORCHESTRATOR_ENABLED = '1'
    expect(healAutospawnArmed()).toBe(false)
  })
})
