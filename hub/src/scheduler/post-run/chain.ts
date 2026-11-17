/**
 * chain_task executor (W2/T8.6).
 *
 * Dispatches another scheduled_tasks row by id. Honors chain depth via the
 * dispatcher's runtime cap; the post-run dispatcher already checks
 * `chainDepth >= MAX_CHAIN_DEPTH` before calling here, but we increment
 * before re-dispatch as a defense-in-depth.
 */
import type { PostRunAction } from './schema.ts'
import { nextStepInWorkflow, workflowRootForStep } from '../workflows.ts'
import type { TaskType } from '../../db/scheduled-tasks-dal.ts'
import { log } from '../../observability/logger'

interface ChainCtx {
  parentRunId: string
  userId: string
  chainDepth: number
  /**
   * Phase 11: optional parent task_kind. When provided, chain edges with an
   * explicit `task_id` are validated against the canonical workflow ordering
   * (`hub/src/scheduler/workflows.ts`). Mismatches are logged but NOT blocked
   * — chain_task edges remain authoritative; the workflow table is advisory.
   */
  parentTaskKind?: TaskType
}

export async function executeChain(action: PostRunAction, ctx: ChainCtx): Promise<void> {
  if (action.type !== 'chain_task') return
  const childId = action.config.task_id
  if (!childId) return

  // PTYCAP-08 (F1-A2, T-08-10): task_qc is terminal. It never chains onward, and no chain
  // edge may start it, even if a stored chain_task row points at it.
  if (ctx.parentTaskKind === 'task_qc') {
    log.info('scheduler.chain.task_qc_parent_refused', { parent_run_id: ctx.parentRunId, child_task_id: childId })
    return
  }
  const { getTaskById } = await import('../../db/scheduled-tasks-dal.ts')
  const child = await getTaskById(childId)
  if (child?.task_type === 'task_qc') {
    log.info('scheduler.chain.task_qc_child_refused', { parent_run_id: ctx.parentRunId, child_task_id: childId })
    return
  }

  // Workflow-aware audit log: if parent is a known chained step, surface the
  // expected next step kind so downstream tooling can detect mis-wired chains.
  if (ctx.parentTaskKind) {
    const expected = nextStepInWorkflow(ctx.parentTaskKind)
    const root = workflowRootForStep(ctx.parentTaskKind)
    if (root && expected) {
      // Pure log; do not block.
      // eslint-disable-next-line no-console
      console.log(
        `[chain] workflow=${root} parent=${ctx.parentTaskKind} expected_next=${expected} child_task=${childId}`,
      )
    }
  }

  const { runNow } = await import('../dispatcher.ts')
  await runNow(childId, ctx.userId, {
    triggeredByRunId: ctx.parentRunId,
    chainDepth: ctx.chainDepth + 1,
  })
}

// Re-export for callers that want to validate/auto-wire workflow chains.
export { nextStepInWorkflow, workflowRootForStep }
