/**
 * fix/chained-step-notify (QC blocker) — end-to-end: a CHAINED dev_ship step
 * whose reply is longer than the 500-char snippet head and ends in
 * `Summary: BLOCKED: ...` must still notify the owner.
 *
 * Path exercised: sendAgentTask's RunStore.onFinalize (which builds the snippet)
 * -> finalizeRun -> post-run fireWithContext -> executeEmail. Testing
 * buildDefaultEmailActions in isolation would NOT have caught the real defect:
 * the head-truncation in onFinalize dropped the end-of-turn Summary line, so the
 * predicate never saw it in production.
 */
import { describe, test, expect, beforeEach, mock } from 'bun:test'

// ── stub the ws + db + pipeline plumbing sendAgentTask touches ───────────────
const realRegistry = await import(`../src/ws/registry.ts?real=${Date.now()}`)
mock.module('../src/ws/registry.ts', () => ({
  ...realRegistry,
  getChannel: () => ({ ws: { send() {} } }),
  broadcastToSubscribers: () => {},
  listOnlineAgentSessionsForUser: () => ['sess-1'],
}))

mock.module('../src/db/postgres.ts', () => ({
  sql: async () => [],
}))

let capturedStore: any = null
mock.module('../src/dispatch/pipeline.ts', () => ({
  dispatch: async (_req: any, deps: any) => {
    capturedStore = deps.store
    return { kind: 'sent' }
  },
  onSessionReply: async () => {},
}))

// ── finalizeRun forwards to the REAL post-run pipeline, as it does in prod ───
let chainDepth = 2
const realSchedDispatcher = await import(`../src/scheduler/dispatcher.ts?real=${Date.now()}`)
mock.module('../src/scheduler/dispatcher.ts', () => ({
  ...realSchedDispatcher,
  removeRunContext: () => {},
  finalizeRun: async (runId: string, status: string, error: string | null, extra: any = {}) => {
    const { afterRun } = await import('../src/scheduler/post-run/dispatcher.ts')
    await afterRun({
      task: shipTask,
      runId,
      status: status as any,
      error,
      cost_usd: null,
      duration_ms: extra.duration_ms ?? null,
      output_snippet: extra.output_snippet ?? null,
      parentFireId: null,
      chainDepth,
    })
  },
}))

const realStDal = await import(`../src/db/scheduled-tasks-dal.ts?real=${Date.now()}`)
mock.module('../src/db/scheduled-tasks-dal.ts', () => ({
  ...realStDal,
  listActionsForTask: async () => [],
  getTaskById: async () => null,
}))

const emailFires: any[] = []
mock.module('../src/scheduler/post-run/email.ts', () => ({
  executeEmail: async (action: any, ctx: any) => { emailFires.push({ action, ctx }) },
}))

const { sendAgentTask, buildRunSnippet } = await import('../src/scheduler/senders/agent.ts')

const shipTask = {
  id: 'ship-1',
  user_id: 'u1',
  session_id: 'sess-1',
  name: 'dev ship',
  task_type: 'dev_ship',
  prompt: 'ship it',
  email_summary: true,
} as any
const ctx = {
  runId: 'run-1',
  taskId: 'ship-1',
  userId: 'u1',
  target: { kind: 'session', sessionId: 'sess-1' },
} as any

/** A realistic ship turn: well past 500 chars, verdict on the LAST line. */
function longReply(summary: string): string {
  const body = Array.from(
    { length: 30 },
    (_, i) => `- step ${i}: bumped version, pushed branch, opened PR, polled /health for the deploy`,
  ).join('\n')
  return `${body}\n\n${summary}`
}

async function finalizeThroughSender(reply: string): Promise<void> {
  capturedStore = null
  await sendAgentTask(shipTask, ctx)
  expect(capturedStore).not.toBeNull()
  await capturedStore.onFinalize('run-1', reply)
  await Promise.resolve() // flush the void executeEmail microtask
}

describe('chained step that reports a terminal Summary notifies the owner', () => {
  beforeEach(() => {
    emailFires.length = 0
    chainDepth = 2
  })

  test('>500-char reply ending in "Summary: BLOCKED:" → owner notified', async () => {
    const reply = longReply('Summary: BLOCKED: branch protection requires a human reviewer')
    expect(reply.length).toBeGreaterThan(500)
    await finalizeThroughSender(reply)
    expect(emailFires.length).toBe(1)
    expect(emailFires[0].ctx.userId).toBe('u1')
  })

  test('the snippet PRESERVES the trailing Summary line past head-truncation', () => {
    const snippet = buildRunSnippet(longReply('Summary: BLOCKED: needs a human'))
    expect(snippet).toContain('Summary: BLOCKED: needs a human')
  })

  test('bolded "**Summary:** BLOCKED:" is detected too', async () => {
    await finalizeThroughSender(longReply('**Summary:** BLOCKED: waiting on approval'))
    expect(emailFires.length).toBe(1)
  })

  for (const verdict of ['DEPLOY UNHEALTHY', 'SKIPPED', 'FAILED']) {
    test(`"Summary: ${verdict}:" wedges the chain → owner notified`, async () => {
      await finalizeThroughSender(longReply(`Summary: ${verdict}: see logs`))
      expect(emailFires.length).toBe(1)
    })
  }

  test('a chained step that actually SHIPPED stays silent', async () => {
    await finalizeThroughSender(longReply('Summary: SHIPPED: v1.2.3 live'))
    expect(emailFires.length).toBe(0)
  })

  test('a ROOT run still emails regardless of verdict', async () => {
    chainDepth = 0
    await finalizeThroughSender(longReply('Summary: SHIPPED: v1.2.3 live'))
    expect(emailFires.length).toBe(1)
  })
})
