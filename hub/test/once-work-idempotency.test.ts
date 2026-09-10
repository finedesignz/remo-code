/**
 * Milestone once — dispatchWork is idempotent per work_id (double-fire defence).
 *
 * Belt-and-braces to the once-task claim: even if a second dispatchWork is
 * invoked for the same work_id (a re-armed once row that slips through, a raced
 * replay, anything), it must be a NO-OP — never re-run the gate list, never
 * re-send to the agent, never touch a live client site twice.
 *
 * The guard reads the work_runs status: `queued` proceeds; anything past it
 * (`dispatched` / verifying / terminal) short-circuits to skipped. A
 * parked-offline item stays `queued`, so a legitimate grace replay is NOT
 * blocked. The shared dispatch pipeline is mocked so the test observes exactly
 * whether it was entered.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-chars-long-aaaaaaaa'

import { describe, test, expect, beforeEach, afterAll, mock } from 'bun:test'

const state = {
  status: 'queued' as string,
  dispatchCalls: 0,
}

// The work_runs status drives the guard. Everything else the sender/pipeline
// might touch is a no-op — the test only cares whether dispatch() is entered.
mock.module('../src/db/work-dal.ts', () => ({
  getWorkRun: async () => ({ id: 'work-1', user_id: 'u1', status: state.status, session_id: 's1' }),
  finalizeWork: async () => {},
  markWorkDispatched: async () => {},
  markWorkVerifying: async () => {},
}))

// The shared dispatch pipeline — a spy. If the guard works, a non-queued work
// item never reaches here.
mock.module('../src/dispatch/pipeline.ts', () => ({
  dispatch: async () => { state.dispatchCalls++; return { kind: 'dispatched' } },
  onSessionReply: async () => {},
}))

const { dispatchWork } = await import('../src/work/dispatch.ts')

const input = {
  workId: 'work-1', userId: 'u1', apiKeyId: null, sessionId: 's1',
  repoIdent: 'github://acme/site', nonce: 'deadbeef', prompt: 'p',
  site: { id: 'site-1', site_dir: 'sites/clientco', default_branch: 'main' } as any,
  projectDir: '/repos/clientco', supervisorId: 'sup-1', branch: 'work/deadbeef',
}

beforeEach(() => { state.status = 'queued'; state.dispatchCalls = 0 })
afterAll(() => mock.restore())

describe('dispatchWork idempotency guard', () => {
  test('a queued work item DOES enter the dispatch pipeline (happy path)', async () => {
    state.status = 'queued'
    const out = await dispatchWork(input)
    expect(state.dispatchCalls).toBe(1)
    expect(out.kind).toBe('dispatched')
  })

  test('an already-dispatched work item is a NO-OP (skipped, pipeline never entered)', async () => {
    state.status = 'dispatched'
    const out = await dispatchWork(input)
    expect(state.dispatchCalls).toBe(0)
    expect(out).toEqual({ kind: 'skipped', reason: 'already_dispatched' })
  })

  test('a terminal (completed) work item is a NO-OP too', async () => {
    state.status = 'completed'
    const out = await dispatchWork(input)
    expect(state.dispatchCalls).toBe(0)
    expect(out).toEqual({ kind: 'skipped', reason: 'already_dispatched' })
  })

  test('called TWICE for the same work_id → exactly ONE dispatch (2nd sees dispatched → no-op)', async () => {
    state.status = 'queued'
    const first = await dispatchWork(input)
    expect(first.kind).toBe('dispatched')
    // The real pipeline would flip queued→dispatched via store.markDispatched;
    // simulate that transition before the second call.
    state.status = 'dispatched'
    const second = await dispatchWork(input)
    expect(second).toEqual({ kind: 'skipped', reason: 'already_dispatched' })
    expect(state.dispatchCalls).toBe(1) // ONE dispatch total
  })
})
