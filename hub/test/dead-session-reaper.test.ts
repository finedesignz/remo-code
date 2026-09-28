/**
 * fix/dead-session-online — a channel whose CLI exited (absent from its host
 * supervisor's FRESH session_inventory for the grace) is flipped offline so it
 * restarts. Unknown liveness (no fresh inventory for the host) never reaps.
 * DB-free: every IO seam is injected.
 */
import { describe, test, expect, beforeEach } from 'bun:test'

import {
  reapDeadSessions,
  DEAD_SESSION_GRACE_MS,
  _resetDeadSessionReaperState,
  type DeadSessionReaperDeps,
  type DeadSessionRow,
} from '../src/ws/dead-session-reaper.ts'

function harness(opts: {
  channels: string[]
  rows: Record<string, DeadSessionRow | null>
  inventory: Array<{ liveSessionIds: Set<string> }>
}) {
  const calls = { shutdown: [] as string[], unregister: [] as string[], status: [] as string[], release: [] as string[] }
  const deps: Partial<DeadSessionReaperDeps> = {
    listChannelSessionIds: () => opts.channels,
    loadSession: async (id) => opts.rows[id] ?? null,
    hostInventory: () => opts.inventory,
    shutdownChannel: (id) => void calls.shutdown.push(id),
    unregisterChannel: (id) => void calls.unregister.push(id),
    setSessionStatus: async (id, s) => void calls.status.push(`${id}:${s}`),
    releaseSlot: async (id) => void calls.release.push(id),
    notifyOffline: () => {},
  }
  return { deps, calls }
}

const online: DeadSessionRow = { user_id: 'u1', status: 'online', hostname: 'DEV-BOX' }

beforeEach(() => _resetDeadSessionReaperState())

describe('reapDeadSessions', () => {
  test('absent from fresh inventory past the grace → shutdown, offline, slot released', async () => {
    const { deps, calls } = harness({
      channels: ['dead'],
      rows: { dead: online },
      inventory: [{ liveSessionIds: new Set(['other']) }],
    })
    const t0 = 1_000_000
    expect(await reapDeadSessions(t0, deps)).toEqual([]) // starts the grace clock
    expect(await reapDeadSessions(t0 + DEAD_SESSION_GRACE_MS - 1, deps)).toEqual([])
    expect(await reapDeadSessions(t0 + DEAD_SESSION_GRACE_MS, deps)).toEqual(['dead'])
    expect(calls.shutdown).toEqual(['dead'])
    expect(calls.unregister).toEqual(['dead'])
    expect(calls.status).toEqual(['dead:offline'])
    expect(calls.release).toEqual(['dead'])
  })

  test('present in inventory → never reaped', async () => {
    const { deps, calls } = harness({
      channels: ['alive'],
      rows: { alive: online },
      inventory: [{ liveSessionIds: new Set(['alive']) }],
    })
    await reapDeadSessions(0, deps)
    expect(await reapDeadSessions(DEAD_SESSION_GRACE_MS * 10, deps)).toEqual([])
    expect(calls.shutdown).toEqual([])
  })

  test('no fresh inventory for the host (unknown) → never reaped', async () => {
    const { deps, calls } = harness({ channels: ['s'], rows: { s: online }, inventory: [] })
    await reapDeadSessions(0, deps)
    expect(await reapDeadSessions(DEAD_SESSION_GRACE_MS * 10, deps)).toEqual([])
    expect(calls.status).toEqual([])
  })

  test('reappearing in inventory resets the grace clock', async () => {
    const inventory = [{ liveSessionIds: new Set<string>() }]
    const { deps } = harness({ channels: ['s'], rows: { s: online }, inventory })
    await reapDeadSessions(0, deps)
    inventory[0].liveSessionIds.add('s')
    await reapDeadSessions(DEAD_SESSION_GRACE_MS / 2, deps)
    inventory[0].liveSessionIds.delete('s')
    await reapDeadSessions(DEAD_SESSION_GRACE_MS, deps) // clock restarts here
    expect(await reapDeadSessions(DEAD_SESSION_GRACE_MS * 1.5, deps)).toEqual([])
    expect(await reapDeadSessions(DEAD_SESSION_GRACE_MS * 2, deps)).toEqual(['s'])
  })

  test('hostname-less or already-offline rows are left to other paths', async () => {
    const { deps } = harness({
      channels: ['ghost', 'off'],
      rows: {
        ghost: { user_id: 'u1', status: 'online', hostname: null },
        off: { user_id: 'u1', status: 'offline', hostname: 'DEV-BOX' },
      },
      inventory: [{ liveSessionIds: new Set() }],
    })
    await reapDeadSessions(0, deps)
    expect(await reapDeadSessions(DEAD_SESSION_GRACE_MS * 10, deps)).toEqual([])
  })
})
