/**
 * PTYCAP-04-06 (D-09a, panel F-4): the scheduler honors the automation kill switch
 * at the dispatch entry points, BEFORE any send.
 *
 * - fireTask blocks every run path (cron fire, Run Now, chain/webhook, one-time work)
 *   with a skipped run row `automation_halted:<scope>`, NOT keyed on isManual.
 * - a one-time task is NOT claimed while halted (so it fires after release), and a
 *   halt seen AFTER the claim re-arms the task instead of burning it.
 * - the once-work sender re-arms on a halt skip.
 *
 * The controls predicate is mocked here (its SQL/fail-closed behaviour is proven in
 * automation-controls-core.test.ts); the dispatcher + DAL seams are recorded.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-chars-long-aaaaaaaa'

import { describe, test, expect, beforeEach, afterAll, mock } from 'bun:test'
import { automationControlsLeaf } from './fixtures/automation-controls-leaf.ts'

const state = {
  halt: [] as Array<{ halted: boolean; scope?: string }>, // consumed per isAutomationHalted call; last repeats
  haltArgs: [] as Array<{ userId: string; sessionId?: string }>,
  claimCalls: [] as string[],
  rearmCalls: [] as string[],
  rearmThrows: false,
  runsInserted: [] as any[],
  timestampCalls: [] as string[],
  afterRunCalls: [] as Array<{ taskId: string; status: string; error: string | null }>,
  broadcasts: [] as any[],
  resolveTargetsCalls: 0,
  workDispatchKind: 'skipped' as 'skipped' | 'dispatched',
  workDispatchReason: 'automation_halted:global',
  finalized: [] as Array<{ status: string; error: string | null }>,
  task: null as any,
}

mock.module('../src/dispatch/automation-controls.ts', () => ({
  ...automationControlsLeaf(),
  isAutomationHalted: async (args: { userId: string; sessionId?: string }) => {
    state.haltArgs.push(args)
    const next = state.halt.length > 1 ? state.halt.shift()! : state.halt[0] ?? { halted: false }
    return next.halted ? { halted: true, scope: next.scope ?? 'global' } : { halted: false }
  },
}))

mock.module('../src/db/scheduled-tasks-dal.ts', () => ({
  getTaskById: async () => state.task,
  insertRunV2: async (input: any) => {
    const run = { id: `run-${state.runsInserted.length + 1}`, ...input }
    state.runsInserted.push(run)
    return run
  },
  updateRunStatus: async (_id: string, f: any) => {
    state.finalized.push({ status: f.status, error: f.error ?? null })
    return null
  },
  setTaskFireTimestamps: async (id: string) => { state.timestampCalls.push(id) },
  countFiresForTask: async () => 0,
  disableTaskWithReason: async () => {},
  claimOnceTask: async (id: string) => { state.claimCalls.push(id); return true },
  rearmOnceTask: async (id: string) => {
    state.rearmCalls.push(id)
    if (state.rearmThrows) throw new Error('rearm_db_down')
    return true
  },
}))

// Threshold NOT allowed: a task that survives the halt check lands in the cheap
// skipped_quota branch (proves "not halted -> existing behavior unchanged") without a live sender.
mock.module('../src/usage/threshold.ts', () => ({
  checkUserThreshold: async () => ({ allowed: false, reason: 'five_hour', utilization_pct: 99, threshold_pct: 80 }),
}))
mock.module('../src/dispatch/gates.ts', () => ({ isOverCostCap: async () => false }))
mock.module('../src/scheduler/targets.ts', () => ({ resolveTargets: async () => { state.resolveTargetsCalls++; return [] } }))
mock.module('../src/ws/registry.ts', () => ({
  broadcastScheduledRun: (_u: string, ev: any) => { state.broadcasts.push(ev) },
  broadcastToUser: () => {},
  broadcastToSubscribers: () => {},
  getChannel: () => null,
}))
mock.module('../src/scheduler/registry.ts', () => ({ unregister: () => {}, nextRunFor: () => null }))
mock.module('../src/scheduler/post-run/dispatcher.ts', () => ({
  afterRun: async (input: any) => { state.afterRunCalls.push({ taskId: input.task?.id, status: input.status, error: input.error ?? null }) },
}))
mock.module('../src/db/work-dal.ts', () => ({
  getWorkRun: async () => ({ id: 'w1', repo_ident: 'r', site_key: 's', session_id: 'sess-w', nonce: 'n', prompt: 'p', api_key_id: null, branch: null }),
  findWorkSite: async () => ({ site_dir: 'site' }),
}))
mock.module('../src/work/dispatch.ts', () => ({
  dispatchWork: async () => ({ kind: state.workDispatchKind, reason: state.workDispatchReason }),
}))

const { fire, runNow } = await import('../src/scheduler/dispatcher.ts')
const { sendWorkTask } = await import('../src/scheduler/senders/work.ts')

const baseTask = (over: any = {}) => ({
  id: 'task-1',
  user_id: 'user-1',
  session_id: 'sess-1',
  name: 'T',
  enabled: true,
  task_type: 'dev',
  target_kind: 'session',
  target_id: 'sess-1',
  payload: {},
  timezone: 'UTC',
  schedule_rules: null,
  schedule_kind: 'cron',
  run_at: null,
  ...over,
})

const flush = () => new Promise((r) => setTimeout(r, 20))

beforeEach(() => {
  state.halt = [{ halted: false }]
  state.haltArgs = []
  state.claimCalls = []
  state.rearmCalls = []
  state.rearmThrows = false
  state.runsInserted = []
  state.timestampCalls = []
  state.afterRunCalls = []
  state.broadcasts = []
  state.resolveTargetsCalls = 0
  state.workDispatchKind = 'skipped'
  state.workDispatchReason = 'automation_halted:global'
  state.finalized = []
  state.task = null
})

afterAll(() => mock.restore())

describe('fireTask kill switch (every run path, not keyed on isManual)', () => {
  test('halted cron fire: skipped run automation_halted:global, broadcast, post-run finalize, fire timestamps stamped, no send', async () => {
    state.halt = [{ halted: true, scope: 'global' }]
    state.task = baseTask()
    await fire('task-1')
    await flush()

    expect(state.runsInserted).toHaveLength(1)
    expect(state.runsInserted[0].status).toBe('skipped')
    expect(state.runsInserted[0].error).toBe('automation_halted:global')
    expect(state.broadcasts).toContainEqual(expect.objectContaining({ type: 'scheduled_run_finished', status: 'skipped', error: 'automation_halted:global' }))
    expect(state.afterRunCalls).toEqual([{ taskId: 'task-1', status: 'skipped', error: 'automation_halted:global' }])
    expect(state.timestampCalls).toEqual(['task-1']) // cron path stamps (skipCronUpdate false)
    expect(state.resolveTargetsCalls).toBe(0) // no target resolution, no send
  })

  test('the halt is evaluated with the task user and its pinned session', async () => {
    state.halt = [{ halted: true, scope: 'session' }]
    state.task = baseTask()
    await runNow('task-1', 'user-1', {})
    expect(state.haltArgs).toContainEqual({ userId: 'user-1', sessionId: 'sess-1' })
  })

  test('Run Now (isManual true) is blocked identically and returns the skipped run id', async () => {
    state.halt = [{ halted: true, scope: 'user' }]
    state.task = baseTask()
    const out = await runNow('task-1', 'user-1', { isManual: true })
    await flush()
    expect(out.runIds).toEqual(['run-1'])
    expect(state.runsInserted[0].error).toBe('automation_halted:user')
    expect(state.timestampCalls).toEqual([]) // runNow skips cron timestamps
    expect(state.resolveTargetsCalls).toBe(0)
  })

  test('chain/webhook style run (isManual false) is blocked too', async () => {
    state.halt = [{ halted: true, scope: 'global' }]
    state.task = baseTask()
    const out = await runNow('task-1', 'user-1', { isManual: false, chainDepth: 1 })
    expect(out.runIds).toHaveLength(1)
    expect(state.runsInserted[0].error).toBe('automation_halted:global')
  })

  test('triage, teab, work and run_command task types are all stopped by the same pre-gate check', async () => {
    for (const task_type of ['triage', 'teab', 'work', 'run_command']) {
      state.halt = [{ halted: true, scope: 'global' }]
      state.runsInserted = []
      state.task = baseTask({ task_type, target_kind: 'supervisor', target_id: null, payload: { work_session_id: 'sess-w' } })
      const out = await runNow('task-1', 'user-1', { isManual: true })
      expect(out.runIds, task_type).toHaveLength(1)
      expect(state.runsInserted, task_type).toHaveLength(1)
      expect(state.runsInserted[0].status, task_type).toBe('skipped')
      expect(state.runsInserted[0].error, task_type).toBe('automation_halted:global')
    }
  })

  test('not halted: existing behavior unchanged (the threshold block is still reached)', async () => {
    state.task = baseTask()
    await runNow('task-1', 'user-1', {})
    expect(state.runsInserted).toHaveLength(1)
    expect(state.runsInserted[0].status).toBe('skipped_quota')
  })
})

describe('one-time tasks are never burned by a halt (panel F-4)', () => {
  test('halted before the claim: fire() returns WITHOUT claiming; after release the same fire() claims and runs', async () => {
    state.halt = [{ halted: true, scope: 'global' }]
    state.task = baseTask({ schedule_kind: 'once', run_at: new Date().toISOString(), task_type: 'work', payload: { work_id: 'w1', work_session_id: 'sess-w' } })
    await fire('task-1')
    expect(state.claimCalls).toEqual([]) // claimOnceTask NOT called while halted
    expect(state.runsInserted).toHaveLength(0)
    expect(state.rearmCalls).toEqual([])

    // release: predicate now reports not halted
    state.halt = [{ halted: false }]
    await fire('task-1')
    expect(state.claimCalls).toEqual(['task-1'])
    expect(state.runsInserted).toHaveLength(1) // the run proceeded (to the threshold block here)
  })

  test('once-task with isManual true (how fire() dispatches it) is blocked in fireTask when the halt lands after the claim: re-arm, NO skipped run row', async () => {
    // call 1 (pre-claim check in fire): not halted. call 2 (fireTask): halted.
    state.halt = [{ halted: false }, { halted: true, scope: 'user' }]
    state.task = baseTask({ schedule_kind: 'once', run_at: new Date().toISOString() })
    await fire('task-1')
    await flush()
    expect(state.claimCalls).toEqual(['task-1'])
    expect(state.rearmCalls).toEqual(['task-1'])
    expect(state.runsInserted).toHaveLength(0)
    expect(state.afterRunCalls).toEqual([])
  })

  test('if the re-arm itself fails, the loss is made VISIBLE as a skipped run row (never silent)', async () => {
    state.rearmThrows = true
    state.halt = [{ halted: false }, { halted: true, scope: 'global' }]
    state.task = baseTask({ schedule_kind: 'once', run_at: new Date().toISOString() })
    await fire('task-1')
    await flush()
    expect(state.rearmCalls).toEqual(['task-1'])
    expect(state.runsInserted).toHaveLength(1)
    expect(state.runsInserted[0].error).toBe('automation_halted:global')
  })

  test('the once-work sender re-arms when dispatchWork reports a halt skip, and records the run as skipped (not completed work)', async () => {
    state.task = baseTask({ schedule_kind: 'once', task_type: 'work', payload: { work_id: 'w1' } })
    await sendWorkTask(state.task, { runId: 'run-9', userId: 'user-1' })
    expect(state.rearmCalls).toEqual(['task-1'])
    expect(state.finalized).toEqual([{ status: 'skipped', error: 'automation_halted:global' }])
  })

  test('the once-work sender does NOT re-arm for an ordinary skip or a dispatch', async () => {
    state.task = baseTask({ schedule_kind: 'once', task_type: 'work', payload: { work_id: 'w1' } })
    state.workDispatchReason = 'session_busy'
    await sendWorkTask(state.task, { runId: 'run-9', userId: 'user-1' })
    state.workDispatchKind = 'dispatched'
    await sendWorkTask(state.task, { runId: 'run-10', userId: 'user-1' })
    expect(state.rearmCalls).toEqual([])
  })
})
