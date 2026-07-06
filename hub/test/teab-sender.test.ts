/**
 * TEAB sender + dispatcher-routing tests (Milestone TEAB / Phase TEAB-04).
 *
 * Proves the hub routes a due `task_type: 'teab'` task to the supervisor TEAB
 * sender and that the sender issues the allowlisted `run_command teab_run`:
 *
 *   (a) routing — a teab task reaches the teab sender (a `run_command` lands on
 *       the supervisor socket), NOT the agent/session send path.
 *   (b) gate list consulted — a task over the cost cap is skipped before the
 *       sender runs, and NO `run_command` is emitted (cap non-bypassable).
 *   (c) the emitted frame is `{type:'run_command', command:'teab_run',
 *       args:[repoIdent]}`.
 *   (d) no online supervisor → the run is finalized with a clear reason.
 *
 * The REAL dispatcher (`fireTask` via `runNow`) AND the REAL teab sender are
 * under test; only the leaf deps (postgres, the scheduled-tasks DAL, the gate
 * pre-check, the threshold gate, the ws registries, post-run) are mocked, so no
 * live Postgres / no live WS is needed.
 *
 * Bun mock.module hygiene (project memory feedback_bun_mock_pollution):
 * afterAll(mock.restore); this file is run in its own process by check-baseline.
 */
import { describe, test, expect, beforeEach, afterAll, mock } from 'bun:test'

const state: {
  task: any
  inserted: Array<{ status: string; error: string | null }>
  runStatusUpdates: Array<{ runId: string; fields: any }>
  sentFrames: any[]
  online: string[]
  inventory: any
  capExceeded: boolean
  thresholdAllowed: boolean
} = {
  task: null,
  inserted: [],
  runStatusUpdates: [],
  sentFrames: [],
  online: ['sup-1'],
  inventory: null,
  capExceeded: false,
  thresholdAllowed: true,
}

let runSeq = 0

// ── leaf-dep mocks ──────────────────────────────────────────────────────────
mock.module('../src/db/postgres.ts', () => ({
  // teab.ts's only direct sql use is the `teab_last_status = 'started'` UPDATE.
  sql: async () => [],
}))

// Spread the real DAL (it loads fine over the mocked postgres) so unrelated
// exports stay present, then override only the functions the teab path drives.
const realDal = await import(`../src/db/scheduled-tasks-dal.ts?bust=${Date.now()}`)
mock.module('../src/db/scheduled-tasks-dal.ts', () => ({
  ...realDal,
  getTaskById: async (id: string) => (state.task && state.task.id === id ? state.task : null),
  insertRunV2: async (input: any) => {
    state.inserted.push({ status: input.status, error: input.error ?? null })
    return { id: `run-${++runSeq}`, user_id: input.user_id, task_id: input.task_id }
  },
  updateRunStatus: async (runId: string, fields: any) => {
    state.runStatusUpdates.push({ runId, fields })
    return { id: runId, user_id: 'user-1', task_id: state.task?.id ?? 'task-1' }
  },
  setTaskFireTimestamps: async () => {},
  countFiresForTask: async () => 0,
  disableTaskWithReason: async () => {},
}))

mock.module('../src/dispatch/gates.ts', () => ({
  isOverCostCap: async () => state.capExceeded,
}))

mock.module('../src/usage/threshold.ts', () => ({
  checkUserThreshold: async () => ({
    allowed: state.thresholdAllowed,
    reason: 'five_hour',
    utilization_pct: 10,
    threshold_pct: 90,
  }),
}))

mock.module('../src/ws/registry.ts', () => ({
  getChannel: () => null,
  broadcastScheduledRun: () => {},
  broadcastToUser: () => {},
  broadcastToSubscribers: () => {},
}))

mock.module('../src/ws/supervisor-registry.ts', () => ({
  listOnlineSupervisorIdsForUser: () => state.online,
  getSupervisor: (id: string) =>
    state.online.includes(id)
      ? { ws: { send: (f: string) => state.sentFrames.push(JSON.parse(f)) } }
      : undefined,
  getUserInventory: () => state.inventory ?? undefined,
}))

mock.module('../src/scheduler/post-run/dispatcher.ts', () => ({
  afterRun: async () => {},
}))

// Import AFTER mocks. Dispatcher + teab sender are REAL.
const { runNow } = await import('../src/scheduler/dispatcher.ts')

const TEAB_TASK = (over: any = {}) => ({
  id: 'task-teab-1',
  user_id: 'user-1',
  task_type: 'teab',
  teab_repo_ident: 'github://finedesignz/titanium-edge-autobuilder',
  timezone: 'America/Los_Angeles',
  payload: {},
  schedule_rules: [],
  enabled: true,
  ...over,
})

beforeEach(() => {
  state.inserted = []
  state.runStatusUpdates = []
  state.sentFrames = []
  state.online = ['sup-1']
  state.inventory = null
  state.capExceeded = false
  state.thresholdAllowed = true
  state.task = TEAB_TASK()
})

afterAll(() => mock.restore())

describe('TEAB dispatch (Phase TEAB-04)', () => {
  test('(a)+(c) routing: a teab task reaches the teab sender and emits run_command teab_run', async () => {
    await runNow('task-teab-1', 'user-1')

    // A run row was inserted in-flight-pending and routed to the supervisor.
    expect(state.inserted).toHaveLength(1)
    expect(state.inserted[0].status).toBe('pending')

    // The supervisor socket received exactly one run_command — the TEAB sender
    // path, not the agent/session send (which would emit a `user_message`).
    expect(state.sentFrames).toHaveLength(1)
    const frame = state.sentFrames[0]
    expect(frame.type).toBe('run_command')
    expect(frame.command).toBe('teab_run')
    expect(frame.args).toEqual(['github://finedesignz/titanium-edge-autobuilder'])
    expect(typeof frame.run_id).toBe('string')

    // Run recorded in-flight.
    const inflight = state.runStatusUpdates.find((u) => u.fields.status === 'in_flight')
    expect(inflight).toBeTruthy()
  })

  test('(b) gate list consulted: over-cost-cap task is skipped and NO run_command is emitted', async () => {
    state.capExceeded = true
    await runNow('task-teab-1', 'user-1')

    // Cap hit → run inserted as skipped/daily_cost_cap, sender never reached.
    expect(state.inserted).toHaveLength(1)
    expect(state.inserted[0].status).toBe('skipped')
    expect(state.inserted[0].error).toBe('daily_cost_cap')
    expect(state.sentFrames).toHaveLength(0)
  })

  test('(b) gate list consulted: over-threshold task is skipped (skipped_quota), no run_command', async () => {
    state.thresholdAllowed = false
    await runNow('task-teab-1', 'user-1')

    expect(state.inserted).toHaveLength(1)
    expect(state.inserted[0].status).toBe('skipped_quota')
    expect(state.sentFrames).toHaveLength(0)
  })

  test('(d) no online supervisor → run finalized skipped with no_online_supervisor, no run_command', async () => {
    state.online = []
    await runNow('task-teab-1', 'user-1')

    // No frame emitted.
    expect(state.sentFrames).toHaveLength(0)
    // The sender finalized the run (finalizeRun → updateRunStatus) as skipped.
    const skip = state.runStatusUpdates.find((u) => u.fields.status === 'skipped')
    expect(skip).toBeTruthy()
    expect(skip!.fields.error).toBe('no_online_supervisor')
  })
})
