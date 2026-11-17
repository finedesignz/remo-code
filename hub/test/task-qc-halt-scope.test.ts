/**
 * PTYCAP-08-08 Task 3 (F2-B6): which kill-switch scopes stop the anchorless auditor.
 * The seeded task_qc row has no session, so global / user / env halts stop it and a
 * session-scoped halt (even on a session it audits) does not. Pinned so the behavior
 * is a tested fact, not an accident of the anchor choice.
 *
 * Real: dispatcher fire branch, claim, sender, engine. Mocked: the fire-harness set,
 * with isAutomationHalted replaced by a recorder that models the scope matching.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-chars-long-aaaaaaaa'

import { describe, test, expect, beforeEach, afterEach, afterAll, mock } from 'bun:test'
import { automationControlsLeaf } from './fixtures/automation-controls-leaf.ts'
import { setupFireHarness, flush, qcTaskRow, QC_ID, USER } from './fixtures/task-qc-fire-harness.ts'

const { h, reset } = setupFireHarness()

type HaltCall = { userId: string; sessionId?: string }
const halts = {
  calls: [] as HaltCall[],
  /** decides the answer from the recorded arguments, modeling scope matching */
  decide: (_a: HaltCall): { halted: boolean; scope?: string } => ({ halted: false }),
}
// Re-mock before the dispatcher is first imported: the harness controls mock ignores its arguments.
mock.module('../src/dispatch/automation-controls.ts', () => ({
  ...automationControlsLeaf(),
  isAutomationHalted: async (a: HaltCall) => {
    halts.calls.push({ userId: a.userId, sessionId: a.sessionId })
    const d = halts.decide(a)
    return d.halted ? { halted: true, scope: d.scope ?? 'global' } : { halted: false }
  },
  reserveInject: async (a: any) => { h.reservations.push(a); return h.reserveResult },
  haltBeforeMachineSend: async () => ({ ok: true }),
}))
mock.module('../src/scheduler/post-run/dispatcher.ts', () => ({
  afterRun: async (input: any) => { h.afterRunCalls.push(input) },
}))
mock.module('../src/scheduler/senders/agent.ts', () => ({ sendAgentTask: async () => {} }))
mock.module('../src/scheduler/senders/supervisor.ts', () => ({ sendSupervisorTask: async () => {} }))

const { fire } = await import('../src/scheduler/dispatcher.ts')

const engineStarts = () => h.fake.state.statements.filter((s) => /FROM scheduled_tasks WHERE user_id/.test(s.text)).length

beforeEach(() => {
  reset()
  halts.calls = []
  halts.decide = () => ({ halted: false })
  process.env.REMO_TASK_QC_ENABLED = '1'
})
afterEach(() => {
  delete process.env.REMO_TASK_QC_ENABLED
})
afterAll(() => mock.restore())

function expectHaltedSkip(scope: string) {
  expect(h.insertedRuns).toHaveLength(1)
  expect(h.insertedRuns[0].status).toBe('skipped')
  expect(h.insertedRuns[0].error).toBe(`automation_halted:${scope}`)
  expect(h.claimed).toHaveLength(0)
  expect(engineStarts()).toBe(0)
  expect(h.emails).toHaveLength(0)
}

describe('halt scope for the anchorless auditor', () => {
  test('a global-scope halt skips the run with automation_halted:global, no engine, no email', async () => {
    halts.decide = () => ({ halted: true, scope: 'global' })
    await fire(QC_ID)
    await flush()
    expectHaltedSkip('global')
  })

  test('a user-scope halt skips the run with automation_halted:user, no engine, no email', async () => {
    halts.decide = (a) => (a.userId === USER ? { halted: true, scope: 'user' } : { halted: false })
    await fire(QC_ID)
    await flush()
    expectHaltedSkip('user')
  })

  test('isAutomationHalted is called for the task_qc row with the user id and an undefined sessionId', async () => {
    await fire(QC_ID)
    await flush()
    expect(halts.calls).toHaveLength(1)
    expect(halts.calls[0]!.userId).toBe(USER)
    expect(halts.calls[0]!.sessionId).toBeUndefined()
  })

  test('a session-scoped halt on an audited session does NOT stop the auditor', async () => {
    // models the real matcher: a session row only matches the exact session id
    halts.decide = (a) => (a.sessionId === 'sess-1' ? { halted: true, scope: 'session' } : { halted: false })
    await fire(QC_ID)
    await flush()
    expect(h.claimed).toHaveLength(1)
    expect(engineStarts()).toBe(1)
    expect(h.insertedRuns.filter((r) => r.error === 'automation_halted:session')).toHaveLength(0)
  })

  test('releasing the halt: the next fire runs normally', async () => {
    halts.decide = () => ({ halted: true, scope: 'global' })
    await fire(QC_ID)
    await flush()
    expect(h.claimed).toHaveLength(0)
    halts.decide = () => ({ halted: false })
    await fire(QC_ID)
    await flush()
    expect(h.claimed).toHaveLength(1)
    expect(engineStarts()).toBe(1)
  })

  test('the env break-glass (controls module reports scope env) stops the run like the API switch', async () => {
    halts.decide = () => ({ halted: true, scope: 'env' })
    await fire(QC_ID)
    await flush()
    expectHaltedSkip('env')
  })

  test('malformed row: a task_qc row given a session_id by mistake fails CLOSED under a session-scoped halt (documented behavior)', async () => {
    h.tasks[QC_ID] = qcTaskRow({ session_id: 'sess-9' })
    halts.decide = (a) => (a.sessionId === 'sess-9' ? { halted: true, scope: 'session' } : { halted: false })
    await fire(QC_ID)
    await flush()
    expect(halts.calls[0]!.sessionId).toBe('sess-9')
    expectHaltedSkip('session')
  })
})
