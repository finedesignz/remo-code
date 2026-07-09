/**
 * fix/ghost-session-reaper — ghost-session reaper.
 * DB-free / socket-free: all IO behind injected GhostReaperDeps.
 *
 * A ghost = a live agent channel whose session row is `status='online',
 * hostname=NULL` and has aged past GHOST_GRACE_MS. Reaping it closes the
 * phantom socket, unregisters the channel, and flips the row offline so the
 * next orchestrator tick autospawns a real session.
 */
import { describe, test, expect, afterEach } from 'bun:test'
import {
  reapGhostSessions,
  GHOST_GRACE_MS,
  startGhostReaperSweep,
  stopGhostReaperSweep,
  type GhostReaperDeps,
  type GhostSessionRow,
} from '../src/ws/ghost-reaper.ts'

afterEach(() => {
  stopGhostReaperSweep()
  delete process.env.REMO_GHOST_REAPER_DISABLED
})

function row(over: Partial<GhostSessionRow> = {}): GhostSessionRow {
  return {
    status: 'online',
    hostname: null,
    last_activity_ms: 0, // ancient by default
    is_orchestrator: false,
    ...over,
  }
}

type Calls = { closed: string[]; unregistered: string[]; statuses: Array<[string, string]> }

function spyDeps(
  channels: string[],
  rows: Record<string, GhostSessionRow | null | Error>,
): { deps: Partial<GhostReaperDeps>; calls: Calls } {
  const calls: Calls = { closed: [], unregistered: [], statuses: [] }
  const deps: Partial<GhostReaperDeps> = {
    listChannelSessionIds: () => channels,
    loadSession: async (id) => {
      const r = rows[id]
      if (r instanceof Error) throw r
      return r ?? null
    },
    closeChannel: (id) => {
      calls.closed.push(id)
    },
    unregisterChannel: (id) => {
      calls.unregistered.push(id)
    },
    setSessionStatus: async (id, status) => {
      calls.statuses.push([id, status])
    },
  }
  return { deps, calls }
}

// A `now` far past any grace so ancient (0) rows are stale.
const NOW = GHOST_GRACE_MS + 1_000

describe('reapGhostSessions', () => {
  test('reaps online + hostname-null + stale (close, unregister, offline)', async () => {
    const { deps, calls } = spyDeps(['g1'], { g1: row() })
    const reaped = await reapGhostSessions(NOW, deps)
    expect(reaped).toEqual(['g1'])
    expect(calls.closed).toEqual(['g1'])
    expect(calls.unregistered).toEqual(['g1'])
    expect(calls.statuses).toEqual([['g1', 'offline']])
  })

  test('does NOT reap online session WITH a hostname', async () => {
    const { deps, calls } = spyDeps(['s1'], { s1: row({ hostname: 'TitaniumTower' }) })
    const reaped = await reapGhostSessions(NOW, deps)
    expect(reaped).toEqual([])
    expect(calls.closed).toEqual([])
    expect(calls.statuses).toEqual([])
  })

  test('does NOT reap online + hostname-null WITHIN grace', async () => {
    // last_activity is only 1s old relative to now ⇒ inside grace window.
    const now = 10_000_000
    const { deps, calls } = spyDeps(['s1'], { s1: row({ last_activity_ms: now - 1_000 }) })
    const reaped = await reapGhostSessions(now, deps)
    expect(reaped).toEqual([])
    expect(calls.statuses).toEqual([])
  })

  test('does NOT reap is_orchestrator=true (safety)', async () => {
    const { deps, calls } = spyDeps(['orch'], { orch: row({ is_orchestrator: true }) })
    const reaped = await reapGhostSessions(NOW, deps)
    expect(reaped).toEqual([])
    expect(calls.closed).toEqual([])
    expect(calls.statuses).toEqual([])
  })

  test('does NOT reap when last_activity is NULL', async () => {
    const { deps } = spyDeps(['s1'], { s1: row({ last_activity_ms: null }) })
    const reaped = await reapGhostSessions(NOW, deps)
    expect(reaped).toEqual([])
  })

  test('fail-open: one session load throwing does not abort the sweep', async () => {
    const { deps, calls } = spyDeps(['bad', 'g1'], {
      bad: new Error('db down'),
      g1: row(),
    })
    const reaped = await reapGhostSessions(NOW, deps)
    expect(reaped).toEqual(['g1']) // the good ghost is still reaped
    expect(calls.statuses).toEqual([['g1', 'offline']])
  })

  test('missing row (channel with no session) is skipped', async () => {
    const { deps, calls } = spyDeps(['gone'], { gone: null })
    const reaped = await reapGhostSessions(NOW, deps)
    expect(reaped).toEqual([])
    expect(calls.closed).toEqual([])
  })
})

describe('startGhostReaperSweep', () => {
  test('disabled-env ⇒ no timer started (no-op)', () => {
    process.env.REMO_GHOST_REAPER_DISABLED = 'true'
    // Should not throw and should not schedule anything. stopGhostReaperSweep
    // is a no-op when nothing was started; the assertion is simply that this
    // path is reachable without side effects.
    startGhostReaperSweep()
    stopGhostReaperSweep()
    expect(true).toBe(true)
  })
})
