/**
 * fix/sched-qc — stale scheduled-run reaper.
 *
 * Prod bug: `scheduled_task_runs` rows dispatched to a session whose CLI turn
 * never completed sat `pending` forever (rows from 2026-07-08). The reaper
 * finalizes any pending run older than REMO_RUN_MAX_MS (default 6h) as
 * failed/run_timeout via the shared finalizeRun, and MUST NOT touch a fresh run
 * or double-finalize one another poller (e.g. TEAB) already owns.
 */
import { describe, test, expect } from 'bun:test'
import { reapStaleRuns, RUN_MAX_MS } from '../src/scheduler/run-reaper.ts'

const NOW = 1_800_000_000_000

describe('reapStaleRuns', () => {
  test('finalizes an old pending run as failed/run_timeout (claim-guarded)', async () => {
    const calls: any[] = []
    const reaped = await reapStaleRuns(NOW, {
      loadPendingRuns: async () => [{ id: 'old', started_at_ms: NOW - RUN_MAX_MS - 1000 }],
      finalizeRun: (async (...args: any[]) => { calls.push(args) }) as any,
    })

    expect(reaped).toEqual(['old'])
    expect(calls).toHaveLength(1)
    expect(calls[0][0]).toBe('old')
    expect(calls[0][1]).toBe('failed')
    expect(calls[0][2]).toBe('run_timeout')
    // Idempotency: must claim-then-finalize so a run another poller owns is a no-op.
    expect(calls[0][3]).toEqual({ only_if_pending: true })
  })

  test('leaves a fresh pending run alone', async () => {
    const calls: any[] = []
    const reaped = await reapStaleRuns(NOW, {
      loadPendingRuns: async () => [{ id: 'fresh', started_at_ms: NOW - 60_000 }],
      finalizeRun: (async (...args: any[]) => { calls.push(args) }) as any,
    })
    expect(reaped).toEqual([])
    expect(calls).toHaveLength(0)
  })

  test('never sees already-finalized runs (loader selects status=pending only)', async () => {
    // The loader is the filter: a finalized run is simply absent from the sweep.
    const calls: any[] = []
    const reaped = await reapStaleRuns(NOW, {
      loadPendingRuns: async () => [],
      finalizeRun: (async (...args: any[]) => { calls.push(args) }) as any,
    })
    expect(reaped).toEqual([])
    expect(calls).toHaveLength(0)
  })

  test('one failing run never aborts the pass', async () => {
    const seen: string[] = []
    const reaped = await reapStaleRuns(NOW, {
      loadPendingRuns: async () => [
        { id: 'boom', started_at_ms: NOW - RUN_MAX_MS - 1 },
        { id: 'ok', started_at_ms: NOW - RUN_MAX_MS - 1 },
      ],
      finalizeRun: (async (runId: string) => {
        seen.push(runId)
        if (runId === 'boom') throw new Error('db down')
      }) as any,
    })
    expect(seen).toEqual(['boom', 'ok'])
    expect(reaped).toEqual(['ok'])
  })

  test('a load failure is fail-open (empty sweep, no throw)', async () => {
    const reaped = await reapStaleRuns(NOW, {
      loadPendingRuns: async () => { throw new Error('db down') },
      finalizeRun: (async () => {}) as any,
    })
    expect(reaped).toEqual([])
  })
})
