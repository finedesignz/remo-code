/**
 * F-11 guard: macro/orchestrator tasks must NEVER be mis-dispatched as bare
 * cron prompts. The orchestrator macro engine is driven solely by the
 * controller due-tick (scanAndEnqueueDueCycles, gated by isOrchestratorEnabled).
 * If such a task ever reaches routeToSender (future misconfig gives it a real
 * cron rule), it must finalize 'skipped' with an orchestrator_* reason and
 * return — never fall through to a sender.
 *
 * We mock the three senders (to assert they are NOT invoked on the guard path,
 * and ARE invoked on the regression path) plus finalizeRun's DB/ws/post-run
 * deps so it runs without a live Postgres. Cache-bust the dispatcher import and
 * mock.restore() in afterAll per the bun mock.module pollution playbook.
 */
import { describe, test, expect, mock, beforeEach, afterAll } from 'bun:test'

const sendAgentTask = mock(async () => {})
const sendSupervisorTask = mock(async () => {})
const sendLogCheck = mock(async () => {})
const finalizeRunCalls: Array<{ runId: string; status: string; error: unknown }> = []
const updateRunStatus = mock(async () => ({ user_id: 'u1', task_id: 't1' }))

mock.module('../src/scheduler/senders/agent.ts', () => ({ sendAgentTask }))
mock.module('../src/scheduler/senders/supervisor.ts', () => ({ sendSupervisorTask }))
mock.module('../src/scheduler/senders/coolify.ts', () => ({ sendLogCheck }))
const realDal = await import('../src/db/scheduled-tasks-dal.ts')
mock.module('../src/db/scheduled-tasks-dal.ts', () => ({
  ...realDal,
  updateRunStatus,
  getTaskById: mock(async () => null),
}))
mock.module('../src/scheduler/post-run/dispatcher.ts', () => ({
  afterRun: mock(async () => {}),
}))

afterAll(() => { mock.restore() })

async function loadDispatcher() {
  // cache-bust so a sibling test's mock.module on the dispatcher can't bleed in
  return await import(`../src/scheduler/dispatcher.ts?f11=${Date.now()}`)
}

function makeTask(over: Record<string, unknown>) {
  return {
    // macro_task_type defaults to 'dev' on EVERY scheduled_tasks row
    // (schema.sql: NOT NULL DEFAULT 'dev') — mirror prod reality so the guard
    // is exercised against realistic rows, not the never-occurring null case.
    id: 't1', user_id: 'u1', task_type: 'dev', cron_expression: '0 * * * *',
    target_kind: 'session', target_id: 's1', macro_task_type: 'dev',
    ...over,
  } as any
}

function makeCtx() {
  return {
    runId: 'r1', taskId: 't1', userId: 'u1',
    target: { kind: 'session', sessionId: 's1' },
    startedAt: Date.now(), chainDepth: 0,
  } as any
}

describe('F-11 routeToSender guard — macro/orchestrator never mis-dispatched', () => {
  beforeEach(() => {
    sendAgentTask.mockClear()
    sendSupervisorTask.mockClear()
    sendLogCheck.mockClear()
    updateRunStatus.mockClear()
    finalizeRunCalls.length = 0
    delete process.env.REMO_ORCHESTRATOR_ENABLED
  })

  test('task_type:orchestrator → skipped (disabled), no sender invoked', async () => {
    const { routeToSender } = await loadDispatcher()
    await routeToSender(makeTask({ task_type: 'orchestrator' }), makeCtx())

    expect(sendAgentTask).not.toHaveBeenCalled()
    expect(sendSupervisorTask).not.toHaveBeenCalled()
    expect(sendLogCheck).not.toHaveBeenCalled()
    expect(updateRunStatus).toHaveBeenCalled()
    const args = updateRunStatus.mock.calls[0] as any[]
    expect(args[0]).toBe('r1')
    expect(args[1].status).toBe('skipped')
    expect(args[1].error).toBe('orchestrator_disabled')
  })

  test('genuine task_type:orchestrator → skipped (due-tick owned) when orchestrator enabled', async () => {
    process.env.REMO_ORCHESTRATOR_ENABLED = '1'
    const { routeToSender } = await loadDispatcher()
    await routeToSender(makeTask({ task_type: 'orchestrator', macro_task_type: 'dev' }), makeCtx())

    expect(sendAgentTask).not.toHaveBeenCalled()
    expect(sendLogCheck).not.toHaveBeenCalled()
    expect(updateRunStatus).toHaveBeenCalled()
    const args = updateRunStatus.mock.calls[0] as any[]
    expect(args[1].status).toBe('skipped')
    expect(args[1].error).toBe('orchestrator_due_tick_owned')
  })

  test('overskip regression: dev task with macro_task_type:dev routes to agent sender (NOT skipped) when orchestrator enabled', async () => {
    // The bug: gating on `|| macroType` skipped EVERY scheduled task, since
    // macro_task_type is NOT NULL DEFAULT 'dev'. A normal dev task must dispatch.
    process.env.REMO_ORCHESTRATOR_ENABLED = '1'
    const { routeToSender } = await loadDispatcher()
    await routeToSender(makeTask({ task_type: 'dev', macro_task_type: 'dev' }), makeCtx())

    expect(sendAgentTask).toHaveBeenCalledTimes(1)
    expect(sendLogCheck).not.toHaveBeenCalled()
    const skipped = updateRunStatus.mock.calls.some((c: any[]) => c[1]?.status === 'skipped')
    expect(skipped).toBe(false)
  })

  test('overskip regression: log_check task with macro_task_type:dev routes to coolify log-pull (NOT skipped) when orchestrator enabled', async () => {
    // This is the exact prod row shape (all 31 enabled tasks: log_check + macro 'dev').
    process.env.REMO_ORCHESTRATOR_ENABLED = '1'
    const { routeToSender } = await loadDispatcher()
    await routeToSender(makeTask({ task_type: 'log_check', macro_task_type: 'dev' }), makeCtx())

    expect(sendLogCheck).toHaveBeenCalledTimes(1)
    expect(sendAgentTask).not.toHaveBeenCalled()
    const skipped = updateRunStatus.mock.calls.some((c: any[]) => c[1]?.status === 'skipped')
    expect(skipped).toBe(false)
  })
})
