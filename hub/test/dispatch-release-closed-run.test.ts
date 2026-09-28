/**
 * fix/stuck-busy-slot — a run closed out somewhere else (reaper, dead session,
 * wedged lock) must release the dispatch-pipeline slot it held, and the
 * queued waiters behind it must be re-dispatched, never dropped.
 *
 * Before: the scheduler run-reaper finalized the row but left the finalize hook
 * armed + the queue slot claimed; the stale-lock reaper's `queue.abandon()`
 * deleted the slot INCLUDING its waiters. Either way the session stayed "busy"
 * until a hub restart. DB-free.
 */
import { describe, test, expect, beforeEach } from 'bun:test'

import {
  dispatch,
  getQueue,
  releaseClosedRun,
  releaseClosedRunByToken,
  _reset as resetPipeline,
  type DispatchRequest,
  type PipelineDeps,
} from '../src/dispatch/pipeline.ts'
import { reapStaleRuns } from '../src/scheduler/run-reaper.ts'
import { reapStaleOrchestratorLocks, STALE_LOCK_MS, _resetReapNotifyCooldown } from '../src/orchestrator/stale-lock-reaper.ts'

function req(token: string, sessionId = 's1'): DispatchRequest {
  return { userId: 'u1', sessionId, token, prompt: `p-${token}` }
}

function makeDeps() {
  const sent: string[] = []
  const failed: Array<{ token: string; error: string }> = []
  const deps: PipelineDeps = {
    gates: [],
    store: {
      markSkipped: async () => {},
      markFailed: async (token, error) => {
        failed.push({ token, error })
      },
      onFinalize: async () => {},
    },
    replay: async () => {},
    isOnline: () => true,
    send: async (r) => {
      sent.push(r.token)
    },
  }
  return { deps, sent, failed }
}

beforeEach(() => {
  resetPipeline()
  _resetReapNotifyCooldown()
})

describe('releaseClosedRun', () => {
  test('frees the slot, marks the run failed, and dispatches the next waiter', async () => {
    const { deps, sent, failed } = makeDeps()
    expect((await dispatch(req('a'), deps)).kind).toBe('dispatched')
    expect((await dispatch(req('b'), deps)).kind).toBe('queued')
    expect(sent).toEqual(['a'])

    expect(await releaseClosedRun('s1', 'session_process_exited')).toBe(true)

    expect(failed).toEqual([{ token: 'a', error: 'session_process_exited' }])
    expect(sent).toEqual(['a', 'b']) // waiter re-dispatched, not dropped
    expect(getQueue().currentInFlight('s1')).toBe('b')
  })

  test('markFailed:false leaves an already-finalized row alone', async () => {
    const { deps, failed } = makeDeps()
    await dispatch(req('a'), deps)
    expect(await releaseClosedRun('s1', 'run_timeout', { markFailed: false })).toBe(true)
    expect(failed).toEqual([])
    expect(getQueue().currentInFlight('s1')).toBe(null)
  })

  test('a token that is no longer in flight never releases a newer run', async () => {
    const { deps, sent } = makeDeps()
    await dispatch(req('new'), deps)
    expect(await releaseClosedRun('s1', 'run_timeout', { token: 'old' })).toBe(false)
    expect(getQueue().currentInFlight('s1')).toBe('new')
    expect(sent).toEqual(['new'])
  })

  test('no slot held → no-op', async () => {
    expect(await releaseClosedRun('nobody', 'x')).toBe(false)
  })

  test('releaseClosedRunByToken finds the session by run id', async () => {
    const { deps, sent } = makeDeps()
    await dispatch(req('run-1', 'sA'), deps)
    await dispatch(req('run-2', 'sA'), deps)
    expect(await releaseClosedRunByToken('run-1', 'run_timeout', { markFailed: false })).toBe(true)
    expect(sent).toEqual(['run-1', 'run-2'])
    expect(await releaseClosedRunByToken('missing', 'run_timeout')).toBe(false)
  })
})

describe('scheduler run-reaper releases the slot of the run it finalizes', () => {
  test('reaped run → releaseSlot(runId) called; fresh run untouched', async () => {
    const released: string[] = []
    const now = Date.now()
    const reaped = await reapStaleRuns(now, {
      loadPendingRuns: async () => [
        { id: 'stale', started_at_ms: now - 7 * 3_600_000, task_type: 'agent' },
        { id: 'fresh', started_at_ms: now - 60_000, task_type: 'agent' },
      ],
      finalizeRun: (async () => {}) as any,
      releaseSlot: async (runId) => {
        released.push(runId)
      },
    })
    expect(reaped).toEqual(['stale'])
    expect(released).toEqual(['stale'])
  })

  test('end-to-end: the real release frees the pipeline slot for the reaped run', async () => {
    const { deps, sent } = makeDeps()
    await dispatch(req('stale-run', 'sched-s'), deps)
    await dispatch(req('next-run', 'sched-s'), deps)
    const now = Date.now()
    await reapStaleRuns(now, {
      loadPendingRuns: async () => [{ id: 'stale-run', started_at_ms: now - 7 * 3_600_000, task_type: 'agent' }],
      finalizeRun: (async () => {}) as any,
    })
    expect(sent).toEqual(['stale-run', 'next-run'])
    expect(getQueue().currentInFlight('sched-s')).toBe('next-run')
  })
})

describe('stale-lock reaper keeps waiters', () => {
  test('wedged pipeline lock → released through the pipeline, waiter dispatched', async () => {
    const { deps, sent } = makeDeps()
    await dispatch(req('wedged', 'orch-s'), deps)
    await dispatch(req('waiting', 'orch-s'), deps)
    const reaped = await reapStaleOrchestratorLocks(Date.now() + STALE_LOCK_MS + 1, {
      loadTasks: async () => [{ id: 't', session_id: 'orch-s', user_id: 'u1', timezone: 'UTC' }],
      appendRunLog: (async () => ({})) as any,
      fanOut: (async () => ({ delivered: [] })) as any,
    })
    expect(reaped).toEqual(['orch-s'])
    expect(sent).toEqual(['wedged', 'waiting']) // old abandon() dropped 'waiting'
    expect(getQueue().currentInFlight('orch-s')).toBe('waiting')
  })
})
