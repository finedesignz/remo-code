/**
 * PTYCAP-04-07 Task 1: auto-launch kill-switch ordering (D-09b, F-4).
 *
 * - maybeAutoLaunchOrchestrator checks the halt BEFORE stamping its 5s debounce, so a halted
 *   attempt does not latch the debounce and delay the post-release relaunch (T-04-34).
 * - launchOrchestrator honours the halt only for machine callers (human POST /start unaffected).
 * Everything the launch touches is leaf-mocked; per-file bun process (process-global mocks).
 */
import { describe, test, expect, beforeEach, mock } from 'bun:test'

process.env.JWT_SECRET = process.env.JWT_SECRET || 'x'.repeat(32)
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://localhost:5432/placeholder'

const s = {
  halted: false,
  lateHalted: false,
  lateCalls: 0,
  launchable: false,
  sends: [] as any[],
  ended: [] as any[],
  existing: true,
  haltCalls: 0,
  getStateCalls: 0,
  dbTouched: 0,
  prefs: { orchestrator_enabled: true, orchestrator_disabled_explicitly: false, orchestrator_name: 'O', orchestrator_custom_instructions: null as string | null },
}

mock.module('../src/dispatch/automation-controls.ts', () => ({
  isAutomationHalted: async () => {
    s.haltCalls++
    return s.halted ? { halted: true, scope: 'global' } : { halted: false }
  },
  // QC B1: fresh read immediately before session.start (machine launches only)
  haltBeforeMachineSend: async () => {
    s.lateCalls++
    return s.lateHalted ? { ok: false, reason: 'automation_halted:global', scope: 'global' } : { ok: true }
  },
}))
mock.module('../src/db/orchestrator-dal.ts', () => ({
  getOrchestratorState: async () => {
    s.getStateCalls++
    return s.prefs
  },
  // an existing row makes maybeAutoLaunch stop right after the debounce stamp ("already_exists")
  findOpenOrchestratorSession: async () => (s.existing ? { id: 'sess-x', status: 'offline' } : null),
}))
mock.module('../src/db/postgres.ts', () => ({
  sql: Object.assign(async () => { s.dbTouched++; return [] }, {
    begin: async () => {
      s.dbTouched++
      return s.launchable
        ? { kind: 'launched', sessionId: 'sess-o', runId: 'run-o', createdRow: false }
        : { kind: 'no_supervisor' }
    },
  }),
}))
mock.module('../src/db/supervisor-dal.ts', () => ({
  listSupervisorsForUser: async () => {
    s.dbTouched++
    return s.launchable ? [{ id: 'sup-1', hostname: 'h', roots: ['/r'] }] : []
  },
  endRun: async (...a: any[]) => { s.ended.push(a) },
}))
mock.module('../src/ws/supervisor-registry.ts', () => ({
  getSupervisor: () => undefined,
  isSupervisorOnline: () => s.launchable,
  sendToSupervisor: (id: string, msg: any) => { s.sends.push({ id, msg }) },
  updateSupervisorState: async () => {},
}))
mock.module('../src/ws/idle-teardown.ts', () => ({ markOrchestratorSession: () => {} }))
mock.module('../src/db/dal.ts', () => ({ getSessionSkipPermissions: async () => false }))

const mod = await import('../src/orchestrator/auto-launch.ts')

beforeEach(() => {
  s.halted = false
  s.lateHalted = false
  s.lateCalls = 0
  s.launchable = false
  s.sends = []
  s.ended = []
  s.existing = true
  s.haltCalls = 0
  s.getStateCalls = 0
  s.dbTouched = 0
  process.env.REMO_ORCHESTRATOR_AUTOLAUNCH = 'true'
  mod.__resetAutoLaunchDebounceForTests()
})

describe('maybeAutoLaunchOrchestrator halt ordering', () => {
  test('halted -> automation_halted and the debounce is NOT stamped', async () => {
    s.halted = true
    const first = await mod.maybeAutoLaunchOrchestrator({ userId: 'u1', supervisorId: 'sup-1' })
    expect(first).toEqual({ launched: false, reason: 'automation_halted' })
    expect(s.getStateCalls).toBe(0)
    // predicate clears; an immediate second call must get past the debounce
    s.halted = false
    const second = await mod.maybeAutoLaunchOrchestrator({ userId: 'u1', supervisorId: 'sup-1' })
    expect(second.reason).not.toBe('debounced')
    expect(second.reason).toBe('already_exists')
  })

  test('feature flag off still wins before the halt check', async () => {
    process.env.REMO_ORCHESTRATOR_AUTOLAUNCH = 'false'
    s.halted = true
    const r = await mod.maybeAutoLaunchOrchestrator({ userId: 'u1', supervisorId: 'sup-1' })
    expect(r.reason).toBe('feature_flag_off')
    expect(s.haltCalls).toBe(0)
  })

  test('passes machine:true to launchOrchestrator (halt consulted a second time inside the primitive)', async () => {
    s.existing = false
    await mod.maybeAutoLaunchOrchestrator({ userId: 'u1', supervisorId: 'sup-1' })
    expect(s.haltCalls).toBe(2)
  })

  test('not halted: second immediate call is debounced (debounce still works)', async () => {
    await mod.maybeAutoLaunchOrchestrator({ userId: 'u1', supervisorId: 'sup-1' })
    const again = await mod.maybeAutoLaunchOrchestrator({ userId: 'u1', supervisorId: 'sup-1' })
    expect(again.reason).toBe('debounced')
  })
})

describe('launchOrchestrator machine option', () => {
  test('machine + halted -> automation_halted before any DB write', async () => {
    s.halted = true
    const r = await mod.launchOrchestrator({ userId: 'u1', machine: true })
    expect(r).toEqual({ ok: false, reason: 'automation_halted' })
    expect(s.getStateCalls).toBe(0)
    expect(s.dbTouched).toBe(0)
  })

  test('machine absent (human /start) ignores the predicate', async () => {
    s.halted = true
    const r = await mod.launchOrchestrator({ userId: 'u1' })
    expect(s.haltCalls).toBe(0)
    expect(r.ok === false && r.reason === 'automation_halted').toBe(false)
  })

  test('QC B1: an engage landing after the early check and the locked transaction stops the send and closes the run', async () => {
    s.launchable = true
    s.existing = false
    s.lateHalted = true
    const r = await mod.launchOrchestrator({ userId: 'u1', machine: true })
    expect(r).toEqual({ ok: false, reason: 'automation_halted' })
    expect(s.haltCalls).toBe(1) // the early check passed
    expect(s.lateCalls).toBe(1)
    expect(s.sends).toHaveLength(0)
    expect(s.ended).toHaveLength(1)
    expect(s.ended[0][0]).toBe('run-o')
  })

  test('QC B1 control: not halted -> session.start is sent; the human path never reads the switch', async () => {
    s.launchable = true
    s.existing = false
    const m = await mod.launchOrchestrator({ userId: 'u1', machine: true })
    expect(m.ok).toBe(true)
    expect(s.sends).toHaveLength(1)
    expect(s.lateCalls).toBe(1)
    s.sends = []
    s.lateCalls = 0
    s.lateHalted = true
    const h = await mod.launchOrchestrator({ userId: 'u1' })
    expect(h.ok).toBe(true)
    expect(s.lateCalls).toBe(0)
    expect(s.sends).toHaveLength(1)
  })
})
