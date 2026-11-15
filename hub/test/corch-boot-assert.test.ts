// CORCH-01 (CORCH-R1.2, R1.3): flag defaults OFF, call-time reads, boot mutual exclusion with the
// old orchestrator, and the index.ts wiring pin.
import { describe, test, expect, afterEach } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  corchEnabled,
  corchLeaseMs,
  corchReconcileIntervalMs,
  assertCorchConfig,
  corchQuotaCeilingPct,
} from '../src/corch/flag.ts'

const KEYS = ['REMO_CORCH_ENABLED', 'REMO_CORCH_QUOTA_CEILING_PCT', 'REMO_ORCHESTRATOR_ENABLED', 'REMO_CORCH_LEASE_MS', 'REMO_CORCH_RECONCILE_INTERVAL_MS']
const saved: Record<string, string | undefined> = {}
for (const k of KEYS) saved[k] = process.env[k]
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})

describe('corchEnabled', () => {
  test('unset is OFF', () => {
    delete process.env.REMO_CORCH_ENABLED
    expect(corchEnabled()).toBe(false)
  })
  test('only trimmed case-insensitive 1|true|yes|on is ON', () => {
    for (const v of ['1', 'true', 'TRUE', ' yes ', 'On', 'on']) {
      process.env.REMO_CORCH_ENABLED = v
      expect(corchEnabled()).toBe(true)
    }
    for (const v of ['', '0', 'false', 'no', 'off', 'enabled', '2', 'truee']) {
      process.env.REMO_CORCH_ENABLED = v
      expect(corchEnabled()).toBe(false)
    }
  })
  test('read at call time', () => {
    process.env.REMO_CORCH_ENABLED = '1'
    expect(corchEnabled()).toBe(true)
    process.env.REMO_CORCH_ENABLED = '0'
    expect(corchEnabled()).toBe(false)
  })
})

describe('numeric knobs', () => {
  test('defaults for unset, 0, negative, NaN, garbage', () => {
    for (const v of [undefined, '0', '-5', 'NaN', 'abc', '']) {
      if (v === undefined) {
        delete process.env.REMO_CORCH_LEASE_MS
        delete process.env.REMO_CORCH_RECONCILE_INTERVAL_MS
      } else {
        process.env.REMO_CORCH_LEASE_MS = v
        process.env.REMO_CORCH_RECONCILE_INTERVAL_MS = v
      }
      expect(corchLeaseMs()).toBe(120000)
      expect(corchReconcileIntervalMs()).toBe(60000)
    }
  })
  test('positive values are honoured', () => {
    process.env.REMO_CORCH_LEASE_MS = '5000'
    process.env.REMO_CORCH_RECONCILE_INTERVAL_MS = '7000'
    expect(corchLeaseMs()).toBe(5000)
    expect(corchReconcileIntervalMs()).toBe(7000)
  })
})

describe('assertCorchConfig (CORCH-R1.3)', () => {
  const cases: Array<[string | undefined, string | undefined, boolean]> = [
    [undefined, undefined, false],
    ['1', undefined, false],
    [undefined, '1', false],
    ['1', 'true', true],
  ]
  for (const [corch, orch, throws] of cases) {
    test(`corch=${corch} orchestrator=${orch} => ${throws ? 'throws' : 'boots'}`, () => {
      if (corch === undefined) delete process.env.REMO_CORCH_ENABLED
      else process.env.REMO_CORCH_ENABLED = corch
      if (orch === undefined) delete process.env.REMO_ORCHESTRATOR_ENABLED
      else process.env.REMO_ORCHESTRATOR_ENABLED = orch
      if (throws) {
        let msg = ''
        try {
          assertCorchConfig()
        } catch (e: any) {
          msg = String(e?.message)
        }
        expect(msg).toContain('REMO_CORCH_ENABLED')
        expect(msg).toContain('REMO_ORCHESTRATOR_ENABLED')
      } else {
        expect(() => assertCorchConfig()).not.toThrow()
      }
    })
  }
})

describe('index.ts wiring pin', () => {
  test('assertCorchConfig() is called within 5 lines after assertTokenCapConfig()', () => {
    const lines = readFileSync(resolve(import.meta.dir, '../src/index.ts'), 'utf-8').split('\n')
    const at = lines.findIndex((l) => l.includes('assertTokenCapConfig()'))
    expect(at).toBeGreaterThan(-1)
    const window = lines.slice(at + 1, at + 6).join('\n')
    expect(window).toContain('assertCorchConfig()')
  })
})

describe('REMO_CORCH_QUOTA_CEILING_PCT (CORCH-R2.3, LD-Q7)', () => {
  const K = 'REMO_CORCH_QUOTA_CEILING_PCT'
  const savedCeil = process.env[K]
  afterEach(() => {
    if (savedCeil === undefined) delete process.env[K]
    else process.env[K] = savedCeil
  })

  test('unset and empty default to 55; a valid value is used', () => {
    delete process.env[K]
    expect(corchQuotaCeilingPct()).toBe(55)
    process.env[K] = ''
    expect(corchQuotaCeilingPct()).toBe(55)
    process.env[K] = '70'
    expect(corchQuotaCeilingPct()).toBe(70)
    process.env[K] = '100'
    expect(corchQuotaCeilingPct()).toBe(100)
    process.env[K] = '0.5'
    expect(corchQuotaCeilingPct()).toBe(0.5)
  })

  test("'abc', '0', '-5', '101' throw naming the variable", () => {
    for (const v of ['abc', '0', '-5', '101', 'NaN', 'Infinity']) {
      process.env[K] = v
      expect(() => corchQuotaCeilingPct()).toThrow(/REMO_CORCH_QUOTA_CEILING_PCT/)
    }
  })

  test('CORCH on + unset => assertCorchConfig ok; CORCH on + 70 => ok', () => {
    process.env.REMO_CORCH_ENABLED = '1'
    delete process.env.REMO_ORCHESTRATOR_ENABLED
    delete process.env[K]
    expect(() => assertCorchConfig()).not.toThrow()
    process.env[K] = '70'
    expect(() => assertCorchConfig()).not.toThrow()
  })

  test("CORCH on + bad ceiling => assertCorchConfig throws naming REMO_CORCH_QUOTA_CEILING_PCT", () => {
    process.env.REMO_CORCH_ENABLED = '1'
    delete process.env.REMO_ORCHESTRATOR_ENABLED
    for (const v of ['abc', '0', '-5', '101']) {
      process.env[K] = v
      expect(() => assertCorchConfig()).toThrow(/REMO_CORCH_QUOTA_CEILING_PCT/)
    }
  })

  test('CORCH off + bad ceiling => assertCorchConfig does not throw', () => {
    delete process.env.REMO_CORCH_ENABLED
    delete process.env.REMO_ORCHESTRATOR_ENABLED
    process.env[K] = 'abc'
    expect(() => assertCorchConfig()).not.toThrow()
  })
})
