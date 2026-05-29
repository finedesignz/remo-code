/**
 * Error-capture dispatch adapter tests (Round-2 migration).
 *
 * Proves the error-capture adapter drives the shared dispatch pipeline end to
 * end — the lifecycle the BLOCKER review found silently dropped (open() was
 * never called, so error_runs were never inserted/finalized):
 *
 *   1. A dispatched error INSERTs an error_run (in_flight) via open(), broadcasts
 *      error_dispatched with the REAL run id, and sets dispatch_status='dispatched'.
 *   2. onSessionReply (the agent assistant_message bridge) finalizes that run to
 *      'success' with the real run id + broadcasts error_run_finished.
 *
 * DAL + postgres `sql` + ws registry + dal.insertMessage + notify are mocked so
 * no Postgres / no live WS is needed. The dispatch pipeline + gates are mocked
 * to pass-through (the gate SQL is covered elsewhere); we are testing the
 * ADAPTER↔PIPELINE wiring, specifically the open()→finalize run lifecycle.
 */
import { describe, test, expect, beforeEach, afterAll, mock } from 'bun:test'

// Cache-bust real modules so partial mocks don't strip sibling exports.
const realDal = await import(`../src/db/dal.ts?bust=${Date.now()}`)
const realEcDal = await import(`../src/db/error-capture-dal.ts?bust=${Date.now()}`)

const PROJECT = {
  id: 'proj-1',
  user_id: 'user-1',
  name: 'demo-app',
  sentry_key: 'sk_demo',
  session_id: 'sess-1',
  dedupe_window_seconds: 60,
  rate_limit_per_hour: 20,
  daily_dispatch_cap: 50,
  enabled: true,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
}

const ERROR_ROW = {
  id: 'err-1',
  project_id: 'proj-1',
  fingerprint: 'fp-1',
  error_type: 'TypeError',
  error_value: 'x is not a function',
  stacktrace_json: [],
  release: null,
  received_at: new Date().toISOString(),
  dispatch_status: 'pending',
  dispatched_at: null,
  skip_reason: null,
}

const state: {
  runs: Array<{ id: string; error_id: string; project_id: string; session_id: string; status: string; output_snippet?: string | null; error?: string | null }>
  dispatchStatus: Array<[string, string, string | undefined]>
  broadcasts: any[]
  sentFrames: any[]
} = { runs: [], dispatchStatus: [], broadcasts: [], sentFrames: [] }

let runSeq = 0

// errors SELECT then error_projects SELECT (in dispatchPendingError order).
mock.module('../src/db/postgres.ts', () => ({
  sql: async () => {
    // Discriminate by call order: 1st = errors row, 2nd = project row.
    // bun's tagged-template mock receives (strings, ...values); we ignore args
    // and return by a small state machine.
    sqlCall++
    if (sqlCall === 1) return [ERROR_ROW]
    if (sqlCall === 2) return [PROJECT]
    return []
  },
}))
let sqlCall = 0

mock.module('../src/db/error-capture-dal.ts', () => ({
  ...realEcDal,
  insertErrorRun: async (errorId: string, projectId: string, sessionId: string) => {
    runSeq++
    const run = { id: `run-${runSeq}`, error_id: errorId, project_id: projectId, session_id: sessionId, status: 'pending' }
    state.runs.push(run)
    return run
  },
  updateErrorRunStatus: async (runId: string, fields: any) => {
    const run = state.runs.find((r) => r.id === runId)
    if (run) Object.assign(run, fields)
    return run ?? null
  },
  updateErrorDispatchStatus: async (id: string, status: string, reason?: string) => {
    state.dispatchStatus.push([id, status, reason])
  },
}))

mock.module('../src/db/dal.ts', () => ({
  ...realDal,
  insertMessage: async (_sessionId: string, _role: string, _content: string) => ({
    id: 'msg-1',
    created_at: new Date().toISOString(),
  }),
}))

mock.module('../src/ws/registry.ts', () => ({
  getChannel: (_sessionId: string) => ({ ws: { send: (f: string) => state.sentFrames.push(JSON.parse(f)) } }),
  broadcastErrorEvent: (_userId: string, event: any) => state.broadcasts.push(event),
}))

mock.module('../src/error-capture/notify.ts', () => ({
  notifyThrottled: async () => {},
}))

// Pass-through gates so we exercise the dispatch path (gate SQL covered in
// dispatch-pipeline.test.ts / gates unit tests).
mock.module('../src/dispatch/gates.ts', () => ({
  thresholdGate: { name: 'threshold', async check() { return { ok: true } } },
  dailyCostCapGate: { name: 'daily_cost_cap', async check() { return { ok: true } } },
}))

// Import AFTER mocks. Pipeline is REAL — that's the wiring under test.
const { dispatchPendingError } = await import('../src/error-capture/dispatcher.ts')
const { onSessionReply, _reset } = await import('../src/dispatch/pipeline.ts')

beforeEach(() => {
  state.runs = []
  state.dispatchStatus = []
  state.broadcasts = []
  state.sentFrames = []
  runSeq = 0
  sqlCall = 0
  _reset()
})

describe('error-capture dispatch adapter — open()→finalize lifecycle', () => {
  afterAll(() => mock.restore())

  test('dispatched error inserts error_run, broadcasts error_dispatched with real run id, then finalizes on reply', async () => {
    const out = await dispatchPendingError('err-1')

    // 1. open() ran → exactly one error_run, marked in_flight then it stays
    //    until finalize. The dispatched outcome carries the REAL run id.
    expect(state.runs).toHaveLength(1)
    const run = state.runs[0]
    expect(run.id).toBe('run-1')
    expect(run.error_id).toBe('err-1')
    expect(out).toEqual({ status: 'dispatched', run_id: 'run-1' })

    // dispatch_status set to 'dispatched' after a successful send.
    expect(state.dispatchStatus).toContainEqual(['err-1', 'dispatched', undefined])

    // user_message frame was sent on the agent socket with the bare prompt.
    expect(state.sentFrames).toHaveLength(1)
    expect(state.sentFrames[0].type).toBe('user_message')

    // error_dispatched broadcast carries the real run id (NOT null, NOT errorId).
    const dispatched = state.broadcasts.find((b) => b.type === 'error_dispatched')
    expect(dispatched).toBeTruthy()
    expect(dispatched.run_id).toBe('run-1')

    // 2. The agent replies → onSessionReply finalizes the run to success.
    await onSessionReply('sess-1', 'I fixed it and pushed.')

    expect(run.status).toBe('success')
    expect(run.output_snippet).toBe('I fixed it and pushed.')

    const finished = state.broadcasts.find((b) => b.type === 'error_run_finished')
    expect(finished).toBeTruthy()
    expect(finished.run_id).toBe('run-1')
    expect(finished.status).toBe('success')
    expect(finished.output_snippet).toBe('I fixed it and pushed.')
  })
})
