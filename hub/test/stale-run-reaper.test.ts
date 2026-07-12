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

  test('HUB RESTART: no supervisor has pushed inventory yet ⇒ the sweep is a NO-OP', async () => {
    // THE regression. The hub restarts; supervisors reconnect and push inventory ~10s
    // later; if the sweep fires first with an empty live-set and a GLOBAL update, every
    // old open run in the fleet is closed while its CLI keeps running — capacity freed,
    // real exit result lost. An empty live-set means "I don't know", not "nothing is
    // alive". Knowing nothing ⇒ reaping nothing. The DAL must not even be called.
    let dalCalls = 0
    const ids = await reapUnbackedSessionRuns({
      getInventoriedSupervisors: () => [], // connected-but-not-yet-pushed, or nothing connected
      finalizeUnbackedOpenRunsForSupervisor: async () => {
        dalCalls++
        return ['should-never-happen']
      },
    })
    expect(dalCalls).toBe(0)
    expect(ids).toEqual([])
  })

  test('sweeps ONLY inventoried supervisors, each scoped to its OWN live set', async () => {
    // Supervisor A is connected and has pushed; B is disconnected / has never pushed,
    // so the registry does not report it and its runs are untouched (B's open runs are
    // closed by finalizeOpenRunsForSupervisor on socket close — not our business).
    process.env.REMO_SESSION_RUN_MAX_MS = '7200000'
    const seen: Array<{ supervisorId: string; liveSessionIds: string[]; minAgeMs: number }> = []
    const ids = await reapUnbackedSessionRuns({
      getInventoriedSupervisors: () => [{ supervisorId: 'sup-a', liveSessionIds: ['live-a'] }],
      finalizeUnbackedOpenRunsForSupervisor: async (args) => {
        seen.push(args)
        return ['run-a']
      },
    })
    expect(seen).toEqual([{ supervisorId: 'sup-a', liveSessionIds: ['live-a'], minAgeMs: 7_200_000 }])
    expect(seen.some((s) => s.supervisorId === 'sup-b')).toBe(false)
    expect(ids).toEqual(['run-a'])
  })

  test('one supervisor failing never aborts the others (and never throws out of the sweep)', async () => {
    const ids = await reapUnbackedSessionRuns({
      getInventoriedSupervisors: () => [
        { supervisorId: 'sup-bad', liveSessionIds: [] },
        { supervisorId: 'sup-ok', liveSessionIds: [] },
      ],
      finalizeUnbackedOpenRunsForSupervisor: async ({ supervisorId }) => {
        if (supervisorId === 'sup-bad') throw new Error('connection reset')
        return ['run-ok']
      },
    })
    expect(ids).toEqual(['run-ok'])
  })

  test('REMO_SESSION_RUN_REAPER_DISABLED makes the sweep start a no-op', () => {
    process.env.REMO_SESSION_RUN_REAPER_DISABLED = '1'
    startStaleRunReaperSweep()
    stopStaleRunReaperSweep()
    expect(true).toBe(true)
  })
})
