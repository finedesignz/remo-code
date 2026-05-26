/**
 * Unit tests for the ScheduleRule → cron conversion + validation utility.
 */
import { describe, expect, test } from 'bun:test'
import {
  validateRule,
  validateRules,
  ruleToCron,
  shouldSkipFire,
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

  test('rejects bad unit', () => {
    expect(validateRule({ interval: 1, unit: 'months', start_at: '2030-01-01T00:00:00Z' } as any).ok).toBe(false)
  })

  test('rejects bad start_at', () => {
    expect(validateRule({ interval: 1, unit: 'hours', start_at: 'nope' } as any).ok).toBe(false)
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
