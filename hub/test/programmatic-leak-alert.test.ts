/**
 * Phase 18 (R-PTY-18, T-18-04) — programmatic-credit leak detector.
 *
 * Pure-logic coverage of `detectProgrammaticLeak`:
 *  - drain + no automation in flight  => alert (drain_without_automation)
 *  - drain + automation in flight      => NO alert (no false positive)
 *  - drain over the rate threshold     => alert even WITH automation
 *  - no drain / absent buckets         => never an alert (no silent + no noise)
 */
import { describe, test, expect } from 'bun:test'
import { detectProgrammaticLeak } from '../src/usage/programmatic-leak'
import type { ProgrammaticCredit } from '../src/usage/store'

const c = (used: number): ProgrammaticCredit => ({
  used_usd: used,
  limit_usd: 100,
  resets_at: '2026-07-01T00:00:00Z',
  claimed: true,
})
const at = () => '2026-06-16T00:00:00Z'

describe('detectProgrammaticLeak', () => {
  test('drain with NO automation in flight => alert', () => {
    const a = detectProgrammaticLeak({
      prev: c(10), next: c(15), automationInFlight: false, now: at,
    })
    expect(a).toEqual({
      type: 'programmatic_leak_alert',
      reason: 'drain_without_automation',
      delta_usd: 5, used_usd: 15, limit_usd: 100,
      detected_at: '2026-06-16T00:00:00Z',
    })
  })

  test('drain WITH automation in flight => NO alert (no false positive)', () => {
    const a = detectProgrammaticLeak({
      prev: c(10), next: c(15), automationInFlight: true, now: at,
    })
    expect(a).toBeNull()
  })

  test('drain over rate threshold => alert even with automation in flight', () => {
    const a = detectProgrammaticLeak({
      prev: c(10), next: c(30), automationInFlight: true, drainRateThresholdUsd: 5, now: at,
    })
    expect(a?.reason).toBe('drain_rate_exceeded')
    expect(a?.delta_usd).toBe(20)
  })

  test('drain within rate threshold + automation => no alert', () => {
    const a = detectProgrammaticLeak({
      prev: c(10), next: c(13), automationInFlight: true, drainRateThresholdUsd: 5, now: at,
    })
    expect(a).toBeNull()
  })

  test('no drain (flat or reset) => never an alert', () => {
    expect(detectProgrammaticLeak({ prev: c(10), next: c(10), automationInFlight: false, now: at })).toBeNull()
    expect(detectProgrammaticLeak({ prev: c(10), next: c(2), automationInFlight: false, now: at })).toBeNull()
  })

  test('absent / unclaimed buckets => no alert (nothing to compare)', () => {
    expect(detectProgrammaticLeak({ prev: null, next: c(5), automationInFlight: false, now: at })).toBeNull()
    expect(detectProgrammaticLeak({ prev: c(5), next: null, automationInFlight: false, now: at })).toBeNull()
  })
})
