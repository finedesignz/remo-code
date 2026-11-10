/**
 * PTYCAP-08-03 Task 3 (verdict F1-A2): task_qc is TERMINAL across the whole
 * lifecycle. No generic post-run action, default summary email, aggregator report
 * or chain edge can act on a task_qc run, even when the stored row carries
 * malformed post_run_actions, email_summary true or a parentFireId.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-chars-long-aaaaaaaa'

import { describe, test, expect, beforeEach, afterEach, afterAll, mock } from 'bun:test'
import { setupFireHarness, flush, QC_ID, CONTROL_ID, USER, AUDITED_ID, failedRuns, qcTaskRow, controlTaskRow } from './fixtures/task-qc-fire-harness.ts'

const { h, reset } = setupFireHarness()
const exec = { email: 0, webhook: 0, telegram: 0, webpush: 0, ghIssue: 0, deployVerify: 0, aggregator: 0, pipeline: 0, launch: 0, propose: 0 }
const resetExec = () => { for (const k of Object.keys(exec) as Array<keyof typeof exec>) exec[k] = 0 }

mock.module('../src/scheduler/post-run/email.ts', () => ({ executeEmail: async () => { exec.email++ } }))
mock.module('../src/scheduler/post-run/webhook.ts', () => ({ executeWebhook: async () => { exec.webhook++ } }))
mock.module('../src/scheduler/post-run/telegram.ts', () => ({ executeTelegram: async () => { exec.telegram++ } }))
mock.module('../src/scheduler/post-run/webpush.ts', () => ({ executeWebPush: async () => { exec.webpush++ } }))
mock.module('../src/scheduler/post-run/github-issue.ts', () => ({ executeGithubIssue: async () => { exec.ghIssue++ } }))
mock.module('../src/scheduler/post-run/deploy-verify.ts', () => ({ executeDeployVerify: async () => { exec.deployVerify++ } }))
mock.module('../src/scheduler/post-run/propose-notify.ts', () => ({ surfaceProposal: async () => { exec.propose++ } }))
mock.module('../src/scheduler/post-run/aggregator.ts', () => ({
  report: async () => { exec.aggregator++ },
  register: () => {},
}))
mock.module('../src/agentautofix/reporter.ts', () => ({
  reportSelfErrorToAgentautofix: async () => {},
  reportTriageFindingToAgentautofix: async () => {},
  scrub: (x: unknown) => x,
}))
mock.module('../src/db/dal.ts', () => ({
  hasVerifiedFinding: async () => false,
  recordVerifiedFinding: async () => {},
  INTERNAL_TRIAGE_TASK_NAME: '__internal_triage',
  claimTriageFindingForward: async () => false,
  getUserById: async () => ({ email: 'owner@example.com' }),
}))
mock.module('../src/dispatch/pipeline.ts', () => ({ dispatch: async () => { exec.pipeline++ } }))
mock.module('../src/telegram/launch.ts', () => ({ launchSessionForUser: async () => { exec.launch++ } }))

const { fire } = await import('../src/scheduler/dispatcher.ts')
const { afterRun, fireWithContext } = await import('../src/scheduler/post-run/dispatcher.ts')
const { executeChain } = await import('../src/scheduler/post-run/chain.ts')

const MALFORMED = [
  { id: 'a1', task_id: QC_ID, type: 'notify_email', config: {} },
  { id: 'a2', task_id: QC_ID, type: 'webhook', config: { url: 'https://example.invalid/hook' } },
  { id: 'a3', task_id: QC_ID, type: 'chain_task', config: { task_id: CONTROL_ID } },
  { id: 'a4', task_id: QC_ID, type: 'github_issue', config: {} },
  { id: 'a5', task_id: QC_ID, type: 'not_a_real_action', config: 42 },
]

const args = (task: any, over: Record<string, unknown> = {}) => ({
  task,
  runId: 'run-9',
  status: 'success' as const,
  error: null,
  cost_usd: null,
  duration_ms: 5,
  output_snippet: '{}',
  parentFireId: null,
  chainDepth: 0,
  ...over,
})

beforeEach(() => {
  reset()
  resetExec()
  h.tasks[QC_ID] = qcTaskRow({ email_summary: true })
  h.actionRows = MALFORMED
  process.env.REMO_TASK_QC_ENABLED = '1'
})
afterEach(() => {
  delete process.env.REMO_TASK_QC_ENABLED
})
afterAll(() => mock.restore())

const execTotal = () => Object.values(exec).reduce((a, b) => a + b, 0)

describe('post-run guards', () => {
  test('afterRun returns first for task_qc: no aggregator report, no action listing, no executor', async () => {
    await afterRun(args(h.tasks[QC_ID], { parentFireId: 'fanout_x_1' }))
    await afterRun(args(h.tasks[QC_ID], { status: 'failed', error: 'x' }))
    expect(h.listActionsCalls).toBe(0)
    expect(execTotal()).toBe(0)
  })

  test('fireWithContext returns first for task_qc: no triage handling, no listing, no default email', async () => {
    await fireWithContext(args(h.tasks[QC_ID]))
    await flush()
    expect(h.listActionsCalls).toBe(0)
    expect(exec.email).toBe(0)
    expect(execTotal()).toBe(0)
    expect(h.getTaskCalls).toEqual([])
  })

  test('other task types are unchanged: a control task still lists its actions', async () => {
    h.actionRows = []
    await afterRun(args(controlTaskRow()))
    expect(h.listActionsCalls).toBe(1)
  })
})

describe('chain guards', () => {
  const action = (taskId: string) => ({ type: 'chain_task', config: { task_id: taskId } }) as any

  test('a task_qc PARENT never chains', async () => {
    await executeChain(action(CONTROL_ID), { parentRunId: 'run-9', userId: USER, chainDepth: 0, parentTaskKind: 'task_qc' })
    expect(h.getTaskCalls).toEqual([])
    expect(h.insertedRuns).toHaveLength(0)
  })

  test('a task_qc CHILD is refused: the child row is looked up and runNow is never reached', async () => {
    await executeChain(action(QC_ID), { parentRunId: 'run-9', userId: USER, chainDepth: 0, parentTaskKind: 'dev' })
    await flush()
    expect(h.getTaskCalls).toContain(QC_ID)
    expect(h.claimed).toHaveLength(0)
    expect(h.insertedRuns).toHaveLength(0)
    expect(h.fake.state.statements).toHaveLength(0)
  })

  test('a non-task_qc child still chains (existing behavior)', async () => {
    await executeChain(action(CONTROL_ID), { parentRunId: 'run-9', userId: USER, chainDepth: 0, parentTaskKind: 'dev' })
    await flush()
    expect(h.insertedRuns).toHaveLength(1) // reached fireTask (resolveTargets mock yields no_targets)
    expect(h.resolveTargetsCalls).toBe(1)
  })
})

describe('FULL LIFECYCLE: fire -> finalize -> post-run with malformed stored data', () => {
  test('a run with a finding: exactly one email (the digest), nothing else acts', async () => {
    await fire(QC_ID)
    await flush()

    expect(h.emails).toHaveLength(1) // the digest only
    expect(h.finalized[0]!.status).toBe('success')
    expect(h.listActionsCalls).toBe(0) // generic post-run never listed the malformed actions
    expect(execTotal()).toBe(0) // no email/webhook/telegram/issue executor, no aggregator, no pipeline dispatch, no session launch
    expect(exec.pipeline).toBe(0)
    expect(exec.launch).toBe(0)
    // no chain execution: the chain_task child was never even looked up
    expect(h.getTaskCalls.filter((id) => id === CONTROL_ID)).toHaveLength(0)
    expect(h.insertedRuns).toHaveLength(0)
    // no user_message / token_usage / messages statements at all
    expect(h.fake.state.statements.filter((s) => /user_message|token_usage|\bmessages\b/.test(s.text))).toHaveLength(0)
    h.fake.assertNoUnknown()
  })

  test('a run without findings: zero emails (no default summary email even with email_summary true)', async () => {
    h.auditedRuns = failedRuns(AUDITED_ID).map((r) => ({ ...r, status: 'success', error: null }))
    await fire(QC_ID)
    await flush()
    expect(h.emails).toHaveLength(0)
    expect(exec.email).toBe(0)
    expect(h.listActionsCalls).toBe(0)
    expect(execTotal()).toBe(0)
    expect(h.finalized[0]!.status).toBe('success')
  })
})
