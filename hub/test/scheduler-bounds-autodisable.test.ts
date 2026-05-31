/**
 * P1 end-bound auto-disable test.
 *
 * Proves `dispatcher.fire()`:
 *   - auto-disables the task (disableTaskWithReason) + unregisters it + skips
 *     the fire (no run inserted) when an end-bound (until/max_runs) is reached;
 *   - fires normally (reaches fireTask → insertRunV2) when no bound is hit.
 *
 * Bun mock.module hygiene (project memory feedback_bun_mock_pollution):
 * cache-bust the module under test, afterAll(mock.restore).
 */
import { describe, test, expect, beforeEach, afterAll, mock } from 'bun:test'

type Task = any

const state: {
  task: Task
  fires: number
  disabled: Array<{ taskId: string; reason: string }>
  unregistered: string[]
  insertedRuns: number
} = {
  task: null,
  fires: 0,
  disabled: [],
  unregistered: [],
  insertedRuns: 0,
}

mock.module('../src/db/postgres.ts', () => ({ sql: async () => [] }))

mock.module('../src/db/scheduled-tasks-dal.ts', () => ({
  getTaskById: async () => state.task,
  countFiresForTask: async () => state.fires,
  disableTaskWithReason: async (taskId: string, reason: string) => {
    state.disabled.push({ taskId, reason })
  },
  insertRunV2: async () => { state.insertedRuns++; return { id: 'run-x' } },
  updateRunStatus: async () => null,
  setTaskFireTimestamps: async () => {},
}))

mock.module('../src/scheduler/registry.ts', () => ({
  unregister: (taskId: string) => { state.unregistered.push(taskId) },
  nextRunFor: () => null,
}))

// Threshold + cost-cap gates allow (so the no-bound path can proceed far enough
// to call insertRunV2). resolveTargets returns empty → the dispatcher inserts a
// single failed "no_targets" run and stops; that still proves fireTask ran.
mock.module('../src/usage/threshold.ts', () => ({
  checkUserThreshold: async () => ({ allowed: true }),
}))
mock.module('../src/dispatch/gates.ts', () => ({ isOverCostCap: async () => false }))
mock.module('../src/scheduler/targets.ts', () => ({ resolveTargets: async () => [] }))
mock.module('../src/ws/registry.ts', () => ({
  broadcastScheduledRun: () => {},
  broadcastToUser: () => {},
}))
mock.module('../src/observability/metrics', () => ({ scheduledQueueDepth: { set: () => {} } }))
mock.module('../src/observability/logger', () => ({
  log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}))
mock.module('../src/scheduler/post-run/dispatcher.ts', () => ({ afterRun: async () => {} }))

const dispatcher = await import(`../src/scheduler/dispatcher.ts?bust=${Date.now()}`)

function baseTask(rules: any[]): Task {
  return {
    id: 'task-1', user_id: 'user-1', enabled: true,
    task_type: 'dev', target_kind: 'session', target_id: 'sess-1',
    timezone: 'UTC', payload: {}, schedule_rules: rules,
  }
}

beforeEach(() => {
  state.fires = 0
  state.disabled = []
  state.unregistered = []
  state.insertedRuns = 0
})

afterAll(() => { mock.restore() })

describe('fire() end-bounds', () => {
  test('max_runs reached → auto-disable + unregister + no run inserted', async () => {
    state.task = baseTask([{ interval: 1, unit: 'days', start_at: '2020-01-01T00:00:00Z', max_runs: 3 }])
    state.fires = 3
    await dispatcher.fire('task-1')
    expect(state.disabled).toEqual([{ taskId: 'task-1', reason: 'bound_max_runs' }])
    expect(state.unregistered).toEqual(['task-1'])
    expect(state.insertedRuns).toBe(0)
  })

  test('until reached → auto-disable bound_until', async () => {
    state.task = baseTask([{ interval: 1, unit: 'days', start_at: '2020-01-01T00:00:00Z', until: '2020-02-01T00:00:00Z' }])
    await dispatcher.fire('task-1')
    expect(state.disabled).toEqual([{ taskId: 'task-1', reason: 'bound_until' }])
    expect(state.insertedRuns).toBe(0)
  })

  test('no bound hit → proceeds to fireTask (run inserted)', async () => {
    state.task = baseTask([{ interval: 1, unit: 'days', start_at: '2020-01-01T00:00:00Z', max_runs: 5 }])
    state.fires = 2
    await dispatcher.fire('task-1')
    expect(state.disabled).toEqual([])
    expect(state.insertedRuns).toBe(1) // no_targets failed run
  })

  test('rule with no bounds → never checks count, fires', async () => {
    state.task = baseTask([{ interval: 1, unit: 'days', start_at: '2020-01-01T00:00:00Z' }])
    await dispatcher.fire('task-1')
    expect(state.disabled).toEqual([])
    expect(state.insertedRuns).toBe(1)
  })
})
