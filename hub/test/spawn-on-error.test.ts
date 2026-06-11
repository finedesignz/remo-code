/**
 * Spawn-on-error tests (`hub/src/dispatch/spawn-on-error.ts` +
 * its pipeline `ensureOnline` integration).
 *
 * Run in its own process by the per-file QC gate (mock.module is process-global
 * — see CLAUDE.md / feedback_bun_mock_pollution).
 *
 * Cases (matching the spawn-on-error spec):
 *   - flag OFF (default)              → no spawn, ensureSessionOnline=false.
 *   - flag ON + offline + supervisor connected + headroom
 *                                     → session.start sent, returns true once online.
 *   - spawn timeout                   → returns false, NO orphan run left open
 *                                       (createRun called once, endRun NOT called,
 *                                       the run is a real spawning run).
 *   - no supervisor connected         → no spawn, false.
 *   - concurrency cap reached         → no spawn (no createRun), false.
 *   - already online                  → true immediately, no spawn.
 *   - in-flight spawn lock            → 2nd concurrent call doesn't double-start.
 *   - dispatch (send) failure         → endRun + releaseSessionSlot (no leak), false.
 *
 * Pipeline integration (no DB):
 *   - ensureOnline absent             → today's park behaviour unchanged.
 *   - ensureOnline returns false      → parked_offline, send NEVER called.
 *   - ensureOnline brings it online   → dispatched, send called once.
 *   - gates block BEFORE ensureOnline → skipped, ensureOnline NEVER called.
 */
import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test'

// ── shared mock state, mutated per-test ─────────────────────────────────────
const state: {
  online: boolean
  supervisors: string[]
  reserveOk: boolean
  reserveReason: string
  createRunCalls: number
  createRunThrows: boolean
  sendThrows: boolean
  sentMessages: any[]
  endRunCalls: Array<[string, number | null, string]>
  releaseCalls: number
  sessionProjectDir: string | null
} = {
  online: false,
  supervisors: ['sup-1'],
  reserveOk: true,
  reserveReason: 'at_capacity',
  createRunCalls: 0,
  createRunThrows: false,
  sendThrows: false,
  sentMessages: [],
  endRunCalls: [],
  releaseCalls: 0,
  sessionProjectDir: '/repo/app',
}

function resetState() {
  state.online = false
  state.supervisors = ['sup-1']
  state.reserveOk = true
  state.reserveReason = 'at_capacity'
  state.createRunCalls = 0
  state.createRunThrows = false
  state.sendThrows = false
  state.sentMessages = []
  state.endRunCalls = []
  state.releaseCalls = 0
  state.sessionProjectDir = '/repo/app'
}

mock.module('../src/ws/registry.ts', () => ({
  getChannel: (_id: string) => (state.online ? { ws: { send: () => {} } } : null),
}))

mock.module('../src/ws/supervisor-registry.ts', () => ({
  listOnlineSupervisorIdsForUser: (_u: string) => state.supervisors,
  isSupervisorOnline: (id: string) => state.supervisors.includes(id),
  sendToSupervisor: (_id: string, msg: any) => {
    if (state.sendThrows) throw new Error('supervisor offline')
    state.sentMessages.push(msg)
  },
  updateSupervisorState: async () => {},
}))

mock.module('../src/sessions/budget.ts', () => ({
  reserveSessionSlot: async () =>
    state.reserveOk
      ? { ok: true, running: 0, cap: 4 }
      : { ok: false, reason: state.reserveReason, running: 4, cap: 4 },
  releaseSessionSlot: async () => {
    state.releaseCalls++
  },
}))

mock.module('../src/db/supervisor-dal.ts', () => ({
  createRun: async () => {
    state.createRunCalls++
    if (state.createRunThrows) throw new Error('run_insert_failed')
    return { id: 'run-1' }
  },
  endRun: async (runId: string, code: number | null, reason: string) => {
    state.endRunCalls.push([runId, code, reason])
  },
}))

mock.module('../src/db/dal.ts', () => ({
  getSession: async () =>
    state.sessionProjectDir == null ? { id: 's1' } : { id: 's1', project_dir: state.sessionProjectDir },
}))

mock.module('../src/observability/logger.ts', () => ({
  log: { info: () => {}, error: () => {}, warn: () => {}, debug: () => {} },
}))

// Imported AFTER the mocks are registered.
const { ensureSessionOnline, _resetSpawnLocks, spawnOnErrorEnabled } = await import(
  '../src/dispatch/spawn-on-error.ts'
)

const ENV = process.env.REMO_SPAWN_ON_ERROR
const ENV_T = process.env.REMO_SPAWN_ON_ERROR_TIMEOUT_MS

beforeEach(() => {
  resetState()
  _resetSpawnLocks()
  process.env.REMO_SPAWN_ON_ERROR = '1'
  process.env.REMO_SPAWN_ON_ERROR_TIMEOUT_MS = '400' // short polls in tests
})
afterEach(() => {
  if (ENV === undefined) delete process.env.REMO_SPAWN_ON_ERROR
  else process.env.REMO_SPAWN_ON_ERROR = ENV
  if (ENV_T === undefined) delete process.env.REMO_SPAWN_ON_ERROR_TIMEOUT_MS
  else process.env.REMO_SPAWN_ON_ERROR_TIMEOUT_MS = ENV_T
})

describe('spawn-on-error: ensureSessionOnline', () => {
  test('flag OFF → no spawn, returns false', async () => {
    delete process.env.REMO_SPAWN_ON_ERROR
    expect(spawnOnErrorEnabled()).toBe(false)
    const ok = await ensureSessionOnline('u1', 's1')
    expect(ok).toBe(false)
    expect(state.createRunCalls).toBe(0)
    expect(state.sentMessages.length).toBe(0)
  })

  test('already online → true immediately, no spawn', async () => {
    state.online = true
    const ok = await ensureSessionOnline('u1', 's1')
    expect(ok).toBe(true)
    expect(state.createRunCalls).toBe(0)
  })

  test('no supervisor connected → no spawn, false', async () => {
    state.supervisors = []
    const ok = await ensureSessionOnline('u1', 's1')
    expect(ok).toBe(false)
    expect(state.createRunCalls).toBe(0)
  })

  test('concurrency cap reached → no createRun, false', async () => {
    state.reserveOk = false
    state.reserveReason = 'at_capacity'
    const ok = await ensureSessionOnline('u1', 's1')
    expect(ok).toBe(false)
    expect(state.createRunCalls).toBe(0)
    expect(state.sentMessages.length).toBe(0)
  })

  test('offline + supervisor + headroom → sends session.start, true once online', async () => {
    // Flip online shortly after the start fires (simulate supervisor connecting).
    setTimeout(() => {
      state.online = true
    }, 50)
    const ok = await ensureSessionOnline('u1', 's1')
    expect(ok).toBe(true)
    expect(state.createRunCalls).toBe(1)
    expect(state.sentMessages.length).toBe(1)
    expect(state.sentMessages[0].type).toBe('session.start')
    expect(state.sentMessages[0].run_id).toBe('run-1')
    expect(state.sentMessages[0].repo_path).toBe('/repo/app')
    // No leak: a successful spawn does NOT end its own run or release.
    expect(state.endRunCalls.length).toBe(0)
  })

  test('spawn timeout → false, run NOT force-closed (no orphan-close), no release', async () => {
    state.online = false // never comes online
    const ok = await ensureSessionOnline('u1', 's1')
    expect(ok).toBe(false)
    expect(state.createRunCalls).toBe(1)
    expect(state.sentMessages.length).toBe(1)
    // The run is a genuine spawning run the supervisor owns — we do NOT endRun
    // it on timeout, and we do NOT release (slot stays reserved for the run).
    expect(state.endRunCalls.length).toBe(0)
    expect(state.releaseCalls).toBe(0)
  })

  test('send failure → endRun + releaseSessionSlot (no leak), false', async () => {
    state.sendThrows = true
    const ok = await ensureSessionOnline('u1', 's1')
    expect(ok).toBe(false)
    expect(state.createRunCalls).toBe(1)
    expect(state.endRunCalls.length).toBe(1)
    expect(state.endRunCalls[0][0]).toBe('run-1')
    expect(state.releaseCalls).toBe(1)
  })

  test('createRun failure → releaseSessionSlot, no orphan, false', async () => {
    state.createRunThrows = true
    const ok = await ensureSessionOnline('u1', 's1')
    expect(ok).toBe(false)
    expect(state.releaseCalls).toBe(1)
    expect(state.sentMessages.length).toBe(0)
  })

  test('in-flight spawn lock → 2nd concurrent call does not double-start', async () => {
    setTimeout(() => {
      state.online = true
    }, 80)
    const [a, b] = await Promise.all([
      ensureSessionOnline('u1', 's1'),
      ensureSessionOnline('u1', 's1'),
    ])
    expect(a).toBe(true)
    expect(b).toBe(true)
    // Only ONE start fired despite two concurrent repairs for the same session.
    expect(state.createRunCalls).toBe(1)
    expect(state.sentMessages.length).toBe(1)
  })

  test('session missing project_dir → no spawn, false', async () => {
    state.sessionProjectDir = null
    const ok = await ensureSessionOnline('u1', 's1')
    expect(ok).toBe(false)
    expect(state.createRunCalls).toBe(0)
  })
})

// ── Pipeline integration (no DB; pure mock deps) ────────────────────────────
import {
  dispatch,
  _reset as resetPipeline,
  type DispatchGate,
  type DispatchRequest,
  type PipelineDeps,
} from '../src/dispatch/pipeline.ts'

const passGate: DispatchGate = { name: 'pass', check: async () => ({ ok: true }) }
const blockGate: DispatchGate = { name: 'block', check: async () => ({ ok: false, reason: 'over_daily_cost_cap' }) }

function baseDeps(over: Partial<PipelineDeps> = {}): PipelineDeps {
  return {
    gates: [passGate],
    store: null,
    replay: async () => {},
    isOnline: () => false,
    send: async () => {},
    ...over,
  }
}

const req: DispatchRequest = { userId: 'u1', sessionId: 'sess-pipe', token: 'tok-1', prompt: 'fix it' }

describe('pipeline: ensureOnline integration', () => {
  beforeEach(() => resetPipeline())

  test('no ensureOnline → offline parks (today behaviour unchanged)', async () => {
    let sent = 0
    const out = await dispatch(req, baseDeps({ send: async () => { sent++ } }))
    expect(out.kind).toBe('parked_offline')
    expect(sent).toBe(0)
  })

  test('ensureOnline false → still parks, send NEVER called', async () => {
    let sent = 0
    let ensured = 0
    const out = await dispatch(
      req,
      baseDeps({
        send: async () => { sent++ },
        ensureOnline: async () => { ensured++; return false },
      }),
    )
    expect(out.kind).toBe('parked_offline')
    expect(ensured).toBe(1)
    expect(sent).toBe(0)
  })

  test('ensureOnline brings session online → dispatched, send called once', async () => {
    let sent = 0
    let online = false
    const out = await dispatch(
      req,
      baseDeps({
        isOnline: () => online,
        send: async () => { sent++ },
        ensureOnline: async () => { online = true; return true },
      }),
    )
    expect(out.kind).toBe('dispatched')
    expect(sent).toBe(1)
  })

  test('gate block runs BEFORE ensureOnline (cost-cap non-bypassable)', async () => {
    let ensured = 0
    const out = await dispatch(
      req,
      baseDeps({
        gates: [blockGate],
        ensureOnline: async () => { ensured++; return true },
      }),
    )
    expect(out.kind).toBe('skipped')
    expect(ensured).toBe(0) // never spawned for a gated repair
  })

  test('ensureOnline throws → falls back to park (no crash)', async () => {
    const out = await dispatch(
      req,
      baseDeps({ ensureOnline: async () => { throw new Error('boom') } }),
    )
    expect(out.kind).toBe('parked_offline')
  })
})
