/**
 * Phase 18 (R-PTY-17/18/20, T-18-08) — usage dual-bucket UI logic.
 *
 * No DOM test infra ships in this repo, so we exercise the LOAD-BEARING logic
 * through the pure reducers the hooks consume (no React mock — that would
 * pollute sibling tsx tests via Bun's process-global mock.module) plus a source
 * scan of the UsageTab component:
 *   - reduceSubscriptionUsage carries programmatic_credit through additively,
 *   - reduceProgrammaticLeakAlert maps the leak event,
 *   - the UsageTab source renders an explicit empty state, drives only the WS
 *     payload (no token-shaped field), and uses blue accent tokens (no indigo).
 */
import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import {
  reduceSubscriptionUsage,
  reduceProgrammaticLeakAlert,
} from '../src/hooks/useSubscriptionUsage'

describe('reduceSubscriptionUsage carries the second bucket', () => {
  test('programmatic_credit flows through additively', () => {
    const snap = reduceSubscriptionUsage({
      type: 'subscription_usage',
      usage: {
        five_hour: { utilization: 10, resets_at: 'x' },
        seven_day: { utilization: 20, resets_at: 'y' },
        programmatic_credit: { used_usd: 5, limit_usd: 100, resets_at: 'z', claimed: true },
      },
      updated_at: 'now',
    })
    expect(snap?.usage.programmatic_credit?.used_usd).toBe(5)
  })

  test('old-shape payload (no second bucket) still resolves', () => {
    const snap = reduceSubscriptionUsage({
      type: 'subscription_usage',
      usage: { five_hour: { utilization: 1, resets_at: 'x' }, seven_day: { utilization: 2, resets_at: 'y' } },
      updated_at: 'now',
    })
    expect(snap?.usage.programmatic_credit ?? null).toBeNull()
  })

  test('non-usage messages reduce to null', () => {
    expect(reduceSubscriptionUsage({ type: 'ping' })).toBeNull()
    expect(reduceSubscriptionUsage({ type: 'subscription_usage' })).toBeNull()
  })
})

describe('reduceProgrammaticLeakAlert', () => {
  test('maps a leak alert event', () => {
    const a = reduceProgrammaticLeakAlert({
      type: 'programmatic_leak_alert',
      reason: 'drain_without_automation',
      delta_usd: 3, used_usd: 8, limit_usd: 100, detected_at: 't',
    })
    expect(a?.reason).toBe('drain_without_automation')
    expect(a?.delta_usd).toBe(3)
  })

  test('ignores unrelated messages', () => {
    expect(reduceProgrammaticLeakAlert({ type: 'ping' })).toBeNull()
  })
})

describe('UsageTab source guarantees', () => {
  const src = readFileSync(join(import.meta.dir, '..', 'src', 'pages', 'settings', 'UsageTab.tsx'), 'utf-8')

  test('renders an explicit empty state for unclaimed/absent credit', () => {
    expect(src).toContain('not claimed or unavailable')
  })

  test('drives the credit card from the WS payload, not a token', () => {
    expect(src).toContain('programmatic_credit')
    expect(src.toLowerCase()).not.toContain('accesstoken')
    expect(src).not.toContain('Bearer')
  })

  test('uses blue accent, never indigo', () => {
    expect(src).not.toMatch(/indigo/i)
    expect(src).toContain('blue-500')
  })

  test('hard-halt control defaults OFF and copy says automation-only', () => {
    expect(src).toContain('Off by default')
    expect(src).toContain('Halts automation only')
  })
})
