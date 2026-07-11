/**
 * Tests for the default-on run-summary email
 * (feat/scheduled-default-email-summary).
 *
 * Two layers:
 *   1. Pure helper `buildDefaultEmailActions` — eligibility + synthesis, no mocks.
 *   2. Integration through `fireWithContext` — mock listActionsForTask (source of
 *      the task's configured actions) + executeEmail (capture fires) to prove a
 *      root run with zero actions fires exactly one owner-resolved notify_email.
 */
import { describe, test, expect, beforeEach, mock } from 'bun:test'

// ── Layer 1: pure helper ────────────────────────────────────────────────────
import { buildDefaultEmailActions } from '../src/scheduler/post-run/dispatcher.ts'

const baseTask = { id: 't1', user_id: 'u1', name: 'Nightly', email_summary: true } as any

describe('buildDefaultEmailActions', () => {
  test('(a) root run, zero actions, email_summary=true → one notify_email, no `to`', () => {
    const out = buildDefaultEmailActions(baseTask, 0, [])
    expect(out.length).toBe(1)
    expect(out[0].type).toBe('notify_email')
    expect(out[0].on).toBe('always')
    // `to` omitted ⇒ executeEmail resolves to the owner's account email.
    expect(out[0].config.to).toBeUndefined()
    expect(out[0].config.subject).toContain('{{task_name}}')
    expect(out[0].config.body).toContain('{{status}}')
  })

  test('(b) root run that already has a notify_email → no duplicate', () => {
    const existing = [
      { type: 'notify_email', on: 'failure', config: { subject: 's', body: 'b' } },
    ] as any
    expect(buildDefaultEmailActions(baseTask, 0, existing)).toEqual([])
  })

  test('(c) email_summary=false → suppressed', () => {
    const opted = { ...baseTask, email_summary: false }
    expect(buildDefaultEmailActions(opted, 0, [])).toEqual([])
  })

  test('(d) chainDepth>0 → never synthesizes', () => {
    expect(buildDefaultEmailActions(baseTask, 1, [])).toEqual([])
    expect(buildDefaultEmailActions(baseTask, 5, [])).toEqual([])
  })

  test('email_summary undefined (legacy row) defaults on', () => {
    const legacy = { id: 't', user_id: 'u', name: 'x' } as any
    expect(buildDefaultEmailActions(legacy, 0, []).length).toBe(1)
  })

  test('other configured actions (non-email) still get a default email', () => {
    const withWebhook = [{ type: 'webhook', on: 'always', config: { url: 'https://x' } }] as any
    expect(buildDefaultEmailActions(baseTask, 0, withWebhook).length).toBe(1)
  })
})

// ── Layer 2: integration through fireWithContext ────────────────────────────
let configuredActions: any[] = []
const realStDal = await import(`../src/db/scheduled-tasks-dal.ts?real=${Date.now()}`)
mock.module('../src/db/scheduled-tasks-dal.ts', () => ({
  ...realStDal,
  listActionsForTask: async (_taskId: string) => configuredActions,
  getTaskById: async () => null,
}))

const emailFires: any[] = []
mock.module('../src/scheduler/post-run/email.ts', () => ({
  executeEmail: async (action: any, ctx: any) => {
    emailFires.push({ action, ctx })
  },
}))

function makeArgs(over: Partial<any> = {}) {
  return {
    task: { id: 't1', user_id: 'u1', name: 'Nightly', task_type: 'log_check', email_summary: true } as any,
    runId: 'run1',
    status: 'success' as const,
    error: null,
    cost_usd: 0.12,
    duration_ms: 3400,
    output_snippet: 'ok',
    parentFireId: null,
    chainDepth: 0,
    ...over,
  }
}

describe('fireWithContext default email', () => {
  beforeEach(() => {
    configuredActions = []
    emailFires.length = 0
  })

  test('root run with zero actions fires exactly one owner-resolved email', async () => {
    const { fireWithContext } = await import('../src/scheduler/post-run/dispatcher.ts')
    await fireWithContext(makeArgs())
    await Promise.resolve() // flush the void executeEmail microtask
    expect(emailFires.length).toBe(1)
    // `to` omitted ⇒ owner resolution inside executeEmail.
    expect(emailFires[0].action.config.to).toBeUndefined()
    expect(emailFires[0].ctx.userId).toBe('u1')
  })

  test('root run with a custom notify_email does not get a duplicate', async () => {
    configuredActions = [
      { type: 'notify_email', on: 'always', config: { to: 'me@x.com', subject: 's', body: 'b' } },
    ]
    const { fireWithContext } = await import('../src/scheduler/post-run/dispatcher.ts')
    await fireWithContext(makeArgs())
    await Promise.resolve()
    expect(emailFires.length).toBe(1)
    expect(emailFires[0].action.config.to).toBe('me@x.com')
  })

  test('email_summary=false suppresses the default email', async () => {
    const { fireWithContext } = await import('../src/scheduler/post-run/dispatcher.ts')
    await fireWithContext(makeArgs({ task: { id: 't1', user_id: 'u1', name: 'N', task_type: 'log_check', email_summary: false } as any }))
    await Promise.resolve()
    expect(emailFires.length).toBe(0)
  })

  test('fan-out aggregate (chainDepth 0) yields exactly one default email', async () => {
    const { fireWithContext } = await import('../src/scheduler/post-run/dispatcher.ts')
    await fireWithContext(makeArgs({ aggregate: { total: 3, successes: 2, failures: 1 } }))
    await Promise.resolve()
    expect(emailFires.length).toBe(1)
  })
})
