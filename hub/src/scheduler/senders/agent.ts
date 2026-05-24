/**
 * Agent sender (W2/T9).
 *
 * Sends a prompt or slash-command to an agent socket via the existing
 * `user_message` path. Persists the message in chat history so it shows
 * up in the UI alongside human-typed prompts. Honors the per-session queue.
 *
 * Finalize path: a hook in `hub/src/ws/agent.ts` calls `onAssistantMessage`
 * here when the next assistant_message lands for the session, finalizing
 * the head-of-queue scheduled run.
 */
import type { ScheduledTask } from '../../db/scheduled-tasks-dal.ts'
import { insertMessage } from '../../db/dal.ts'
import { broadcastToSubscribers } from '../../ws/registry.ts'
import * as queue from '../session-queue.ts'
import { finalizeRun, removeRunContext, getRunContext } from '../dispatcher.ts'

interface PendingTurn {
  runId: string
  taskId: string
  userId: string
  startedAt: number
}
const pendingTurns = new Map<string, PendingTurn[]>()

const TURN_TIMEOUT_MS = 30 * 60 * 1000

interface RunCtxLike {
  runId: string
  taskId: string
  userId: string
  target: { sessionId?: string | null; agentSocket?: any }
}

function buildContent(task: ScheduledTask): string {
  if (task.task_type === 'skill') {
    const cmd = (task.payload as any)?.command || (task.payload as any)?.skill
    if (cmd) return `/${String(cmd).replace(/^\/+/, '')}`
  }
  if (task.task_type === 'security_scan') return '/security-review'
  if (task.task_type === 'continue_dev') {
    return (task.payload as any)?.prompt || 'Continue where you left off.'
  }
  return (task.payload as any)?.prompt || task.prompt || ''
}

export async function sendAgentTask(task: ScheduledTask, ctx: RunCtxLike): Promise<void> {
  const sessionId = ctx.target.sessionId
  if (!sessionId) { await finalizeRun(ctx.runId, 'failed', 'no_session_id'); return }

  const claim = queue.enqueue(sessionId, ctx.runId)
  if (claim === 'dropped') { await finalizeRun(ctx.runId, 'skipped', 'session_busy'); return }
  if (claim === 'queued') return

  const content = buildContent(task)
  if (!content) { await finalizeRun(ctx.runId, 'failed', 'empty_content'); return }

  const storedContent = `[scheduled: ${task.name}]\n\n${content}`
  let msg: { id: string; created_at: string } | null = null
  try {
    msg = await insertMessage(sessionId, 'user', storedContent)
  } catch (err: any) {
    await finalizeRun(ctx.runId, 'failed', `insert_message_failed: ${err?.message}`)
    return
  }

  broadcastToSubscribers(sessionId, {
    type: 'message', session_id: sessionId, message: msg, run_id: ctx.runId,
  })

  const sock = ctx.target.agentSocket
  if (!sock) { await finalizeRun(ctx.runId, 'failed', 'agent_socket_missing'); return }

  try {
    sock.send(JSON.stringify({
      type: 'user_message', id: msg.id, content, ts: msg.created_at, run_id: ctx.runId,
    }))
  } catch (err: any) {
    await finalizeRun(ctx.runId, 'failed', `agent_send_failed: ${err?.message}`)
    return
  }

  const q = pendingTurns.get(sessionId) ?? []
  q.push({ runId: ctx.runId, taskId: ctx.taskId, userId: ctx.userId, startedAt: Date.now() })
  pendingTurns.set(sessionId, q)
}

/**
 * Called by ws/agent.ts when an assistant_message lands. Finalizes the
 * head-of-queue scheduled run. cost_usd is left null (agent stream protocol
 * doesn't carry per-turn cost yet); duration is recorded locally.
 */
export async function onAssistantMessage(sessionId: string, content: string): Promise<void> {
  const q = pendingTurns.get(sessionId)
  if (!q || q.length === 0) return
  const turn = q.shift()!
  if (q.length === 0) pendingTurns.delete(sessionId)
  const duration = Date.now() - turn.startedAt
  const snippet = content.length > 500 ? content.slice(0, 500) + '...' : content
  await finalizeRun(turn.runId, 'success', null, {
    duration_ms: duration, output_snippet: snippet,
  })
  removeRunContext(turn.runId)
}

setInterval(() => {
  const now = Date.now()
  for (const [sid, q] of pendingTurns) {
    while (q.length > 0 && now - q[0].startedAt > TURN_TIMEOUT_MS) {
      const stale = q.shift()!
      void finalizeRun(stale.runId, 'failed', 'turn_timeout')
    }
    if (q.length === 0) pendingTurns.delete(sid)
  }
}, 60_000)

export function _pendingTurns() { return pendingTurns }
export { getRunContext }
