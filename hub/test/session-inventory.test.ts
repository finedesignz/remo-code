/**
 * Bug A (2026-05-28) — supervisor session_inventory push + hub fold.
 *
 * Unit-only: exercises the Zod contract, supervisor-registry storage helpers,
 * the change-detection diff, and the `getActiveSessionIdsForUser` lookup that
 * `GET /api/sessions` uses. No DB, no real WS.
 */
import { describe, test, expect, beforeEach } from 'bun:test'
import { SupervisorSessionInventory } from '../src/ws/supervisor-protocol'
import {
  registerSupervisor,
  unregisterSupervisor,
  setSupervisorSessionInventory,
  getActiveSessionIdsForUser,
  findSupervisorForSession,
} from '../src/ws/supervisor-registry'

// Minimal ServerWebSocket stub — registry only uses .send/.close which we
// stub as no-ops so the test never touches a real socket.
function makeWsStub() {
  return { send: () => {}, close: () => {} } as any
}

describe('SupervisorSessionInventory schema', () => {
  test('accepts minimal valid payload', () => {
    const r = SupervisorSessionInventory.safeParse({
      type: 'session_inventory',
      sessions: [{
        session_id: 'sess_a',
        cli_kind: 'claude',
        project_dir: '/repo',
        pid: 1234,
        started_at: '2026-05-28T00:00:00Z',
        last_activity_at: null,
        status: 'running',
      }],
    })
    expect(r.success).toBe(true)
  })

  test('accepts empty sessions array (supervisor with no live runners)', () => {
    const r = SupervisorSessionInventory.safeParse({
      type: 'session_inventory',
      sessions: [],
    })
    expect(r.success).toBe(true)
  })

  test('rejects invalid status enum', () => {
    const r = SupervisorSessionInventory.safeParse({
      type: 'session_inventory',
      sessions: [{
        session_id: 'sess_a', cli_kind: 'claude', project_dir: '/r',
        pid: null, started_at: '2026-05-28T00:00:00Z', last_activity_at: null,
        status: 'frobbed',
      }],
    })
    expect(r.success).toBe(false)
  })

  test('caps array at 64 entries (payload-size guard)', () => {
    const big = Array.from({ length: 65 }, (_, i) => ({
      session_id: `s${i}`, cli_kind: 'claude' as const, project_dir: '/r',
      pid: null, started_at: '2026-05-28T00:00:00Z', last_activity_at: null,
      status: 'running' as const,
    }))
    const r = SupervisorSessionInventory.safeParse({ type: 'session_inventory', sessions: big })
    expect(r.success).toBe(false)
  })
})

describe('supervisor-registry inventory helpers', () => {
  const supId = 'sup_inv_test'
  const userId = 'user_inv_test'

  beforeEach(() => {
    // Wipe any leftover entries from prior tests.
    unregisterSupervisor(supId)
    registerSupervisor({
      ws: makeWsStub(),
      supervisorId: supId,
      userId,
      apiKeyId: 'apikey_inv_test',
      roots: [],
      hostname: 'unit-host',
    })
  })

  test('first inventory marks every entry as changed', () => {
    const { changedSessionIds, userId: oid } = setSupervisorSessionInventory(
      supId,
      [
        { session_id: 'a', cli_kind: 'claude', project_dir: '/r', pid: 1, started_at: 't', last_activity_at: null, status: 'running' },
        { session_id: 'b', cli_kind: 'claude', project_dir: '/r', pid: 2, started_at: 't', last_activity_at: null, status: 'running' },
      ],
      '2026-05-28T00:00:00Z',
    )
    expect(new Set(changedSessionIds)).toEqual(new Set(['a', 'b']))
    expect(oid).toBe(userId)
  })

  test('unchanged push yields no changed ids', () => {
    const initial = [
      { session_id: 'a', cli_kind: 'claude' as const, project_dir: '/r', pid: 1, started_at: 't', last_activity_at: null, status: 'running' as const },
    ]
    setSupervisorSessionInventory(supId, initial, '2026-05-28T00:00:00Z')
    const { changedSessionIds } = setSupervisorSessionInventory(supId, initial, '2026-05-28T00:00:10Z')
    expect(changedSessionIds).toEqual([])
  })

  test('status transition is flagged', () => {
    setSupervisorSessionInventory(supId, [
      { session_id: 'a', cli_kind: 'claude', project_dir: '/r', pid: 1, started_at: 't', last_activity_at: null, status: 'spawning' },
    ], 't0')
    const { changedSessionIds } = setSupervisorSessionInventory(supId, [
      { session_id: 'a', cli_kind: 'claude', project_dir: '/r', pid: 1, started_at: 't', last_activity_at: null, status: 'running' },
    ], 't1')
    expect(changedSessionIds).toEqual(['a'])
  })

  test('disappearing session is flagged', () => {
    setSupervisorSessionInventory(supId, [
      { session_id: 'a', cli_kind: 'claude', project_dir: '/r', pid: 1, started_at: 't', last_activity_at: null, status: 'running' },
      { session_id: 'b', cli_kind: 'claude', project_dir: '/r', pid: 2, started_at: 't', last_activity_at: null, status: 'running' },
    ], 't0')
    const { changedSessionIds } = setSupervisorSessionInventory(supId, [
      { session_id: 'a', cli_kind: 'claude', project_dir: '/r', pid: 1, started_at: 't', last_activity_at: null, status: 'running' },
    ], 't1')
    expect(changedSessionIds).toEqual(['b'])
  })

  test('getActiveSessionIdsForUser returns union across user supervisors', () => {
    setSupervisorSessionInventory(supId, [
      { session_id: 'a', cli_kind: 'claude', project_dir: '/r', pid: 1, started_at: 't', last_activity_at: null, status: 'running' },
      { session_id: 'b', cli_kind: 'claude', project_dir: '/r', pid: 2, started_at: 't', last_activity_at: null, status: 'idle' },
    ], 't0')
    const ids = getActiveSessionIdsForUser(userId)
    expect(ids.has('a')).toBe(true)
    expect(ids.has('b')).toBe(true)
    expect(ids.has('nope')).toBe(false)
  })

  test('findSupervisorForSession resolves owner', () => {
    setSupervisorSessionInventory(supId, [
      { session_id: 'a', cli_kind: 'claude', project_dir: '/r', pid: 1, started_at: 't', last_activity_at: null, status: 'running' },
    ], 't0')
    const owner = findSupervisorForSession('a')
    expect(owner).not.toBeNull()
    expect(owner?.supervisorId).toBe(supId)
    expect(owner?.userId).toBe(userId)
  })

  test('returns no-op when supervisor not registered', () => {
    const { changedSessionIds, userId: oid } = setSupervisorSessionInventory(
      'sup_unknown',
      [],
      't0',
    )
    expect(changedSessionIds).toEqual([])
    expect(oid).toBeNull()
  })
})
