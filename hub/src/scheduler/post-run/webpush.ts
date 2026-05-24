/**
 * Web-push post-run action (W2/T8.6).
 *
 * Broadcasts a `notification` event to all of the user's open browser tabs
 * via the existing broadcastToUser helper. The protocol extension for
 * `notification` as a formally-typed outbound message is queued for W3/T15.
 */
import type { PostRunAction } from './schema.ts'
import { render } from './template.ts'
import { broadcastToUser } from '../../ws/registry.ts'

interface WebPushCtx { userId: string; templateVars: Record<string, unknown> }

export async function executeWebPush(action: PostRunAction, ctx: WebPushCtx): Promise<void> {
  if (action.type !== 'notify_web_push') return
  const title = action.config.title
    ? render(action.config.title, ctx.templateVars)
    : (ctx.templateVars.task_name as string | undefined) || 'Scheduled task'
  const body = render(action.config.body, ctx.templateVars)
  broadcastToUser(ctx.userId, {
    type: 'notification',
    title,
    body,
    run_url: ctx.templateVars.run_url ?? null,
    ts: new Date().toISOString(),
  })
}
