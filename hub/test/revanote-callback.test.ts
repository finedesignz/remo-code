import { describe, expect, test } from 'bun:test'
import { _internals } from '../src/revanote/callback'

describe('callback retry curve', () => {
  test('schedule grows monotonically across attempts', () => {
    const delays = _internals.RETRY_DELAYS_MS
    for (let i = 1; i < delays.length; i++) {
      expect(delays[i]).toBeGreaterThan(delays[i - 1])
    }
  })

  test('first 4 buckets are 1m / 5m / 15m / 1h', () => {
    expect(_internals.RETRY_DELAYS_MS[0]).toBe(60_000)
    expect(_internals.RETRY_DELAYS_MS[1]).toBe(5 * 60_000)
    expect(_internals.RETRY_DELAYS_MS[2]).toBe(15 * 60_000)
    expect(_internals.RETRY_DELAYS_MS[3]).toBe(60 * 60_000)
  })

  test('nextRetryFor returns Date in window for retryable attempts', () => {
    const before = Date.now()
    const d = _internals.nextRetryFor(0)
    const after = Date.now()
    expect(d).not.toBeNull()
    const t = d!.getTime()
    // 1m ±10% jitter, plus the elapsed wall time between Date.now() calls.
    expect(t).toBeGreaterThan(before + 60_000 * 0.85)
    expect(t).toBeLessThan(after + 60_000 * 1.15)
  })

  test('nextRetryFor returns null at dead-letter threshold', () => {
    expect(_internals.nextRetryFor(_internals.DEAD_AFTER_ATTEMPTS)).toBeNull()
    expect(_internals.nextRetryFor(_internals.DEAD_AFTER_ATTEMPTS + 1)).toBeNull()
  })
})
