/**
 * orchestrator-autolaunch (2026-05-28) — unit tests for the shared
 * `launchOrchestrator` primitive + the `maybeAutoLaunchOrchestrator` hook.
 *
 * Mock-based (no DB) so they run in the default `bun test` baseline. They
 * assert the BEHAVIOR the feature contract depends on:
 *
 *   - disabled / explicitly-disabled user → no launch, no key mint.
 *   - enabled + no row → creates one session row, reserves a slot, creates a
 *     run row, mints the key, sends the orchestrator `session.start`.
 *   - concurrent connect (row appears between find + insert → 23505) → reuses
 *     the winner's row, exactly one launch payload, no second session insert.
 *   - cost-cap `at_capacity` → no run row, no key mint, no send.
 *   - no online roots → skip, no throw.
 *   - maybeAutoLaunch no-ops when an open orchestrator row already exists
 *     (orphan-resume owns the run respawn — no double-spawn).
 *   - the launched session id is marked idle-teardown-exempt.
 *
 * NOTE: these files use `mock.module` which is process-global in Bun — run
 * in isolation via `check-baseline` (per-file). Sibling pollution is expected
 * in the combined run; the per-file isolation is the contract.
 */
import { describe, test, expect, beforeEach, mock } from 'bun:test'

process.env.JWT_SECRET = process.env.JWT_SECRET || 'x'.repeat(32)
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://localhost:5432/placeholder'

// ── Mutable test state ──────────────────────────────────────────────────────
const state = {
  prefs: {
    orchestrator_enabled: true,
    orchestrator_name: 'Orchestrator',
    orchestrator_custom_instructions: null as string | null,
    orchestrator_disabled_explicitly: false,
  },
  openSession: null as any, // what findOpenOrchestratorSession returns
  // When set, findOpenOrchestratorSession returns these values in sequence
  // (one per call) instead of `openSession`. Models the concurrent-connect race
  // where the first find sees null and the post-23505 re-find sees the winner.
  findSequence: null as null | any[],
  findCalls: 0,
  createThrows: null as null | { code: string }, // simulate unique violation
  createdSessions: [] as any[],
  mintedKeys: [] as string[],
  reserveResult: { ok: true, running: 0, cap: 5 } as any,
  createdRuns: [] as any[],
  sends: [] as any[],
  supervisors: [{ id: 'sup-1', hostname: 'devbox', roots: ['/repos'] }] as any[],
  onlineSupervisorIds: new Set<string>(['sup-1']),
  registryRoots: ['/repos'] as string[],
  marked: [] as string[],
}

mock.module('../src/db/orchestrator-dal.ts', () => ({
  getOrchestratorState: async () => state.prefs,
  findOpenOrchestratorSession: async () => {
    if (state.findSequence) {
      const v = state.findSequence[state.findCalls] ?? state.findSequence[state.findSequence.length - 1]
      state.findCalls += 1
      return v
    }
    return state.openSession
  },
  createOrchestratorSession: async (args: any) => {
    if (state.createThrows) throw Object.assign(new Error('dup'), state.createThrows)
    const row = { id: `sess-${state.createdSessions.length + 1}`, is_orchestrator: true, status: 'connecting', ...args }
    state.createdSessions.push(row)
    return row
  },
  mintOrchestratorApiKey: async (_userId: string, hash: string) => {
    state.mintedKeys.push(hash)
    return { id: `key-${state.mintedKeys.length}` }
  },
}))

mock.module('../src/sessions/budget.ts', () => ({
  reserveSessionSlot: async () => state.reserveResult,
}))

mock.module('../src/db/supervisor-dal.ts', () => ({
  createRun: async (args: any) => {
    const run = { id: `run-${state.createdRuns.length + 1}`, ...args }
    state.createdRuns.push(run)
    return run
  },
  listSupervisorsForUser: async () => state.supervisors,
}))

mock.module('../src/ws/supervisor-registry.ts', () => ({
  getSupervisor: (id: string) =>
    state.onlineSupervisorIds.has(id) ? { roots: state.registryRoots } : undefined,
  isSupervisorOnline: (id: string) => state.onlineSupervisorIds.has(id),
  sendToSupervisor: (id: string, msg: any) => state.sends.push({ id, msg }),
  updateSupervisorState: async () => {},
}))

mock.module('../src/ws/idle-teardown.ts', () => ({
  markOrchestratorSession: (id: string) => state.marked.push(id),
}))

mock.module('../src/db/postgres.ts', () => ({
  sql: async (strings: TemplateStringsArray) => {
    const text = strings.join('?')
    if (text.includes('preferred_supervisor_id')) return [{ preferred_supervisor_id: null }]
    return []
  },
}))

const { launchOrchestrator, maybeAutoLaunchOrchestrator } = await import('../src/orchestrator/auto-launch.ts')

beforeEach(() => {
  state.prefs = {
    orchestrator_enabled: true,
    orchestrator_name: 'Orchestrator',
    orchestrator_custom_instructions: null,
    orchestrator_disabled_explicitly: false,
  }
  state.openSession = null
  state.findSequence = null
  state.findCalls = 0
  state.createThrows = null
  state.createdSessions.length = 0
  state.mintedKeys.length = 0
  state.reserveResult = { ok: true, running: 0, cap: 5 }
  state.createdRuns.length = 0
  state.sends.length = 0
  state.supervisors = [{ id: 'sup-1', hostname: 'devbox', roots: ['/repos'] }]
  state.onlineSupervisorIds = new Set(['sup-1'])
  state.registryRoots = ['/repos']
  state.marked.length = 0
})

describe('launchOrchestrator', () => {
  test('disabled user → no launch, no mint, no send', async () => {
    state.prefs.orchestrator_enabled = false
    const r = await launchOrchestrator({ userId: 'u1' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('disabled')
    expect(state.mintedKeys.length).toBe(0)
    expect(state.sends.length).toBe(0)
  })

  test('explicitly-disabled user → no launch even if enabled flag true', async () => {
    state.prefs.orchestrator_enabled = true
    state.prefs.orchestrator_disabled_explicitly = true
    const r = await launchOrchestrator({ userId: 'u1' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('disabled')
    expect(state.sends.length).toBe(0)
  })

  test('enabled + no row → creates row, reserves slot, creates run, mints key, sends orchestrator session.start', async () => {
    const r = await launchOrchestrator({ userId: 'u1' })
    expect(r.ok).toBe(true)
    expect(state.createdSessions.length).toBe(1)
    expect(state.createdRuns.length).toBe(1)
    expect(state.mintedKeys.length).toBe(1)
    expect(state.sends.length).toBe(1)
    const sent = state.sends[0].msg
    expect(sent.type).toBe('session.start')
    // run_id is the createRun id, NOT a random uuid — so it lands in the ledger.
    expect(sent.run_id).toBe('run-1')
    // The orchestrator extension carries the minted key + prompt.
    expect(sent.orchestrator).toBeTruthy()
    expect(typeof sent.orchestrator.hub_api_key).toBe('string')
    expect(sent.orchestrator.hub_api_key.startsWith('remokey_')).toBe(true)
    expect(sent.orchestrator.system_prompt).toContain('Orchestrator')
  })

  test('the launched session id is marked idle-teardown-exempt', async () => {
    const r = await launchOrchestrator({ userId: 'u1' })
    expect(r.ok).toBe(true)
    if (r.ok) expect(state.marked).toContain(r.sessionId)
  })

  test('concurrent connect (insert hits 23505) → reuses winner row, exactly one session, one send', async () => {
    // First find sees null → we try to insert → 23505 (a sibling connect won) →
    // the post-violation re-find returns the winner's row. The catch path must
    // reuse it, NOT spawn a second time.
    const winner = { id: 'sess-winner', is_orchestrator: true, status: 'connecting' }
    state.findSequence = [null, winner]   // 1st find: null; 2nd (post-23505): winner
    state.createThrows = { code: '23505' }
    const r = await launchOrchestrator({ userId: 'u1' })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.sessionId).toBe('sess-winner')
    }
    expect(state.createdSessions.length).toBe(0) // insert threw → no row created here
    expect(state.sends.length).toBe(1)           // exactly one launch payload
  })

  test('at_capacity → no run, no mint, no send', async () => {
    state.reserveResult = { ok: false, reason: 'at_capacity', running: 5, cap: 5 }
    const r = await launchOrchestrator({ userId: 'u1' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('at_capacity')
    expect(state.createdRuns.length).toBe(0)
    expect(state.mintedKeys.length).toBe(0)
    expect(state.sends.length).toBe(0)
  })

  test('no online supervisor → no_online_supervisor, no throw', async () => {
    state.onlineSupervisorIds = new Set()
    const r = await launchOrchestrator({ userId: 'u1' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('no_online_supervisor')
    expect(state.sends.length).toBe(0)
  })

  test('supervisor with no roots → supervisor_has_no_roots, no throw', async () => {
    state.registryRoots = []
    state.supervisors = [{ id: 'sup-1', hostname: 'devbox', roots: [] }]
    const r = await launchOrchestrator({ userId: 'u1' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('supervisor_has_no_roots')
  })

  test('already running (skipIfRunning) → already_running, no spawn', async () => {
    state.openSession = { id: 'sess-live', status: 'online', is_orchestrator: true }
    const r = await launchOrchestrator({ userId: 'u1', skipIfRunning: true })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('already_running')
    expect(state.sends.length).toBe(0)
  })
})

describe('maybeAutoLaunchOrchestrator', () => {
  test('disabled user → no launch', async () => {
    state.prefs.orchestrator_enabled = false
    const r = await maybeAutoLaunchOrchestrator({ userId: 'u1', supervisorId: 'sup-1' })
    expect(r.launched).toBe(false)
    expect(r.reason).toBe('disabled')
    expect(state.sends.length).toBe(0)
  })

  test('open orchestrator row already exists → no-op (orphan-resume owns respawn, no double-spawn)', async () => {
    state.openSession = { id: 'sess-existing', status: 'offline', is_orchestrator: true }
    const r = await maybeAutoLaunchOrchestrator({ userId: 'u1', supervisorId: 'sup-1' })
    expect(r.launched).toBe(false)
    expect(r.reason).toBe('already_exists')
    expect(state.sends.length).toBe(0)
  })

  test('enabled + no row → launches exactly once', async () => {
    const r = await maybeAutoLaunchOrchestrator({ userId: 'u1', supervisorId: 'sup-1' })
    expect(r.launched).toBe(true)
    expect(state.sends.length).toBe(1)
  })
})
