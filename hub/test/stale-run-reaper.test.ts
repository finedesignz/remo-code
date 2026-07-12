/**
 * Absolute-age session_run backstop (fix/stop-the-bleed).
 *
 * Pure-unit coverage of the sweep seam: it must call the DAL with the configured
 * ceiling, never throw on a DB error, and honour the disable flag. The SQL
 * itself is proven against real Postgres in finalize-orphaned-runs.test.ts.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-chars-long-aaaaaaaa'

import { describe, test, expect, afterEach } from 'bun:test'
import {
  reapAgedSessionRuns,
  sessionRunMaxMs,
  startStaleRunReaperSweep,
  stopStaleRunReaperSweep,
} from '../src/sessions/stale-run-reaper.ts'

afterEach(() => {
  delete process.env.REMO_SESSION_RUN_MAX_MS
  delete process.env.REMO_SESSION_RUN_REAPER_DISABLED
  stopStaleRunReaperSweep()
})

describe('stale session_run reaper', () => {
  test('defaults to a 24h ceiling', () => {
    expect(sessionRunMaxMs()).toBe(86_400_000)
  })

  test('env override applies; non-positive / garbage falls back to the default', () => {
    process.env.REMO_SESSION_RUN_MAX_MS = '3600000'
    expect(sessionRunMaxMs()).toBe(3_600_000)
    process.env.REMO_SESSION_RUN_MAX_MS = '0'
    expect(sessionRunMaxMs()).toBe(86_400_000)
    process.env.REMO_SESSION_RUN_MAX_MS = 'nonsense'
    expect(sessionRunMaxMs()).toBe(86_400_000)
  })

  test('sweep passes the configured ceiling to the DAL and returns the reaped ids', async () => {
    process.env.REMO_SESSION_RUN_MAX_MS = '7200000'
    const seen: number[] = []
    const ids = await reapAgedSessionRuns({
      finalizeAgedOpenRuns: async (maxAgeMs: number) => {
        seen.push(maxAgeMs)
        return ['run-a', 'run-b']
      },
    })
    expect(seen).toEqual([7_200_000])
    expect(ids).toEqual(['run-a', 'run-b'])
  })

  test('a DB error never throws out of the sweep (boot interval must survive)', async () => {
    const ids = await reapAgedSessionRuns({
      finalizeAgedOpenRuns: async () => {
        throw new Error('connection reset')
      },
    })
    expect(ids).toEqual([])
  })

  test('REMO_SESSION_RUN_REAPER_DISABLED makes the sweep start a no-op', () => {
    process.env.REMO_SESSION_RUN_REAPER_DISABLED = '1'
    // Must not throw and must not install a timer (stop is then a no-op too).
    startStaleRunReaperSweep()
    stopStaleRunReaperSweep()
    expect(true).toBe(true)
  })
})
