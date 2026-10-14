/**
 * PTYCAP-07-04 Task 1 (AM-F1-4): launchSessionForUser closes the supervisor run it reserved on
 * EVERY non-launch exit after the reservation, so a failed spawn cannot leak a concurrency slot.
 * mock.module is process-global: this file runs in its own bun process (check-baseline) and
 * restores on exit.
 */
import { describe, test, expect, beforeEach, afterAll, mock } from 'bun:test'

process.env.JWT_SECRET = process.env.JWT_SECRET || 'x'.repeat(32)
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://localhost:5432/placeholder'

const s = {
  lateHalted: null as null | { scope: string },
  ended: [] as any[],
  sessionRow: null as any,
  sendThrows: null as null | string,
  skipPermsThrows: null as null | string,
  reservation: { ok: true, run: { id: 'run-1' } } as any,
}

mock.module('../src/dispatch/automation-controls.ts', () => ({
  isAutomationHalted: async () => ({ halted: false }),
  haltBeforeMachineSend: async () =>
    s.lateHalted
      ? { ok: false, reason: `automation_halted:${s.lateHalted.scope}`, scope: s.lateHalted.scope }
      : { ok: true },
}))
mock.module('../src/db/supervisor-dal.ts', () => ({
  listSupervisorsForUser: async () => [{ id: 'sup-1', hostname: 'devbox' }],
  endRun: async (...a: any[]) => {
    s.ended.push(a)
  },
}))
mock.module('../src/db/postgres.ts', () => ({
  sql: async () => (s.sessionRow ? [s.sessionRow] : []),
}))
mock.module('../src/ws/supervisor-registry.ts', () => ({
  isSupervisorOnline: () => true,
  sendToSupervisor: () => {
    if (s.sendThrows) throw new Error(s.sendThrows)
  },
  updateSupervisorState: async () => {},
}))
mock.module('../src/sessions/budget.ts', () => ({
  reserveSessionSlot: async () => s.reservation,
}))
mock.module('../src/db/dal.ts', () => ({
  getSessionSkipPermissions: async () => {
    if (s.skipPermsThrows) throw new Error(s.skipPermsThrows)
    return false
  },
}))
mock.module('../src/orchestrator/auto-launch.ts', () => ({
  launchOrchestrator: async () => ({ ok: false, reason: 'disabled' }),
}))

afterAll(() => {
  mock.restore()
})

const { launchSessionForUser } = await import('../src/telegram/launch.ts')

beforeEach(() => {
  s.lateHalted = null
  s.ended = []
  s.sendThrows = null
  s.skipPermsThrows = null
  s.reservation = { ok: true, run: { id: 'run-1' } }
  s.sessionRow = { id: 'sess-1', project_dir: '/repos/a', hostname: 'devbox', is_orchestrator: false }
})

describe('launchSessionForUser run-leak closure (AM-F1-4)', () => {
  test('send_failed after a reservation: result send_failed AND endRun once with the run id', async () => {
    s.sendThrows = 'ws closed'
    const res = await launchSessionForUser({ userId: 'u1', sessionId: 'sess-1', machine: true })
    expect(res).toEqual({ ok: false, reason: 'send_failed', error: 'ws closed' })
    expect(s.ended).toHaveLength(1)
    expect(s.ended[0][0]).toBe('run-1')
    expect(s.ended[0][1]).toBeNull()
    expect(String(s.ended[0][2])).toContain('send_failed')
  })

  test('send_failed also closes the run for a human (non-machine) caller', async () => {
    s.sendThrows = 'boom'
    const res = await launchSessionForUser({ userId: 'u1', sessionId: 'sess-1' })
    expect(res.ok).toBe(false)
    expect(s.ended).toHaveLength(1)
  })

  test('a throw between reservation and send (skip-permissions read): internal_error AND endRun once', async () => {
    s.skipPermsThrows = 'db down'
    const res = await launchSessionForUser({ userId: 'u1', sessionId: 'sess-1', machine: true })
    expect(res).toEqual({ ok: false, reason: 'internal_error', error: 'db down' })
    expect(s.ended).toHaveLength(1)
    expect(s.ended[0][0]).toBe('run-1')
    expect(s.ended[0][1]).toBeNull()
    expect(String(s.ended[0][2])).toContain('internal_error')
  })

  test('success never calls endRun', async () => {
    const res = await launchSessionForUser({ userId: 'u1', sessionId: 'sess-1', machine: true })
    expect(res.ok).toBe(true)
    expect(s.ended).toHaveLength(0)
  })

  test('halt unwind still closes the run exactly once (not twice)', async () => {
    s.lateHalted = { scope: 'global' }
    const res = await launchSessionForUser({ userId: 'u1', sessionId: 'sess-1', machine: true })
    expect(res).toEqual({ ok: false, reason: 'automation_halted:global' })
    expect(s.ended).toHaveLength(1)
    expect(s.ended[0][0]).toBe('run-1')
  })

  test('pre-reservation failures call endRun zero times', async () => {
    s.reservation = { ok: false, reason: 'at_capacity', running: 3, cap: 3 }
    const cap = await launchSessionForUser({ userId: 'u1', sessionId: 'sess-1', machine: true })
    expect(cap).toEqual({ ok: false, reason: 'at_capacity', running: 3, cap: 3 })

    s.sessionRow = null
    const nf = await launchSessionForUser({ userId: 'u1', sessionId: 'sess-1', machine: true })
    expect(nf).toEqual({ ok: false, reason: 'session_not_found' })

    s.sessionRow = { id: 'sess-1', project_dir: null, hostname: 'devbox', is_orchestrator: false }
    const nd = await launchSessionForUser({ userId: 'u1', sessionId: 'sess-1', machine: true })
    expect(nd).toEqual({ ok: false, reason: 'no_project_dir' })

    expect(s.ended).toHaveLength(0)
  })
})
