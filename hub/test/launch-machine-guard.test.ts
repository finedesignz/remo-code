/**
 * PTYCAP-04-07 Task 1: launchSessionForUser machine-origin option (D-09b).
 *
 * The primitive is shared with the HUMAN Telegram /doctor relaunch and /commands, which must
 * keep working during a halt. So the kill-switch predicate is consulted ONLY when the caller
 * passes `machine: true`. Controls module, DB, registry and the orchestrator primitive are
 * leaf-mocked; mock.module is process-global, so this file runs in its own bun process.
 */
import { describe, test, expect, beforeEach, mock } from 'bun:test'

process.env.JWT_SECRET = process.env.JWT_SECRET || 'x'.repeat(32)
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://localhost:5432/placeholder'

const s = {
  halted: null as null | { scope: string },
  lateHalted: null as null | { scope: string },
  lateCalls: 0,
  ended: [] as any[],
  haltCalls: [] as Array<{ userId: string; sessionId?: string }>,
  sqlCalls: 0,
  sessionRow: null as any,
  sends: [] as any[],
  supervisorsListed: 0,
  orchestratorArgs: [] as any[],
}

mock.module('../src/dispatch/automation-controls.ts', () => ({
  isAutomationHalted: async (a: { userId: string; sessionId?: string }) => {
    s.haltCalls.push(a)
    return s.halted ? { halted: true, scope: s.halted.scope } : { halted: false }
  },
  // QC B1: the fresh read immediately before session.start (only machine callers reach it).
  haltBeforeMachineSend: async () => {
    s.lateCalls++
    return s.lateHalted
      ? { ok: false, reason: `automation_halted:${s.lateHalted.scope}`, scope: s.lateHalted.scope }
      : { ok: true }
  },
}))
mock.module('../src/db/supervisor-dal.ts', () => ({
  listSupervisorsForUser: async () => {
    s.supervisorsListed++
    return [{ id: 'sup-1', hostname: 'devbox' }]
  },
  endRun: async (...a: any[]) => { s.ended.push(a) },
}))
mock.module('../src/db/postgres.ts', () => ({
  sql: async () => {
    s.sqlCalls++
    return s.sessionRow ? [s.sessionRow] : []
  },
}))
mock.module('../src/ws/supervisor-registry.ts', () => ({
  isSupervisorOnline: () => true,
  sendToSupervisor: (id: string, msg: any) => s.sends.push({ id, msg }),
  updateSupervisorState: async () => {},
}))
mock.module('../src/sessions/budget.ts', () => ({
  reserveSessionSlot: async () => ({ ok: true, run: { id: 'run-1' } }),
}))
mock.module('../src/db/dal.ts', () => ({
  getSessionSkipPermissions: async () => false,
}))
mock.module('../src/orchestrator/auto-launch.ts', () => ({
  launchOrchestrator: async (a: any) => {
    s.orchestratorArgs.push(a)
    return { ok: true, sessionId: 'sess-o', runId: 'run-o', supervisorId: 'sup-1', cwd: '/repos', reused: false }
  },
}))

const { launchSessionForUser } = await import('../src/telegram/launch.ts')

beforeEach(() => {
  s.halted = null
  s.lateHalted = null
  s.lateCalls = 0
  s.ended = []
  s.haltCalls = []
  s.sqlCalls = 0
  s.sends = []
  s.supervisorsListed = 0
  s.orchestratorArgs = []
  s.sessionRow = { id: 'sess-1', project_dir: '/repos/a', hostname: 'devbox', is_orchestrator: false }
})

describe('launchSessionForUser machine option', () => {
  test('machine + halted(user): refuses with automation_halted:user before any query, listing or send', async () => {
    s.halted = { scope: 'user' }
    const res = await launchSessionForUser({ userId: 'u1', sessionId: 'sess-1', machine: true })
    expect(res).toEqual({ ok: false, reason: 'automation_halted:user' })
    expect(s.haltCalls).toEqual([{ userId: 'u1', sessionId: 'sess-1' }])
    expect(s.sqlCalls).toBe(0)
    expect(s.supervisorsListed).toBe(0)
    expect(s.sends).toHaveLength(0)
  })

  test('machine + not halted: launch proceeds and session.start is sent', async () => {
    const res = await launchSessionForUser({ userId: 'u1', sessionId: 'sess-1', machine: true })
    expect(res.ok).toBe(true)
    expect(s.haltCalls).toHaveLength(1)
    expect(s.sends).toHaveLength(1)
    expect(s.sends[0].msg.type).toBe('session.start')
  })

  test('machine absent (HUMAN) with the predicate reporting halted: predicate NOT consulted, launch proceeds', async () => {
    s.halted = { scope: 'global' }
    const res = await launchSessionForUser({ userId: 'u1', sessionId: 'sess-1' })
    expect(res.ok).toBe(true)
    expect(s.haltCalls).toHaveLength(0)
    expect(s.sends).toHaveLength(1)
  })

  test('orchestrator session: machine true is threaded to launchOrchestrator; absent stays absent', async () => {
    s.sessionRow = { id: 'sess-o', project_dir: '/repos', hostname: 'devbox', is_orchestrator: true }
    await launchSessionForUser({ userId: 'u1', sessionId: 'sess-o', machine: true })
    expect(s.orchestratorArgs[0].machine).toBe(true)
    await launchSessionForUser({ userId: 'u1', sessionId: 'sess-o' })
    expect(s.orchestratorArgs[1].machine).toBeUndefined()
  })

  test('QC B1: an engage landing after the early check (session found, slot reserved) stops the send and closes the run', async () => {
    s.lateHalted = { scope: 'global' }
    const res = await launchSessionForUser({ userId: 'u1', sessionId: 'sess-1', machine: true })
    expect(res).toEqual({ ok: false, reason: 'automation_halted:global' })
    expect(s.haltCalls).toHaveLength(1) // the early check passed
    expect(s.lateCalls).toBe(1)
    expect(s.sends).toHaveLength(0)
    expect(s.ended).toHaveLength(1)
    expect(s.ended[0][0]).toBe('run-1')
  })

  test('QC B1: the HUMAN path never reads the switch before its send', async () => {
    s.lateHalted = { scope: 'global' }
    const res = await launchSessionForUser({ userId: 'u1', sessionId: 'sess-1' })
    expect(res.ok).toBe(true)
    expect(s.lateCalls).toBe(0)
    expect(s.sends).toHaveLength(1)
  })
})
