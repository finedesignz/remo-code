/**
 * PTYCAP-04 QC R3: the scheduler TEAB sender's late kill-switch refusal must not burn a
 * CLAIMED one-time (schedule_kind='once') task. It re-arms the claim before finalizing the
 * halted run skipped; a recurring task is never re-armed. Leaf deps are mocked (per-file
 * bun process; mock.module is process-global).
 */
import { describe, test, expect, beforeEach, afterAll, mock } from 'bun:test'

process.env.JWT_SECRET = process.env.JWT_SECRET || 'x'.repeat(32)
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://localhost:5432/placeholder'

const st = {
  finalized: [] as Array<{ runId: string; status: string; error: string | null }>,
  frames: [] as any[],
  rearmed: [] as string[],
  rearmThrows: false,
  order: [] as string[],
  halted: true,
}

mock.module('../src/db/postgres.ts', () => ({ sql: async () => [] }))
mock.module('../src/db/scheduled-tasks-dal.ts', () => ({
  updateRunStatus: async () => ({}),
  rearmOnceTask: async (id: string) => {
    st.order.push('rearm')
    st.rearmed.push(id)
    if (st.rearmThrows) throw new Error('rearm db down')
    return true
  },
}))
mock.module('../src/dispatch/automation-controls.ts', () => ({
  haltBeforeMachineSend: async () =>
    st.halted ? { ok: false, reason: 'automation_halted:user', scope: 'user' } : { ok: true },
}))
mock.module('../src/ws/supervisor-registry.ts', () => ({
  listOnlineSupervisorIdsForUser: () => ['sup-1'],
  getSupervisor: () => ({ ws: { send: (f: string) => st.frames.push(JSON.parse(f)) } }),
  getUserInventory: () => undefined,
}))
mock.module('../src/scheduler/dispatcher.ts', () => ({
  finalizeRun: async (runId: string, status: string, error: string | null) => {
    st.order.push('finalize')
    st.finalized.push({ runId, status, error })
  },
}))
mock.module('../src/observability/logger', () => ({
  log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}))

const { sendTeabTask, _resetTeabPolls } = await import('../src/scheduler/senders/teab.ts')

const ctx = () => ({ runId: 'run-1', taskId: 'task-1', userId: 'u1', target: { supervisorId: 'sup-1' } })
const task: any = { id: 'task-1', user_id: 'u1', task_type: 'teab', teab_repo_ident: 'github://o/r', payload: {} }

beforeEach(() => {
  st.finalized = []
  st.frames = []
  st.rearmed = []
  st.rearmThrows = false
  st.order = []
  st.halted = true
  _resetTeabPolls()
})
afterAll(() => {
  _resetTeabPolls()
  mock.restore()
})

describe('sendTeabTask late halt', () => {
  test('QC R3: a halted CLAIMED one-time task is re-armed before its run is finalized skipped; nothing sent', async () => {
    await sendTeabTask({ ...task, schedule_kind: 'once' }, ctx())
    expect(st.frames).toHaveLength(0)
    expect(st.rearmed).toEqual(['task-1'])
    expect(st.order).toEqual(['rearm', 'finalize'])
    expect(st.finalized).toEqual([{ runId: 'run-1', status: 'skipped', error: 'automation_halted:user' }])
  })

  test('QC R3: a failing re-arm still leaves the visible skipped run (nothing silently lost)', async () => {
    st.rearmThrows = true
    await sendTeabTask({ ...task, schedule_kind: 'once' }, ctx())
    expect(st.frames).toHaveLength(0)
    expect(st.finalized).toEqual([{ runId: 'run-1', status: 'skipped', error: 'automation_halted:user' }])
  })

  test('QC R3: a recurring (cron) task is never re-armed', async () => {
    await sendTeabTask({ ...task, schedule_kind: 'cron' }, ctx())
    expect(st.rearmed).toHaveLength(0)
    expect(st.finalized).toHaveLength(1)
  })

  test('control: not halted -> run_command teab_run transmitted, no re-arm, no finalize', async () => {
    st.halted = false
    await sendTeabTask({ ...task, schedule_kind: 'once' }, ctx())
    expect(st.frames).toHaveLength(1)
    expect(st.frames[0].command).toBe('teab_run')
    expect(st.rearmed).toHaveLength(0)
    expect(st.finalized).toHaveLength(0)
  })
})
