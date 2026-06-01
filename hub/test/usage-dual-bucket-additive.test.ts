/**
 * Phase 18 (R-PTY-17, T-18-03) — the second usage bucket travels the EXISTING
 * plumbing additively.
 *
 * Asserts:
 *  - the usage_report Zod schema accepts BOTH an old-shape payload (no second
 *    bucket) AND a new-shape one (with programmatic_credit) — additive, no break;
 *  - the in-memory store round-trips the second bucket;
 *  - no OAuth token is anywhere in the hub-side usage types/store (the wire only
 *    ever carries the parsed snapshot).
 */
import { describe, test, expect, beforeEach } from 'bun:test'
import { AgentUsageReport } from '../src/ws/agent-protocol'
import { setUsage, getUsage, _resetUsageStoreForTests } from '../src/usage/store'

const oldShape = {
  type: 'usage_report' as const,
  usage: {
    five_hour: { utilization: 10, resets_at: '2026-06-16T05:00:00Z' },
    seven_day: { utilization: 20, resets_at: '2026-06-22T00:00:00Z' },
  },
}

const newShape = {
  type: 'usage_report' as const,
  usage: {
    ...oldShape.usage,
    programmatic_credit: {
      used_usd: 12.34,
      limit_usd: 100,
      resets_at: '2026-07-01T00:00:00Z',
      claimed: true,
    },
  },
}

describe('usage_report schema is additive', () => {
  test('old-shape payload (no programmatic_credit) still validates', () => {
    const r = AgentUsageReport.safeParse(oldShape)
    expect(r.success).toBe(true)
    if (r.success) expect((r.data.usage as any).programmatic_credit ?? null).toBeNull()
  })

  test('new-shape payload (with programmatic_credit) validates + carries the bucket', () => {
    const r = AgentUsageReport.safeParse(newShape)
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.data.usage.programmatic_credit).toEqual({
        used_usd: 12.34,
        limit_usd: 100,
        resets_at: '2026-07-01T00:00:00Z',
        claimed: true,
      })
    }
  })

  test('null programmatic_credit is accepted (explicit empty state)', () => {
    const r = AgentUsageReport.safeParse({
      ...oldShape,
      usage: { ...oldShape.usage, programmatic_credit: null },
    })
    expect(r.success).toBe(true)
  })
})

describe('store round-trips the second bucket', () => {
  beforeEach(() => _resetUsageStoreForTests())

  test('setUsage/getUsage preserve programmatic_credit', () => {
    setUsage('u1', newShape.usage as any)
    const snap = getUsage('u1')
    expect(snap?.usage.programmatic_credit?.used_usd).toBe(12.34)
  })

  test('old-shape stores with no second bucket', () => {
    setUsage('u2', oldShape.usage as any)
    const snap = getUsage('u2')
    expect(snap?.usage.programmatic_credit ?? null).toBeNull()
  })

  test('no token-shaped field is carried on the snapshot', () => {
    setUsage('u3', newShape.usage as any)
    const serialized = JSON.stringify(getUsage('u3'))
    expect(serialized.toLowerCase()).not.toContain('accesstoken')
    expect(serialized).not.toContain('Bearer')
    expect(serialized).not.toContain('sk-ant')
  })
})
