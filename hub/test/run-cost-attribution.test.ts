/**
 * fix/run-cost-attribution — `scheduled_task_runs.cost_usd` was NULL on 100%
 * of 493 historical rows (verified against prod). Root cause: no caller of
 * `finalizeRun` ever supplied `fields.cost_usd`. Real per-turn cost is only
 * known from the supervisor's `usage_event` WS messages (recorded into
 * `token_usage` for the daily cap, keyed by sessionId — no run linkage).
 *
 * Fix: `accrueRunCost(sessionId, costUsd)` — called from the agent ws
 * `usage_event` handler with the SAME cost it just persisted into
 * `token_usage` — sums cost onto every in-flight `RunContext` targeting that
 * session; `finalizeRun` now defaults `cost_usd` to that accrual when the
 * caller doesn't pass one explicitly.
 *
 * This test proves: (1) a finalized session-targeted run gets the accrued
 * cost written, summed across multiple usage_events in one turn: (2) a run
 * with no accrual (e.g. a non-LLM sender) still finalizes with cost_usd=null,
 * not a misleading 0; (3) accrual only attaches to runs targeting the SAME
 * session, so it can never leak onto an unrelated concurrent run.
 *
 * Bun mock.module hygiene (feedback_bun_mock_pollution): cache-bust real
 * modules, afterAll(mock.restore).
 */
import { describe, test, expect, afterAll, mock } from 'bun:test'

const updateCalls: Array<{ runId: string; fields: any }> = []

const realStDal = await import(`../src/db/scheduled-tasks-dal.ts?bust=${Date.now()}`)
mock.module('../src/db/scheduled-tasks-dal.ts', () => ({
  ...realStDal,
  updateRunStatus: async (runId: string, fields: any) => {
    updateCalls.push({ runId, fields })
    return { id: runId, user_id: 'user-1', task_id: 'task-1', ...fields }
  },
  getTaskById: async () => null, // no task row → onRunFinalized/post-run skipped
}))
const realRegistry = await import(`../src/ws/registry.ts?bust=${Date.now()}`)
mock.module('../src/ws/registry.ts', () => ({
  ...realRegistry,
  broadcastScheduledRun: () => {},
  broadcastToUser: () => {},
}))

const { trackRun, finalizeRun, accrueRunCost } = await import(
  `../src/scheduler/dispatcher.ts?bust=${Date.now()}`
)

describe('accrueRunCost + finalizeRun — per-run cost attribution', () => {
  afterAll(() => mock.restore())

  test('sums multiple usage_events onto the in-flight run and writes cost_usd at finalize', async () => {
    const runId = 'run-cost-1'
    trackRun({
      runId,
      taskId: 'task-1',
      userId: 'user-1',
      target: { kind: 'session', sessionId: 'sess-A', online: true } as any,
      startedAt: Date.now(),
      chainDepth: 0,
    })

    // Simulates two usage_event messages landing on the agent socket for
    // sess-A while the run is in flight (a turn with a tool-use round trip).
    accrueRunCost('sess-A', 0.0123)
    accrueRunCost('sess-A', 0.0045)

    await finalizeRun(runId, 'success', null, { duration_ms: 1000, output_snippet: 'ok' })

    const call = updateCalls.find((c) => c.runId === runId)
    expect(call).toBeDefined()
    expect(call!.fields.cost_usd).toBeCloseTo(0.0168, 6)
  })

  test('a run with no accrued cost finalizes with cost_usd=null, not 0', async () => {
    const runId = 'run-cost-2'
    trackRun({
      runId,
      taskId: 'task-1',
      userId: 'user-1',
      target: { kind: 'supervisor', online: true } as any, // e.g. coolify log_check — no CLI turn
      startedAt: Date.now(),
      chainDepth: 0,
    })

    await finalizeRun(runId, 'success', null, { duration_ms: 500 })

    const call = updateCalls.find((c) => c.runId === runId)
    expect(call).toBeDefined()
    expect(call!.fields.cost_usd).toBeNull()
  })

  test('accrual for one session never attaches to a concurrent run on a different session', async () => {
    const runA = 'run-cost-3a'
    const runB = 'run-cost-3b'
    trackRun({
      runId: runA,
      taskId: 'task-1',
      userId: 'user-1',
      target: { kind: 'session', sessionId: 'sess-B', online: true } as any,
      startedAt: Date.now(),
      chainDepth: 0,
    })
    trackRun({
      runId: runB,
      taskId: 'task-1',
      userId: 'user-1',
      target: { kind: 'session', sessionId: 'sess-C', online: true } as any,
      startedAt: Date.now(),
      chainDepth: 0,
    })

    accrueRunCost('sess-B', 0.05)

    await finalizeRun(runA, 'success', null, {})
    await finalizeRun(runB, 'success', null, {})

    const callA = updateCalls.find((c) => c.runId === runA)
    const callB = updateCalls.find((c) => c.runId === runB)
    expect(callA!.fields.cost_usd).toBeCloseTo(0.05, 6)
    expect(callB!.fields.cost_usd).toBeNull()
  })

  test('an explicit fields.cost_usd always wins over any accrual', async () => {
    const runId = 'run-cost-4'
    trackRun({
      runId,
      taskId: 'task-1',
      userId: 'user-1',
      target: { kind: 'session', sessionId: 'sess-D', online: true } as any,
      startedAt: Date.now(),
      chainDepth: 0,
    })
    accrueRunCost('sess-D', 0.9)

    await finalizeRun(runId, 'success', null, { cost_usd: 0.001 })

    const call = updateCalls.find((c) => c.runId === runId)
    expect(call!.fields.cost_usd).toBeCloseTo(0.001, 6)
  })
})
