/**
 * Unit tests for the ScheduleRule → cron conversion + validation utility.
 */
import { describe, expect, test } from 'bun:test'
import {
  validateRule,
  validateRules,
  ruleToCron,
  shouldSkipFire,
  isWithinActiveWindow,
  boundReason,
  normalizeRuleForStorage,
  humanizeRule,
  type ScheduleRule,
} from '../src/scheduler/schedule-rules.ts'

describe('validateRule', () => {
  test('accepts a valid rule', () => {
    const r: ScheduleRule = { interval: 2, unit: 'hours', start_at: '2030-01-01T09:30:00.000Z' }
    expect(validateRule(r)).toEqual({ ok: true })
  })

  test('rejects non-integer interval', () => {
    expect(validateRule({ interval: 1.5, unit: 'hours', start_at: '2030-01-01T00:00:00Z' } as any).ok).toBe(false)
  })

  test('rejects interval out of range', () => {
    expect(validateRule({ interval: 0, unit: 'hours', start_at: '2030-01-01T00:00:00Z' } as any).ok).toBe(false)
    expect(validateRule({ interval: 1000, unit: 'hours', start_at: '2030-01-01T00:00:00Z' } as any).ok).toBe(false)
  })

  test('accepts minutes and months units (P1)', () => {
    expect(validateRule({ interval: 5, unit: 'minutes', start_at: '2030-01-01T00:00:00Z' } as any).ok).toBe(true)
    expect(validateRule({ interval: 2, unit: 'months', start_at: '2030-01-01T00:00:00Z' } as any).ok).toBe(true)
  })

  test('rejects truly bad unit', () => {
    expect(validateRule({ interval: 1, unit: 'fortnights', start_at: '2030-01-01T00:00:00Z' } as any).ok).toBe(false)
  })

  test('rejects bad start_at', () => {
    expect(validateRule({ interval: 1, unit: 'hours', start_at: 'nope' } as any).ok).toBe(false)
  })

  // ── P1 active_window + bounds validation ──
  test('accepts a valid active_window', () => {
    expect(validateRule({ interval: 1, unit: 'days', start_at: '2030-01-01T00:00:00Z', active_window: { from: '22:00', to: '06:00' } } as any).ok).toBe(true)
  })

  test('rejects bad HH:MM in active_window', () => {
    expect(validateRule({ interval: 1, unit: 'days', start_at: '2030-01-01T00:00:00Z', active_window: { from: '25:00', to: '06:00' } } as any).ok).toBe(false)
    expect(validateRule({ interval: 1, unit: 'days', start_at: '2030-01-01T00:00:00Z', active_window: { from: '9:00', to: '17:00' } } as any).ok).toBe(false)
  })

  test('rejects equal active_window from/to', () => {
    expect(validateRule({ interval: 1, unit: 'days', start_at: '2030-01-01T00:00:00Z', active_window: { from: '09:00', to: '09:00' } } as any).ok).toBe(false)
  })

  test('rejects bad until / max_runs / for', () => {
    expect(validateRule({ interval: 1, unit: 'days', start_at: '2030-01-01T00:00:00Z', until: 'nope' } as any).ok).toBe(false)
    expect(validateRule({ interval: 1, unit: 'days', start_at: '2030-01-01T00:00:00Z', max_runs: 0 } as any).ok).toBe(false)
    expect(validateRule({ interval: 1, unit: 'days', start_at: '2030-01-01T00:00:00Z', for: { count: 0, unit: 'days' } } as any).ok).toBe(false)
  })

  test('backward-compat: a base {interval,unit,start_at} rule is still valid', () => {
    expect(validateRule({ interval: 1, unit: 'hours', start_at: '2030-01-01T00:00:00Z' }).ok).toBe(true)
  })
})

describe('validateRules', () => {
  test('requires at least one rule', () => {
    expect(validateRules([]).ok).toBe(false)
  })

  test('rejects > 20 rules', () => {
    const many = Array.from({ length: 21 }, () => ({
      interval: 1, unit: 'days' as const, start_at: '2030-01-01T00:00:00Z',
    }))
    expect(validateRules(many).ok).toBe(false)
  })

  test('rejects non-array', () => {
    expect(validateRules('nope' as any).ok).toBe(false)
  })

  test('reports the failing rule index', () => {
    const r = validateRules([
      { interval: 1, unit: 'days', start_at: '2030-01-01T00:00:00Z' },
      { interval: -1, unit: 'days', start_at: '2030-01-01T00:00:00Z' } as any,
    ])
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('rule[1]')
  })
})

describe('ruleToCron', () => {
  test('hourly interval=1 emits minute-of-hour cron', () => {
    const r: ScheduleRule = { interval: 1, unit: 'hours', start_at: '2030-01-01T09:30:00.000Z' }
    expect(ruleToCron(r, 'UTC')).toBe('30 * * * *')
  })

  test('hourly interval=N emits stepped cron', () => {
    const r: ScheduleRule = { interval: 4, unit: 'hours', start_at: '2030-01-01T09:30:00.000Z' }
    expect(ruleToCron(r, 'UTC')).toBe('30 */4 * * *')
  })

  test('daily interval=1 emits hh:mm cron', () => {
    const r: ScheduleRule = { interval: 1, unit: 'days', start_at: '2030-01-01T14:05:00.000Z' }
    expect(ruleToCron(r, 'UTC')).toBe('5 14 * * *')
  })

  test('daily interval=N emits stepped DOM', () => {
    const r: ScheduleRule = { interval: 3, unit: 'days', start_at: '2030-01-01T14:05:00.000Z' }
    expect(ruleToCron(r, 'UTC')).toBe('5 14 */3 * *')
  })

  test('weekly emits DOW cron', () => {
    // 2030-01-01 is a Tuesday → DOW=2
    const r: ScheduleRule = { interval: 1, unit: 'weeks', start_at: '2030-01-01T14:05:00.000Z' }
    expect(ruleToCron(r, 'UTC')).toBe('5 14 * * 2')
  })

  test('minutes interval=1 fires every minute (P1)', () => {
    const r: ScheduleRule = { interval: 1, unit: 'minutes', start_at: '2030-01-01T09:30:00.000Z' }
    expect(ruleToCron(r, 'UTC')).toBe('* * * * *')
  })

  test('minutes interval=N emits stepped minute cron (P1)', () => {
    const r: ScheduleRule = { interval: 15, unit: 'minutes', start_at: '2030-01-01T09:30:00.000Z' }
    expect(ruleToCron(r, 'UTC')).toBe('*/15 * * * *')
  })

  test('months emits day-of-month anchored cron (P1)', () => {
    // start_at = 14th @ 14:05 UTC → "5 14 14 * *"
    const r: ScheduleRule = { interval: 1, unit: 'months', start_at: '2030-03-14T14:05:00.000Z' }
    expect(ruleToCron(r, 'UTC')).toBe('5 14 14 * *')
  })
})

describe('isWithinActiveWindow', () => {
  const base = { interval: 1, unit: 'days' as const, start_at: '2030-01-01T00:00:00Z' }

  test('no window → always active', () => {
    expect(isWithinActiveWindow(base, new Date('2030-01-01T03:00:00Z'), 'UTC')).toBe(true)
  })

  test('daytime window includes inside, excludes outside', () => {
    const r: ScheduleRule = { ...base, active_window: { from: '09:00', to: '17:00' } }
    expect(isWithinActiveWindow(r, new Date('2030-01-01T12:00:00Z'), 'UTC')).toBe(true)
    expect(isWithinActiveWindow(r, new Date('2030-01-01T08:59:00Z'), 'UTC')).toBe(false)
    expect(isWithinActiveWindow(r, new Date('2030-01-01T17:00:00Z'), 'UTC')).toBe(false) // exclusive end
  })

  test('overnight wrap (22:00→06:00) covers both sides of midnight', () => {
    const r: ScheduleRule = { ...base, active_window: { from: '22:00', to: '06:00' } }
    expect(isWithinActiveWindow(r, new Date('2030-01-01T23:30:00Z'), 'UTC')).toBe(true) // 23:30 in-window
    expect(isWithinActiveWindow(r, new Date('2030-01-01T02:00:00Z'), 'UTC')).toBe(true) // 02:00 in-window
    expect(isWithinActiveWindow(r, new Date('2030-01-01T12:00:00Z'), 'UTC')).toBe(false) // midday out
    expect(isWithinActiveWindow(r, new Date('2030-01-01T06:00:00Z'), 'UTC')).toBe(false) // exclusive end
  })

  test('shouldSkipFire enforces window (overnight)', () => {
    const r: ScheduleRule = { ...base, active_window: { from: '22:00', to: '06:00' } }
    expect(shouldSkipFire(r, new Date('2030-01-01T03:00:00Z'), 'UTC')).toBe(false) // in-window
    expect(shouldSkipFire(r, new Date('2030-01-01T12:00:00Z'), 'UTC')).toBe(true)  // out-of-window
  })
})

describe('months interval cadence (shouldSkipFire)', () => {
  test('every 2 months skips the off-month', () => {
    const r: ScheduleRule = { interval: 2, unit: 'months', start_at: '2030-01-15T00:00:00Z' }
    expect(shouldSkipFire(r, new Date('2030-02-15T00:00:00Z'), 'UTC')).toBe(true)  // 1 month → off
    expect(shouldSkipFire(r, new Date('2030-03-15T00:00:00Z'), 'UTC')).toBe(false) // 2 months → on
  })
})

describe('boundReason (end bounds)', () => {
  test('until reached → bound_until', () => {
    const r: ScheduleRule = { interval: 1, unit: 'days', start_at: '2030-01-01T00:00:00Z', until: '2030-01-05T00:00:00Z' }
    expect(boundReason([r], new Date('2030-01-04T00:00:00Z'), 0)).toBeNull()
    expect(boundReason([r], new Date('2030-01-05T00:00:01Z'), 0)).toBe('bound_until')
  })

  test('max_runs reached → bound_max_runs', () => {
    const r: ScheduleRule = { interval: 1, unit: 'days', start_at: '2030-01-01T00:00:00Z', max_runs: 3 }
    expect(boundReason([r], new Date('2030-01-10T00:00:00Z'), 2)).toBeNull()  // 2 fires so far, 3rd allowed
    expect(boundReason([r], new Date('2030-01-10T00:00:00Z'), 3)).toBe('bound_max_runs') // cap hit
  })

  test('no bounds → never stops', () => {
    const r: ScheduleRule = { interval: 1, unit: 'days', start_at: '2030-01-01T00:00:00Z' }
    expect(boundReason([r], new Date('2099-01-01T00:00:00Z'), 99999)).toBeNull()
  })
})

describe('normalizeRuleForStorage', () => {
  test('resolves for:{count,unit} → absolute until and drops for', () => {
    const r: ScheduleRule = { interval: 1, unit: 'days', start_at: '2030-01-01T00:00:00.000Z', for: { count: 3, unit: 'days' } }
    const out = normalizeRuleForStorage(r)
    expect(out.for).toBeUndefined()
    expect(out.until).toBe('2030-01-04T00:00:00.000Z')
  })

  test('rule without for is unchanged', () => {
    const r: ScheduleRule = { interval: 1, unit: 'hours', start_at: '2030-01-01T00:00:00Z' }
    expect(normalizeRuleForStorage(r)).toEqual(r)
  })

  test('months for-bound uses calendar math', () => {
    const r: ScheduleRule = { interval: 1, unit: 'months', start_at: '2030-01-31T00:00:00.000Z', for: { count: 1, unit: 'months' } }
    const out = normalizeRuleForStorage(r)
    // Jan 31 + 1 month → JS rolls to Mar 3 (Feb has no 31) — documented approximation
    expect(out.until).toBeDefined()
    expect(out.for).toBeUndefined()
  })
})

describe('shouldSkipFire', () => {
  test('skips when now < start_at', () => {
    const r: ScheduleRule = { interval: 1, unit: 'hours', start_at: '2099-01-01T00:00:00Z' }
    expect(shouldSkipFire(r, new Date('2030-01-01T00:00:00Z'))).toBe(true)
  })

  test('does not skip when now >= start_at', () => {
    const r: ScheduleRule = { interval: 1, unit: 'hours', start_at: '2030-01-01T00:00:00Z' }
    expect(shouldSkipFire(r, new Date('2030-01-02T00:00:00Z'))).toBe(false)
  })

  test('weekly interval>1 enforces cadence', () => {
    const r: ScheduleRule = { interval: 2, unit: 'weeks', start_at: '2030-01-07T00:00:00Z' } // Mon
    // 7 days later = 1 week → wrong week
    expect(shouldSkipFire(r, new Date('2030-01-14T00:00:00Z'))).toBe(true)
    // 14 days later = 2 weeks → right week
    expect(shouldSkipFire(r, new Date('2030-01-21T00:00:00Z'))).toBe(false)
  })
})

describe('humanizeRule', () => {
  test('singular noun for interval=1', () => {
    const r: ScheduleRule = { interval: 1, unit: 'days', start_at: '2030-01-01T09:00:00Z' }
    expect(humanizeRule(r)).toMatch(/^Every 1 day starting /)
  })

  test('plural for interval>1', () => {
    const r: ScheduleRule = { interval: 3, unit: 'weeks', start_at: '2030-01-01T09:00:00Z' }
    expect(humanizeRule(r)).toMatch(/^Every 3 weeks starting /)
  })
})
