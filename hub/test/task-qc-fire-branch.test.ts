/**
 * PTYCAP-08-03 Task 2: ordering, flag-OFF no-op, single-run claim under overlap and
 * the anti-chain sink for the task_qc fire path (F2-B1, F2-B3 flag-OFF clause, D-14).
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-chars-long-aaaaaaaa'

import { describe, test, expect, beforeEach, afterEach, afterAll, mock } from 'bun:test'
import { setupFireHarness, flush, QC_ID, CONTROL_ID, USER } from './fixtures/task-qc-fire-harness.ts'

const { h, reset } = setupFireHarness()
const sender = { agent: 0, supervisor: 0 }
mock.module('../src/scheduler/post-run/dispatcher.ts', () => ({
  afterRun: async (input: any) => { h.afterRunCalls.push(input) },
}))
mock.module('../src/scheduler/senders/agent.ts', () => ({ sendAgentTask: async () => { sender.agent++ } }))
mock.module('../src/scheduler/senders/supervisor.ts', () => ({ sendSupervisorTask: async () => { sender.supervisor++ } }))

const { fire, runNow, routeToSender } = await import('../src/scheduler/dispatcher.ts')

beforeEach(() => {
  reset()
  sender.agent = 0
  sender.supervisor = 0
  process.env.REMO_TASK_QC_ENABLED = '1'
})
afterEach(() => {
  delete process.env.REMO_TASK_QC_ENABLED
})
afterAll(() => mock.restore())

describe('ordering: task_qc skips the spend/target pre-gates, other types do not', () => {
  test('task_qc fire: zero calls to threshold, cost cap and target resolution', async () => {
    await fire(QC_ID)
    await flush()
    expect(h.thresholdCalls).toBe(0)
    expect(h.costCapCalls).toBe(0)
    expect(h.resolveTargetsCalls).toBe(0)
    expect(h.claimed).toHaveLength(1)
  })

  test('control task still reaches threshold, cost cap and target resolution', async () => {
    await runNow(CONTROL_ID, USER, { isManual: true })
    await flush()
    expect(h.thresholdCalls).toBe(1)
    expect(h.costCapCalls).toBe(1)
    expect(h.resolveTargetsCalls).toBe(1)
    expect(h.claimed).toHaveLength(0)
  })
})

describe('flag OFF is a true no-op', () => {
  beforeEach(() => {
    delete process.env.REMO_TASK_QC_ENABLED
  })

  test('fire, Run Now and a catchup-style runNow insert no run and read nothing', async () => {
    await fire(QC_ID)
    const manual = await runNow(QC_ID, USER, { isManual: true })
    const catchup = await runNow(QC_ID, USER, {})
    await flush()
    expect(manual.runIds).toEqual([])
    expect(catchup.runIds).toEqual([])
    expect(h.insertedRuns).toHaveLength(0)
    expect(h.claimed).toHaveLength(0)
    expect(h.fake.state.statements).toHaveLength(0)
    expect(h.emails).toHaveLength(0)
    expect(h.timestampCalls).toEqual([])
    expect(h.broadcasts).toHaveLength(0)
  })

  test('holds even with the kill switch engaged: no skipped automation_halted row is inserted', async () => {
    h.halt = { halted: true, scope: 'global' }
    await fire(QC_ID)
    const out = await runNow(QC_ID, USER, { isManual: true })
    await flush()
    expect(out.runIds).toEqual([])
    expect(h.insertedRuns).toHaveLength(0)
    expect(h.afterRunCalls).toHaveLength(0)
    expect(h.fake.state.statements).toHaveLength(0)
  })
})

describe('flag ON with the kill switch engaged', () => {
  for (const scope of ['user', 'global']) {
    test(`${scope} halt: the generic path inserts the skipped automation_halted row and the engine never starts`, async () => {
      h.halt = { halted: true, scope }
      await fire(QC_ID)
      await flush()
      expect(h.insertedRuns).toHaveLength(1)
      expect(h.insertedRuns[0].status).toBe('skipped')
      expect(h.insertedRuns[0].error).toBe(`automation_halted:${scope}`)
      expect(h.claimed).toHaveLength(0)
      expect(h.fake.state.lockCalls).toBe(0)
      expect(h.emails).toHaveLength(0)
      expect(h.fake.state.statements).toHaveLength(0)
    })
  }
})

describe('one open run at a time', () => {
  test('an overlapping fire is dropped as task_qc_already_running; a later fire claims again', async () => {
    let release!: () => void
    h.engineGate = new Promise<void>((r) => { release = r })

    const first = fire(QC_ID)
    await flush() // first has claimed and is parked inside the engine
    expect(h.claimed).toHaveLength(1)

    await fire(QC_ID) // overlapping
    expect(h.claimed).toHaveLength(1)
    expect(h.insertedRuns).toHaveLength(1)
    expect(h.insertedRuns[0].status).toBe('skipped')
    expect(h.insertedRuns[0].error).toBe('task_qc_already_running')
    expect(h.insertedRuns[0].session_id ?? null).toBeNull()

    release()
    await first
    await flush()
    expect(h.finalized.map((f) => f.status)).toEqual(['success'])

    await fire(QC_ID) // first run finalized -> slot is free
    await flush()
    expect(h.claimed).toHaveLength(2)
    expect(h.fake.state.lockCalls).toBe(3) // every claim attempt (claim, dropped, claim) takes the lock first
  })
})

describe('anti-chain sink', () => {
  test('a task_qc target with a triggering run or chain depth is refused', async () => {
    const viaRun = await runNow(QC_ID, USER, { triggeredByRunId: 'parent-run', chainDepth: 1 })
    const viaDepth = await runNow(QC_ID, USER, { chainDepth: 1 })
    const viaTrigger = await runNow(QC_ID, USER, { triggeredByRunId: 'parent-run', isManual: true })
    expect(viaRun.runIds).toEqual([])
    expect(viaDepth.runIds).toEqual([])
    expect(viaTrigger.runIds).toEqual([])
    expect(h.insertedRuns).toHaveLength(0)
    expect(h.claimed).toHaveLength(0)
    expect(h.fake.state.statements).toHaveLength(0)
  })

  test('a manual Run Now without a triggering run is allowed', async () => {
    const out = await runNow(QC_ID, USER, { isManual: true })
    await flush()
    expect(out.runIds).toHaveLength(1)
    expect(h.claimed).toHaveLength(1)
    expect(h.finalized[0]!.status).toBe('success')
  })
})

describe('routeToSender misroute', () => {
  test('a task_qc task finalizes skipped task_qc_not_routable and never reaches the agent or supervisor sender', async () => {
    h.tasks[QC_ID] = { ...h.tasks[QC_ID] }
    await routeToSender(h.tasks[QC_ID], {
      runId: 'run-x', taskId: QC_ID, userId: USER, target: { kind: 'session', sessionId: null, online: true },
      startedAt: Date.now(), parentFireId: null, chainDepth: 0,
    } as any)
    expect(h.finalized).toEqual([{ id: 'run-x', status: 'skipped', error: 'task_qc_not_routable', output_snippet: null }])
    expect(sender.agent).toBe(0)
    expect(sender.supervisor).toBe(0)
  })
})
