/**
 * PTYCAP-04 QC B1: the scheduler supervisor sender re-reads the kill switch fresh
 * immediately before transmitting its `run_command`.
 *
 * The dispatcher checks the switch before the pre-gates and target resolution; the sender
 * then awaits `commandExists` (a DB read) before sending. An engage that lands in that
 * window must stop the send and finalize the run `skipped` with the halt reason. Leaf
 * deps are mocked (per-file bun process; mock.module is process-global).
 */
import { describe, test, expect, beforeEach, afterAll, mock } from 'bun:test'

const st = {
  engaged: false,
  engageOnCmd: true,
  finalized: [] as Array<{ runId: string; status: string; error: string | null }>,
  frames: [] as any[],
}

mock.module('../src/db/postgres.ts', () => ({
  sql: async (strings: TemplateStringsArray) => {
    const text = Array.isArray(strings) ? strings.join('?') : ''
    if (text.includes('supervisor_commands')) {
      // the last DB read before transmission: the engage lands here
      if (st.engageOnCmd) st.engaged = true
      return [{ id: 'cmd-1' }]
    }
    if (text.includes('automation_kill_switch') && st.engaged) return [{ scope: 'user', engaged: true }]
    return []
  },
}))
mock.module('../src/ws/registry.ts', () => ({ broadcastToUser: () => {} }))
mock.module('../src/scheduler/dispatcher.ts', () => ({
  finalizeRun: async (runId: string, status: string, error: string | null) => {
    st.finalized.push({ runId, status, error })
  },
}))

const { sendSupervisorTask } = await import('../src/scheduler/senders/supervisor.ts')

const ctx = () => ({
  runId: 'run-1',
  taskId: 'task-1',
  userId: 'u1',
  target: { supervisorId: 'sup-1', supervisorSocket: { send: (f: string) => st.frames.push(JSON.parse(f)) } as any },
})
const task: any = { id: 'task-1', user_id: 'u1', payload: { command: 'build', args: ['x'] } }

beforeEach(() => {
  st.engaged = false
  st.engageOnCmd = true
  st.finalized = []
  st.frames = []
  delete process.env.REMO_AUTOMATION_KILL_SWITCH
})
afterAll(() => mock.restore())

describe('sendSupervisorTask pre-send halt', () => {
  test('engage landing after the command-exists read: no run_command, run finalized skipped automation_halted:user', async () => {
    await sendSupervisorTask(task, ctx())
    expect(st.frames).toHaveLength(0)
    expect(st.finalized).toEqual([{ runId: 'run-1', status: 'skipped', error: 'automation_halted:user' }])
  })

  test('env break-glass halts the send too', async () => {
    process.env.REMO_AUTOMATION_KILL_SWITCH = '1'
    await sendSupervisorTask(task, ctx())
    expect(st.frames).toHaveLength(0)
    expect(st.finalized[0]).toEqual({ runId: 'run-1', status: 'skipped', error: 'automation_halted:env' })
  })

  test('control: not halted -> the run_command is transmitted and nothing is finalized', async () => {
    st.engageOnCmd = false
    await sendSupervisorTask(task, ctx())
    expect(st.frames).toHaveLength(1)
    expect(st.frames[0].type).toBe('run_command')
    expect(st.finalized).toHaveLength(0)
  })
})
