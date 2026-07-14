/**
 * Milestone once — one-time task SEMANTICS at the dispatcher `fire()` seam.
 *
 * The two claims a one-time task MUST satisfy:
 *   (a) it fires EXACTLY ONCE and then SELF-FINALIZES so it never re-arms
 *       (`finalizeOnceTask` + `registry.unregister` fire; the cron end-bound
 *       machinery — `countFiresForTask` — is NEVER consulted, there is no cron).
 *   (b) it REUSES the existing pipeline, not a fork: the same `fireTask` →
 *       run-row insert → `onRunFinalized`/post-run path a cron task uses.
 *
 * The dispatcher is REAL (that wiring is under test); its DB/threshold/registry/
 * post-run/ws deps are mocked so no Postgres is needed. A cron control proves the
 * once-only bookkeeping does NOT leak onto recurring tasks.
 *
 * Bun mock hygiene (feedback_bun_mock_pollution): afterAll(mock.restore); the QC
 * gate runs each file in its own process.
 */
import { describe, test, expect, beforeEach, afterAll, mock } from 'bun:test'

const state = {
  onceFinalized: [] as string[],
  unregistered: [] as string[],
  countFiresCalls: 0,
  runsInserted: [] as any[],
  afterRunCalls: [] as Array<{ taskId: string; status: string }>,
  disableCalls: [] as Array<{ taskId: string; reason: string }>,
  task: null as any,
}

mock.module('../src/db/scheduled-tasks-dal.ts', () => ({
  getTaskById: async (_id: string) => state.task,
  insertRunV2: async (input: any) => {
    const run = { id: `run-${state.runsInserted.length + 1}`, ...input }
    state.runsInserted.push(run)
    return run
  },
  updateRunStatus: async () => null,
  setTaskFireTimestamps: async () => {},
  countFiresForTask: async () => { state.countFiresCalls++; return 0 },
  disableTaskWithReason: async (taskId: string, reason: string) => {
    state.disableCalls.push({ taskId, reason })
  },
  finalizeOnceTask: async (taskId: string) => { state.onceFinalized.push(taskId) },
}))

// Threshold NOT allowed → fireTask short-circuits into the skipped_quota run row
// BEFORE resolveTargets. This exercises the full "insert run → onRunFinalized"
// reuse path without needing a live target/sender.
mock.module('../src/usage/threshold.ts', () => ({
  checkUserThreshold: async () => ({
    allowed: false, reason: 'five_hour', utilization_pct: 99, threshold_pct: 80,
  }),
}))

mock.module('../src/dispatch/gates.ts', () => ({
  isOverCostCap: async () => false,
}))

mock.module('../src/ws/registry.ts', () => ({
  broadcastScheduledRun: () => {},
  broadcastToUser: () => {},
  broadcastToSubscribers: () => {},
  getChannel: () => null,
}))

// registry.unregister is the "never re-arm" seam for a fired once task.
mock.module('../src/scheduler/registry.ts', () => ({
  unregister: (taskId: string) => { state.unregistered.push(taskId) },
  nextRunFor: () => null,
}))

// post-run afterRun is the shared finalize→action seam. Its being called proves
// the once path reuses the pipeline rather than forking it.
mock.module('../src/scheduler/post-run/dispatcher.ts', () => ({
  afterRun: async (input: any) => {
    state.afterRunCalls.push({ taskId: input.task?.id, status: input.status })
  },
}))

const { fire } = await import('../src/scheduler/dispatcher.ts')

const baseTask = (over: any = {}) => ({
  id: 'task-once-1',
  user_id: 'user-1',
  session_id: 'sess-1',
  name: 'One-time thing',
  enabled: true,
  task_type: 'dev',
  target_kind: 'session',
  target_id: 'sess-1',
  payload: {},
  timezone: 'UTC',
  schedule_rules: null,
  schedule_kind: 'once',
  run_at: new Date().toISOString(),
  ...over,
})

beforeEach(() => {
  state.onceFinalized = []
  state.unregistered = []
  state.countFiresCalls = 0
  state.runsInserted = []
  state.afterRunCalls = []
  state.disableCalls = []
  state.task = null
})

afterAll(() => mock.restore())

describe('one-time task fire semantics', () => {
  test('(a) a schedule_kind=once task self-finalizes (disable + unregister) and never re-arms', async () => {
    state.task = baseTask()
    await fire('task-once-1')

    // Fired: a run row was inserted (the pipeline ran).
    expect(state.runsInserted.length).toBe(1)

    // Self-finalized exactly once — the "never re-arm" guarantee.
    expect(state.onceFinalized).toEqual(['task-once-1'])
    expect(state.unregistered).toEqual(['task-once-1'])

    // The cron end-bound machinery is NEVER consulted for a once task (there is
    // no cron rule / max_runs to evaluate).
    expect(state.countFiresCalls).toBe(0)
  })

  test('(b) the once path REUSES the shared finalize→post-run pipeline (not a fork)', async () => {
    state.task = baseTask()
    await fire('task-once-1')
    // onRunFinalized → afterRun fired for THIS task — same seam a cron task uses.
    expect(state.afterRunCalls.length).toBe(1)
    expect(state.afterRunCalls[0].taskId).toBe('task-once-1')
  })

  test('control: a schedule_kind=cron task does NOT self-finalize and DOES evaluate bounds', async () => {
    // A recurring task with a bound rule reaches the cron `countFiresForTask`
    // path and never touches the once bookkeeping.
    state.task = baseTask({
      schedule_kind: 'cron',
      run_at: null,
      schedule_rules: [{ interval: 1, unit: 'hours', start_at: new Date().toISOString(), max_runs: 100 }],
    })
    await fire('task-once-1')
    expect(state.onceFinalized).toEqual([])   // never self-finalizes
    expect(state.unregistered).toEqual([])
    expect(state.countFiresCalls).toBe(1)      // cron bound WAS evaluated
  })

  test('a disabled once task is a no-op (fire returns before any pipeline work)', async () => {
    state.task = baseTask({ enabled: false })
    await fire('task-once-1')
    expect(state.runsInserted.length).toBe(0)
    expect(state.onceFinalized).toEqual([])
  })
})
