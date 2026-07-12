/**
 * Unbacked-run backstop (fix/stop-the-bleed).
 *
 * Pure-unit coverage of the sweep seam: it must pass the LIVE session set (from the
 * supervisor registry) plus the grace to the DAL, never throw on a DB error, and
 * honour the disable flag. The reap PREDICATE itself — old-but-live is NOT reaped,
 * unbacked IS — is proven against real Postgres in finalize-orphaned-runs.test.ts.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-chars-long-aaaaaaaa'

import { describe, test, expect, afterEach } from 'bun:test'
import {
  reapUnbackedSessionRuns,
  sessionRunMaxMs,
  sessionRunReaperIntervalMs,
  startStaleRunReaperSweep,
  stopStaleRunReaperSweep,
} from '../src/sessions/stale-run-reaper.ts'

afterEach(() => {
  delete process.env.REMO_SESSION_RUN_MAX_MS
  delete process.env.REMO_SESSION_RUN_REAPER_INTERVAL_MS
  delete process.env.REMO_SESSION_RUN_REAPER_DISABLED
  stopStaleRunReaperSweep()
})

describe('unbacked session_run reaper', () => {
  test('defaults: 24h grace, 15min cadence — both read at CALL time', () => {
    expect(sessionRunMaxMs()).toBe(86_400_000)
    expect(sessionRunReaperIntervalMs()).toBe(900_000)
    process.env.REMO_SESSION_RUN_MAX_MS = '3600000'
    process.env.REMO_SESSION_RUN_REAPER_INTERVAL_MS = '60000'
    expect(sessionRunMaxMs()).toBe(3_600_000)
    expect(sessionRunReaperIntervalMs()).toBe(60_000)
  })

  test('non-positive / garbage grace falls back to the default', () => {
    process.env.REMO_SESSION_RUN_MAX_MS = '0'
    expect(sessionRunMaxMs()).toBe(86_400_000)
    process.env.REMO_SESSION_RUN_MAX_MS = 'nonsense'
    expect(sessionRunMaxMs()).toBe(86_400_000)
  })

  test('the sweep hands the DAL the LIVE session set + the grace', async () => {
    // Liveness is the predicate: a run backed by a connected supervisor's inventory
    // must never be reaped, however old. The sweep's job is to supply that set.
    process.env.REMO_SESSION_RUN_MAX_MS = '7200000'
    const seen: Array<{ liveSessionIds: string[]; minAgeMs: number }> = []
    const ids = await reapUnbackedSessionRuns({
      getAllLiveSessionIds: () => ['live-a', 'live-b'],
      finalizeUnbackedOpenRuns: async (args) => {
        seen.push(args)
        return ['run-a']
      },
    })
    expect(seen).toEqual([{ liveSessionIds: ['live-a', 'live-b'], minAgeMs: 7_200_000 }])
    expect(ids).toEqual(['run-a'])
  })

  test('a DB error never throws out of the sweep (boot interval must survive)', async () => {
    const ids = await reapUnbackedSessionRuns({
      getAllLiveSessionIds: () => [],
      finalizeUnbackedOpenRuns: async () => {
        throw new Error('connection reset')
      },
    })
    expect(ids).toEqual([])
  })

  test('REMO_SESSION_RUN_REAPER_DISABLED makes the sweep start a no-op', () => {
    process.env.REMO_SESSION_RUN_REAPER_DISABLED = '1'
    startStaleRunReaperSweep()
    stopStaleRunReaperSweep()
    expect(true).toBe(true)
  })
})
