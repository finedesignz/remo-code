/**
 * Unit tests for the Claude usage threshold gate.
 *
 * Pure-function `evaluateThreshold` — no DB, no WS, no store. The integration
 * with `checkUserThreshold` (DB + store) is exercised via the existing
 * scheduler/error-capture/manual-send code paths in scheduled-tasks.e2e.test.ts.
 */
import { describe, test, expect } from 'bun:test'
// Cache-bust: ws-client-license-gate.test.ts / send-fence-scheduled-run.test.ts
// install process-global `mock.module('../src/usage/threshold.ts', …)` stubs
// that only expose `checkUserThreshold`, so a plain import of
// `evaluateThreshold` fails with SyntaxError when those siblings load first.
// See feedback_bun_mock_pollution.md.
const { evaluateThreshold } = await import(`../src/usage/threshold.ts?bust=${Date.now()}`)
import type { UsageSnapshot } from '../src/usage/store.ts'

function snap(fivePct: number, sevenPct: number, opusPct?: number | null): UsageSnapshot {
  return {
    usage: {
      five_hour: { utilization: fivePct, resets_at: '2026-05-25T20:00:00Z' },
      seven_day: { utilization: sevenPct, resets_at: '2026-06-01T00:00:00Z' },
      seven_day_opus: opusPct == null
        ? null
        : { utilization: opusPct, resets_at: '2026-06-01T00:00:00Z' },
    },
    updated_at: '2026-05-25T19:55:00Z',
  }
}

describe('evaluateThreshold', () => {
  test('back-compat: both thresholds null → allowed', () => {
    expect(evaluateThreshold(snap(99, 99), {
      claude_session_threshold_pct: null,
      claude_week_threshold_pct: null,
    })).toEqual({ allowed: true })
  })

  test('snapshot null with thresholds set → fail-open (allowed)', () => {
    expect(evaluateThreshold(null, {
      claude_session_threshold_pct: 90,
      claude_week_threshold_pct: 90,
    })).toEqual({ allowed: true })
  })

  test('session window over threshold → blocked, reason=session_threshold', () => {
    const d = evaluateThreshold(snap(92, 10), {
      claude_session_threshold_pct: 90,
      claude_week_threshold_pct: 95,
    })
    expect(d.allowed).toBe(false)
    expect(d.reason).toBe('session_threshold')
    expect(d.utilization_pct).toBe(92)
    expect(d.threshold_pct).toBe(90)
    expect(d.resets_at).toBe('2026-05-25T20:00:00Z')
  })

  test('week window over threshold → blocked, reason=week_threshold', () => {
    const d = evaluateThreshold(snap(10, 92), {
      claude_session_threshold_pct: 95,
      claude_week_threshold_pct: 90,
    })
    expect(d.allowed).toBe(false)
    expect(d.reason).toBe('week_threshold')
    expect(d.utilization_pct).toBe(92)
    expect(d.resets_at).toBe('2026-06-01T00:00:00Z')
  })

  test('both over → session_threshold wins (deterministic precedence)', () => {
    const d = evaluateThreshold(snap(95, 99), {
      claude_session_threshold_pct: 90,
      claude_week_threshold_pct: 90,
    })
    expect(d.reason).toBe('session_threshold')
  })

  test('boundary at exactly threshold_pct → blocked (>=)', () => {
    const d = evaluateThreshold(snap(90, 10), {
      claude_session_threshold_pct: 90,
      claude_week_threshold_pct: null,
    })
    expect(d.allowed).toBe(false)
    expect(d.reason).toBe('session_threshold')
  })

  test('just under threshold → allowed', () => {
    const d = evaluateThreshold(snap(89.9, 10), {
      claude_session_threshold_pct: 90,
      claude_week_threshold_pct: null,
    })
    expect(d.allowed).toBe(true)
  })

  test('opus carve-out trips week_threshold', () => {
    const d = evaluateThreshold(snap(10, 50, 95), {
      claude_session_threshold_pct: null,
      claude_week_threshold_pct: 90,
    })
    expect(d.allowed).toBe(false)
    expect(d.reason).toBe('week_threshold')
    expect(d.utilization_pct).toBe(95)
  })

  test('only session threshold set, week unbounded', () => {
    expect(evaluateThreshold(snap(50, 99), {
      claude_session_threshold_pct: 90,
      claude_week_threshold_pct: null,
    })).toEqual({ allowed: true })
  })

  test('only week threshold set, session unbounded', () => {
    expect(evaluateThreshold(snap(99, 50), {
      claude_session_threshold_pct: null,
      claude_week_threshold_pct: 90,
    })).toEqual({ allowed: true })
  })
})
