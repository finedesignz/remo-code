/**
 * Milestone once — the `task_type='work'` sender is a THIN ADAPTER over the
 * EXISTING dispatchWork, NOT a re-implementation of the verify/publish flow.
 *
 * Proves:
 *   1. sendWorkTask reconstructs the DispatchWorkInput from work_runs + payload
 *      and calls the SAME `dispatchWork` (whose non-negotiable gate list is
 *      untouched) — the one-time queue entry does not create a second, ungated
 *      path to a repo/site.
 *   2. The scheduled_task_run is finalized on the dispatch OUTCOME (accepted →
 *      success; skipped/failed passed through), while work_runs stays the typed
 *      terminal result. No forked finalize.
 *
 * dispatcher.finalizeRun, the work DAL, and work/dispatch are mocked so no
 * Postgres / live session is needed.
 */
import { describe, test, expect, beforeEach, afterAll, mock } from 'bun:test'

const state = {
  dispatchWorkCalls: [] as any[],
  dispatchOutcome: { kind: 'dispatched' } as any,
  finalized: [] as Array<{ runId: string; status: string; error: string | null }>,
  workRun: null as any,
  site: null as any,
}

mock.module('../src/scheduler/dispatcher.ts', () => ({
  finalizeRun: async (runId: string, status: string, error?: string | null) => {
    state.finalized.push({ runId, status, error: error ?? null })
  },
}))

mock.module('../src/db/work-dal.ts', () => ({
  getWorkRun: async () => state.workRun,
  findWorkSite: async () => state.site,
}))

mock.module('../src/work/dispatch.ts', () => ({
  dispatchWork: async (input: any) => {
    state.dispatchWorkCalls.push(input)
    return state.dispatchOutcome
  },
}))

const { sendWorkTask } = await import('../src/scheduler/senders/work.ts')

const task = (payload: any = {}) => ({
  id: 'task-work-1',
  user_id: 'user-1',
  payload: {
    work_id: 'work-1',
    work_session_id: 'sess-1',
    api_key_id: 'key-1',
    project_dir: '/repos/clientco',
    supervisor_id: 'sup-1',
    repo_ident: 'github://acme/site',
    site_key: 'clientco',
    ...payload,
  },
}) as any

const ctx = { runId: 'run-1', userId: 'user-1' }

beforeEach(() => {
  state.dispatchWorkCalls = []
  state.dispatchOutcome = { kind: 'dispatched' }
  state.finalized = []
  state.workRun = {
    id: 'work-1', user_id: 'user-1', session_id: 'sess-1', api_key_id: 'key-1',
    repo_ident: 'github://acme/site', site_key: 'clientco',
    prompt: 'FULL PROMPT', nonce: 'deadbeef', branch: null,
  }
  state.site = { id: 'site-1', repo_ident: 'github://acme/site', site_key: 'clientco', site_dir: 'sites/clientco', default_branch: 'main' }
})

afterAll(() => mock.restore())

describe('sendWorkTask — thin adapter over dispatchWork', () => {
  test('calls the EXISTING dispatchWork with the reconstructed input', async () => {
    await sendWorkTask(task(), ctx)
    expect(state.dispatchWorkCalls.length).toBe(1)
    const inp = state.dispatchWorkCalls[0]
    expect(inp.workId).toBe('work-1')
    expect(inp.sessionId).toBe('sess-1')
    expect(inp.repoIdent).toBe('github://acme/site')
    expect(inp.nonce).toBe('deadbeef')
    expect(inp.branch).toBe('work/deadbeef') // derived from nonce (work.branch null)
    expect(inp.supervisorId).toBe('sup-1')
    expect(inp.site).toBe(state.site)
  })

  test('accepted dispatch (dispatched/queued) → scheduled run finalized success', async () => {
    state.dispatchOutcome = { kind: 'queued' }
    await sendWorkTask(task(), ctx)
    expect(state.finalized).toEqual([{ runId: 'run-1', status: 'success', error: null }])
  })

  test('skipped dispatch → run finalized skipped WITH the reason (caps/gates surfaced)', async () => {
    state.dispatchOutcome = { kind: 'skipped', reason: 'over_work_rate' }
    await sendWorkTask(task(), ctx)
    expect(state.finalized).toEqual([{ runId: 'run-1', status: 'skipped', error: 'over_work_rate' }])
  })

  test('failed dispatch → run finalized failed WITH the reason', async () => {
    state.dispatchOutcome = { kind: 'failed', reason: 'agent_send_failed' }
    await sendWorkTask(task(), ctx)
    expect(state.finalized).toEqual([{ runId: 'run-1', status: 'failed', error: 'agent_send_failed' }])
  })

  test('missing work_id → fails the run, never calls dispatchWork', async () => {
    await sendWorkTask(task({ work_id: undefined }), ctx)
    expect(state.dispatchWorkCalls.length).toBe(0)
    expect(state.finalized[0].status).toBe('failed')
    expect(state.finalized[0].error).toBe('work_payload_missing_work_id')
  })
})
