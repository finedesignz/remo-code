/**
 * Scheduler dispatch adapter tests (Round-2 migration — subsystem 3).
 *
 * Proves the scheduler's SESSION send path drives the shared dispatch pipeline
 * end to end, exactly as the error-capture + revanote adapters do:
 *
 *   1. open() fires EXACTLY ONCE per real dispatch (teeth-test) — never for a
 *      cost-capped / queued message.
 *   2. The send frame carries the `## RUNTIME CONTEXT` block + the `Summary:`
 *      directive (SENT string only); the persisted `messages` content is the
 *      bare `[scheduled: …]` stored form (no directive, no runtime block).
 *   3. onSessionReply (the agent assistant_message bridge) finalizes the run via
 *      the dispatcher's finalizeRun — which is the seam that fires the post-run
 *      action pipeline (chain/email/telegram/webhook/github-issue).
 *   4. IR-1: a cost-capped user is skipped and the send fn is NEVER called.
 *   5. A queued waiter (2nd dispatch on a busy session) opens its run only on
 *      PROMOTION (onSessionReply), and the promotion re-runs the gate list.
 *
 * The dispatcher's finalizeRun / removeRunContext / getRunContext, the DAL sql,
 * insertMessage, the ws registry, the runtime-context builder, and the gates are
 * mocked so no Postgres / no live WS is needed. The dispatch pipeline + the
 * adapter (`senders/agent.ts`) are REAL — that wiring is what's under test.
 *
 * Bun mock.module hygiene (per project memory feedback_bun_mock_pollution):
 * cache-bust real modules, afterAll(mock.restore).
 */
import { describe, test, expect, beforeEach, afterAll, mock } from 'bun:test'

const realCtx = await import(`../src/scheduler/context/runtime-context.ts?bust=${Date.now()}`)

const state: {
  finalized: Array<{ runId: string; status: string; error: string | null; fields: any }>
  removed: string[]
  sentFrames: any[]
  insertedMessages: Array<{ sessionId: string; role: string; content: string }>
  online: Set<string>
  capExceeded: boolean
} = {
  finalized: [],
  removed: [],
  sentFrames: [],
  insertedMessages: [],
  online: new Set(['sess-1']),
  capExceeded: false,
}

// Mock the dispatcher's finalize/remove/getRunContext. finalizeRun is the seam
// that (in prod) fires the post-run action pipeline — asserting it's called with
// the right status proves post-run fires on finalize / skip / fail.
mock.module('../src/scheduler/dispatcher.ts', () => ({
  finalizeRun: async (runId: string, status: string, error?: string | null, fields: any = {}) => {
    state.finalized.push({ runId, status, error: error ?? null, fields })
  },
  removeRunContext: (runId: string) => { state.removed.push(runId) },
  getRunContext: () => null,
}))

mock.module('../src/db/postgres.ts', () => ({
  // sendAgentTask's only direct sql use is the runtime_context_snapshot UPDATE.
  sql: async () => [],
}))

mock.module('../src/db/dal.ts', () => ({
  insertMessage: async (sessionId: string, role: string, content: string) => {
    state.insertedMessages.push({ sessionId, role, content })
    return { id: `msg-${state.insertedMessages.length}`, created_at: new Date().toISOString() }
  },
}))

mock.module('../src/ws/registry.ts', () => ({
  getChannel: (sessionId: string) =>
    state.online.has(sessionId)
      ? { ws: { send: (f: string) => state.sentFrames.push(JSON.parse(f)) } }
      : null,
  broadcastToSubscribers: () => {},
}))

// Runtime-context builder hits SQL; stub to a fixed snapshot + a known block.
mock.module('../src/scheduler/context/runtime-context.ts', () => ({
  ...realCtx,
  buildRuntimeContext: async () => ({ repo: 'demo/app', branch: 'main' }),
  renderRuntimeContextBlock: () => '## RUNTIME CONTEXT\nrepo: demo/app',
}))

// Pass-through threshold; cost-cap toggled by state.capExceeded (IR-1 teeth).
mock.module('../src/dispatch/gates.ts', () => ({
  thresholdGate: { name: 'threshold', async check() { return { ok: true } } },
  dailyCostCapGate: {
    name: 'daily_cost_cap',
    async check() {
      return state.capExceeded ? { ok: false, reason: 'daily_cost_cap' } : { ok: true }
    },
  },
}))

// Import AFTER mocks. Pipeline + adapter are REAL.
const { sendAgentTask, isScheduledRunActive } = await import('../src/scheduler/senders/agent.ts')
const { onSessionReply, _reset } = await import('../src/dispatch/pipeline.ts')

const TASK: any = { id: 'task-1', name: 'Nightly Sweep', task_type: 'dev', prompt: 'Continue.', payload: {} }
const ctx = (over: any = {}) => ({
  runId: over.runId ?? 'run-1',
  taskId: 'task-1',
  userId: 'user-1',
  target: { sessionId: over.sessionId ?? 'sess-1' },
  ...over,
})

beforeEach(() => {
  state.finalized = []
  state.removed = []
  state.sentFrames = []
  state.insertedMessages = []
  state.online = new Set(['sess-1'])
  state.capExceeded = false
  _reset()
})

describe('scheduler dispatch adapter — open→send→finalize lifecycle', () => {
  afterAll(() => mock.restore())

  test('dispatched run sends Summary+RUNTIME block (sent only), stores bare content, finalizes on reply', async () => {
    await sendAgentTask(TASK, ctx())

    // send fired exactly once.
    expect(state.sentFrames).toHaveLength(1)
    const frame = state.sentFrames[0]
    expect(frame.type).toBe('user_message')
    expect(frame.run_id).toBe('run-1')
    // SENT string carries the runtime context block + the Summary directive.
    expect(frame.content).toContain('## RUNTIME CONTEXT')
    expect(frame.content).toContain('Summary:')
    expect(frame.content).toContain('## TASK')

    // STORED messages content is the bare scheduled form — NO directive, NO block.
    expect(state.insertedMessages).toHaveLength(1)
    const stored = state.insertedMessages[0].content
    expect(stored).toBe('[scheduled: Nightly Sweep]\n\nContinue.')
    expect(stored).not.toContain('Summary:')
    expect(stored).not.toContain('## RUNTIME CONTEXT')

    // active gate is set while in flight.
    expect(isScheduledRunActive('sess-1')).toBe(true)

    // Reply lands → onFinalize → finalizeRun(success) (fires post-run in prod).
    await onSessionReply('sess-1', 'Done. Summary: shipped the fix.')
    const fin = state.finalized.find((f) => f.runId === 'run-1')
    expect(fin).toBeTruthy()
    expect(fin!.status).toBe('success')
    expect(fin!.fields.output_snippet).toContain('Done.')
    expect(state.removed).toContain('run-1')
    expect(isScheduledRunActive('sess-1')).toBe(false)
  })

  test('IR-1: cost-capped user is skipped and send is NEVER called', async () => {
    state.capExceeded = true
    await sendAgentTask(TASK, ctx())

    expect(state.sentFrames).toHaveLength(0) // send never called
    expect(state.insertedMessages).toHaveLength(0)
    const skip = state.finalized.find((f) => f.runId === 'run-1')
    expect(skip).toBeTruthy()
    expect(skip!.status).toBe('skipped')
    expect(skip!.error).toBe('daily_cost_cap')
  })

  test('open() fires once per real dispatch: a queued 2nd run opens only on promotion, re-running gates', async () => {
    // 1st dispatch claims the in-flight slot + sends.
    await sendAgentTask(TASK, ctx({ runId: 'run-1' }))
    expect(state.sentFrames).toHaveLength(1)

    // 2nd dispatch on the same busy session → queued; NO send yet.
    await sendAgentTask(TASK, ctx({ runId: 'run-2' }))
    expect(state.sentFrames).toHaveLength(1) // still just the first

    // Head replies → finalize run-1, promote run-2, re-dispatch it (send #2).
    await onSessionReply('sess-1', 'first done')
    expect(state.finalized.find((f) => f.runId === 'run-1')?.status).toBe('success')
    expect(state.sentFrames).toHaveLength(2)
    expect(state.sentFrames[1].run_id).toBe('run-2')

    // run-2 reply finalizes it too.
    await onSessionReply('sess-1', 'second done')
    expect(state.finalized.find((f) => f.runId === 'run-2')?.status).toBe('success')
  })

  test('IR-2: a user who crosses the cost cap WHILE queued is skipped on promotion (gate re-check)', async () => {
    await sendAgentTask(TASK, ctx({ runId: 'run-1' }))
    await sendAgentTask(TASK, ctx({ runId: 'run-2' }))
    expect(state.sentFrames).toHaveLength(1)

    // Cap crossed before the head finishes. Promotion re-runs the gate list.
    state.capExceeded = true
    await onSessionReply('sess-1', 'first done')

    // run-2 is NOT sent; it's skipped on the promotion gate re-check.
    expect(state.sentFrames).toHaveLength(1)
    const r2 = state.finalized.find((f) => f.runId === 'run-2')
    expect(r2).toBeTruthy()
    expect(r2!.status).toBe('skipped')
    expect(r2!.error).toBe('daily_cost_cap')
  })

  test('manual run fails fast (target_offline) when the session is offline — no grace park', async () => {
    state.online = new Set() // sess-1 offline
    await sendAgentTask(TASK, ctx({ isManual: true }))
    expect(state.sentFrames).toHaveLength(0)
    const fin = state.finalized.find((f) => f.runId === 'run-1')
    expect(fin!.status).toBe('failed')
    expect(fin!.error).toBe('target_offline')
  })

  test('no session id → failed (no_session_id)', async () => {
    await sendAgentTask(TASK, { runId: 'run-1', taskId: 'task-1', userId: 'user-1', target: {} } as any)
    expect(state.finalized.find((f) => f.runId === 'run-1')?.error).toBe('no_session_id')
  })
})
