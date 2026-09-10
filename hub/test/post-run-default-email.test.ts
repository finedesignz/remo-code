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

  test('(d) chainDepth>0 on a SUCCESSFUL step → never synthesizes (no per-step spam)', () => {
    expect(buildDefaultEmailActions(baseTask, 1, [])).toEqual([])
    expect(buildDefaultEmailActions(baseTask, 5, [])).toEqual([])
    const ok = { status: 'success' as const, output_snippet: 'Summary: SHIPPED' }
    expect(buildDefaultEmailActions(baseTask, 1, [], ok)).toEqual([])
  })

  // fix/chained-step-notify: a chained step that fails or self-reports BLOCKED
  // produced ZERO notification, so an unattended chain wedged invisibly.
  test('(e) chainDepth>0 + status=failed → notifies', () => {
    const out = buildDefaultEmailActions(baseTask, 2, [], {
      status: 'failed',
      output_snippet: null,
    })
    expect(out.length).toBe(1)
    expect(out[0].type).toBe('notify_email')
  })

  test('(f) chainDepth>0 + "Summary: BLOCKED:" in the output → notifies', () => {
    const out = buildDefaultEmailActions(baseTask, 1, [], {
      status: 'success',
      output_snippet: 'did stuff\nSummary: BLOCKED: needs a human to approve the merge',
    })
    expect(out.length).toBe(1)
  })

  test('(g) chained failure on a task with its own notify_email → no duplicate', () => {
    const existing = [
      { type: 'notify_email', on: 'failure', config: { subject: 's', body: 'b' } },
    ] as any
    expect(
      buildDefaultEmailActions(baseTask, 1, existing, { status: 'failed', output_snippet: null }),
    ).toEqual([])
  })

  test('(h) chained failure with email_summary=false → still suppressed (explicit opt-out)', () => {
    const opted = { ...baseTask, email_summary: false }
    expect(
      buildDefaultEmailActions(opted, 1, [], { status: 'failed', output_snippet: null }),
    ).toEqual([])
  })

  test('email_summary undefined (legacy row) defaults on', () => {
    const legacy = { id: 't', user_id: 'u', name: 'x' } as any
    expect(buildDefaultEmailActions(legacy, 0, []).length).toBe(1)
  })

  test('other configured actions (non-email) still get a default email', () => {
    const withWebhook = [{ type: 'webhook', on: 'always', config: { url: 'https://x' } }] as any
    expect(buildDefaultEmailActions(baseTask, 0, withWebhook).length).toBe(1)
  })

  // fix/internal-skip-email-noise: `__internal_*` tasks (Coolify deployment
  // metadata, triage anchor) are machine plumbing the owner never scheduled and
  // can't opt out of via email_summary. A `skipped` run on one (e.g. the
  // webhook's no_routable_session orphan-run finalize) is a routine no-op —
  // must not email. A genuine failure or a user-created task's skip still does.
  test('(i) internal task + status=skipped → suppressed', () => {
    const internal = { ...baseTask, name: '__internal_coolify_deployment' }
    const out = buildDefaultEmailActions(internal, 0, [], {
      status: 'skipped',
      output_snippet: null,
    })
    expect(out).toEqual([])
  })

  test('(j) user-created task + status=skipped → still notifies', () => {
    const out = buildDefaultEmailActions(baseTask, 0, [], {
      status: 'skipped',
      output_snippet: null,
    })
    expect(out.length).toBe(1)
  })

  test('(k) internal task + status=failed → still notifies (only skipped is suppressed)', () => {
    const internal = { ...baseTask, name: '__internal_triage' }
    const out = buildDefaultEmailActions(internal, 0, [], {
      status: 'failed',
      output_snippet: null,
    })
    expect(out.length).toBe(1)
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
