/**
 * chain_task executor (W2/T8.6).
 *
 * Dispatches another scheduled_tasks row by id. Honors chain depth via the
 * dispatcher's runtime cap; the post-run dispatcher already checks
 * `chainDepth >= MAX_CHAIN_DEPTH` before calling here, but we increment
 * before re-dispatch as a defense-in-depth.
 */
import type { PostRunAction } from './schema.ts'

interface ChainCtx { parentRunId: string; userId: string; chainDepth: number }

export async function executeChain(action: PostRunAction, ctx: ChainCtx): Promise<void> {
  if (action.type !== 'chain_task') return
  const childId = action.config.task_id
  if (!childId) return
  const { runNow } = await import('../dispatcher.ts')
  await runNow(childId, ctx.userId, {
    triggeredByRunId: ctx.parentRunId,
    chainDepth: ctx.chainDepth + 1,
  })
}
