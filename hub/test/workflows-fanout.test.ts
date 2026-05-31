/**
 * Workflow fan-out click-path smoke (Phase 11 cleanup).
 *
 * Integration-level test that walks the canonical `dev` workflow chain end
 * to end via `executeChain`:
 *
 *   dev_plan  (run finishes) → chain_task → dev_execute
 *   dev_execute (run finishes) → chain_task → dev_ship
 *   dev_ship (run finishes) → NO further chain (terminal)
 *
 * The real `dispatcher.runNow` requires Postgres + WS registries. We stub
 * it via `mock.module` and capture the (childId, parentRunId, chainDepth)
 * triple for each chain edge. The actual workflow ordering invariant comes
 * from `hub/src/scheduler/workflows.ts` and is asserted independently.
 */
import { describe, test, expect, mock } from 'bun:test'

import { WORKFLOWS, nextStepInWorkflow } from '../src/scheduler/workflows.ts'

describe('scheduler/workflows — dev workflow fan-out smoke', () => {
  test('dev_plan → dev_execute → dev_ship chains, then terminates', async () => {
    // Capture every runNow invocation in order.
    const calls: Array<{
      taskId: string
      userId: string
      triggeredByRunId: string | null
      chainDepth: number
    }> = []

    mock.module('../src/scheduler/dispatcher.ts', () => ({
      runNow: async (
        taskId: string,
        userId: string,
        opts: { triggeredByRunId?: string | null; chainDepth?: number } = {},
      ) => {
        calls.push({
          taskId,
          userId,
          triggeredByRunId: opts.triggeredByRunId ?? null,
          chainDepth: opts.chainDepth ?? 0,
        })
        return { runIds: [`run_${taskId}`] }
      },
    }))

    const { executeChain } = await import('../src/scheduler/post-run/chain.ts')

    // Edge 1: dev_plan run finished, post-run chain_task → dev_execute task id.
    await executeChain(
      { type: 'chain_task', on: 'success', config: { task_id: 'task_dev_execute' } } as any,
      {
        parentRunId: 'run_dev_plan_1',
        userId: 'u1',
        chainDepth: 0,
        parentTaskKind: 'dev_plan',
      },
    )

    // Edge 2: dev_execute run finished → chain_task → dev_ship.
    await executeChain(
      { type: 'chain_task', on: 'success', config: { task_id: 'task_dev_ship' } } as any,
      {
        parentRunId: 'run_dev_execute_1',
        userId: 'u1',
        chainDepth: 1,
        parentTaskKind: 'dev_execute',
      },
    )

    // Edge 3: dev_ship is terminal — the chain config carries no task_id, so
    // executeChain bails (mirroring the dispatcher.afterRun behaviour for a
    // terminal step row that intentionally has no chain_task post-run action).
    await executeChain(
      { type: 'chain_task', on: 'success', config: { task_id: '' } } as any,
      {
        parentRunId: 'run_dev_ship_1',
        userId: 'u1',
        chainDepth: 2,
        parentTaskKind: 'dev_ship',
      },
    )

    expect(calls).toHaveLength(2)
    expect(calls[0]).toEqual({
      taskId: 'task_dev_execute',
      userId: 'u1',
      triggeredByRunId: 'run_dev_plan_1',
      chainDepth: 1,
    })
    expect(calls[1]).toEqual({
      taskId: 'task_dev_ship',
      userId: 'u1',
      triggeredByRunId: 'run_dev_execute_1',
      chainDepth: 2,
    })

    // Workflow ordering invariant: dev_controller → dev_plan → dev_execute → dev_ship → null.
    expect(WORKFLOWS.dev).toEqual(['dev_controller', 'dev_plan', 'dev_execute', 'dev_ship'])
    expect(nextStepInWorkflow('dev_controller')).toBe('dev_plan')
    expect(nextStepInWorkflow('dev_plan')).toBe('dev_execute')
    expect(nextStepInWorkflow('dev_execute')).toBe('dev_ship')
    expect(nextStepInWorkflow('dev_ship')).toBe(null)
  })

  test('security workflow has the same 3-step shape', () => {
    expect(WORKFLOWS.security).toEqual([
      'security_scan',
      'security_triage',
      'security_fix_or_issue',
    ])
    expect(nextStepInWorkflow('security_scan')).toBe('security_triage')
    expect(nextStepInWorkflow('security_triage')).toBe('security_fix_or_issue')
    expect(nextStepInWorkflow('security_fix_or_issue')).toBe(null)
  })

  test('log_check workflow has the same 3-step shape', () => {
    expect(WORKFLOWS.log_check).toEqual(['log_pull', 'log_classify', 'log_triage'])
    expect(nextStepInWorkflow('log_pull')).toBe('log_classify')
    expect(nextStepInWorkflow('log_classify')).toBe('log_triage')
    expect(nextStepInWorkflow('log_triage')).toBe(null)
  })

  test('chain_task with empty task_id is a no-op (terminal-step shape)', async () => {
    const seen: string[] = []
    mock.module('../src/scheduler/dispatcher.ts', () => ({
      runNow: async (taskId: string) => {
        seen.push(taskId)
        return { runIds: [] }
      },
    }))
    const { executeChain } = await import('../src/scheduler/post-run/chain.ts')

    await executeChain(
      { type: 'chain_task', on: 'success', config: { task_id: '' } } as any,
      { parentRunId: 'r1', userId: 'u1', chainDepth: 0, parentTaskKind: 'dev_ship' },
    )
    expect(seen).toEqual([])
  })
})
