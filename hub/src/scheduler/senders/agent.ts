/**
 * Agent sender (W2/T9) — Round-2 migration: now an adapter over the shared
 * session-dispatch pipeline `hub/src/dispatch/`.
 *
 * Previously this module hand-rolled: per-session queue claim → runtime-context
 * snapshot → agent-socket send → a local `pendingTurns` map finalized by a hook
 * in `hub/src/ws/agent.ts` (`onAssistantMessage`). All of that machinery now
 * lives behind `dispatch()` in `hub/src/dispatch/pipeline.ts`. This file is the
 * thin scheduler adapter for SESSION-targeted runs: it builds the prompt +
 * runtime context, a `RunStore` that finalizes the already-inserted
 * `scheduled_task_runs` row (via the dispatcher's `finalizeRun`, which fires the
 * post-run action pipeline), sets the gate list (threshold → cost-cap — the
 * promotion re-check, IR-2), provides the offline `replay`/`onParkExpire`
 * thunks, and applies the Summary directive + `## RUNTIME CONTEXT` block to the
 * SENT string ONLY (never to stored `messages` / the snapshot).
 *
 * Finalize is no longer wired here: the agent ws assistant_message branch calls
 * `dispatch.onSessionReply(sessionId, content)`, which fires `RunStore.onFinalize`
 * for the in-flight scheduled run and promotes/re-dispatches any queued run
 * through the full gate list again (so a user who crossed the cap while queued
 * is skipped — IR-2). `onFinalize` carries the exact legacy
 * `onAssistantMessage` behaviour: `finalizeRun(success, …)` which triggers the
 * post-run action pipeline (chain/email/telegram/webhook/github-issue).
 *
 * Scope: ONLY the session send→queue→grace→finalize path moved. Cron, fan-out,
 * cost-cap audit rows, target resolution, supervisor/coolify senders, triage
 * routing, the Summary directive, and Phase-11 workflows all stay in
 * `dispatcher.ts` / their own modules.
 */
import type { ScheduledTask } from '../../db/scheduled-tasks-dal.ts'
import { insertMessage } from '../../db/dal.ts'
import { sql } from '../../db/postgres.ts'
import { getChannel, broadcastToSubscribers } from '../../ws/registry.ts'
import { finalizeRun, removeRunContext, getRunContext } from '../dispatcher.ts'
import { buildRuntimeContext, renderRuntimeContextBlock, type RuntimeContext } from '../context/runtime-context.ts'
import {
  dispatch,
  type DispatchRequest,
  type PipelineDeps,
  type RunStore,
} from '../../dispatch/pipeline.ts'
import { thresholdGate, dailyCostCapGate } from '../../dispatch/gates.ts'

interface RunCtxLike {
  runId: string
  taskId: string
  userId: string
  target: { sessionId?: string | null; agentSocket?: any }
  isManual?: boolean
}

/**
 * Sessions with a scheduled run currently in flight (waiting for the model's
 * assistant_message). Bundle 5 fallback: the `/ws/client` `send_message`
 * handler refuses manual sends while a scheduled turn is the active turn so the
 * manual reply isn't mis-attributed as the scheduled run's completion. Tracked
 * here (not via the shared pipeline's `activeBySession`, which is cross-
 * subsystem) so the gate stays scheduler-specific.
 */
const activeScheduledSessions = new Map<string, Set<string>>()
function markActive(sessionId: string, runId: string): void {
  const set = activeScheduledSessions.get(sessionId) ?? new Set<string>()
  set.add(runId)
  activeScheduledSessions.set(sessionId, set)
}
function clearActive(sessionId: string, runId: string): void {
  const set = activeScheduledSessions.get(sessionId)
  if (!set) return
  set.delete(runId)
  if (set.size === 0) activeScheduledSessions.delete(sessionId)
}

export function buildContent(task: ScheduledTask): string {
  // Phase 11: legacy `skill`/`security_scan`(root)/`continue_dev` rewritten to
  // `dev`/`security` by the DB migration; their `prompt` column carries the
  // original text verbatim. The `security_scan` chained step (under the
  // `security` workflow) keeps the `/security-review` slash-command shortcut.
  if (task.task_type === 'security_scan') return '/security-review'
  if (task.task_type === 'dev') {
    return (task.payload as any)?.prompt || task.prompt || 'Continue where you left off.'
  }
  return (task.payload as any)?.prompt || task.prompt || ''
}

const SUMMARY_DIRECTIVE = `\n\n---\nWhen finished, end your response with a single line starting with "Summary:" describing in 1-2 sentences what you accomplished or any blocker. Keep it brief — this is a scheduled run and the user only needs the headline result.`

/**
 * Session-targeted scheduled send. The dispatcher has already inserted the
 * `scheduled_task_runs` row (status='pending') and tracked the RunContext, so
 * the RunStore here does NOT insert a new row — it threads `ctx.runId` as the
 * dispatch token + finalize key, and translates pipeline outcomes onto the
 * existing run via `finalizeRun`.
 */
export async function sendAgentTask(task: ScheduledTask, ctx: RunCtxLike): Promise<void> {
  const sessionId = ctx.target.sessionId
  if (!sessionId) { await finalizeRun(ctx.runId, 'failed', 'no_session_id'); return }

  const content = buildContent(task)
  if (!content) { await finalizeRun(ctx.runId, 'failed', 'empty_content'); return }

  // Phase 11: build + persist the runtime context snapshot, then prepend the
  // `## RUNTIME CONTEXT` block to the SENT message only. The STORED content
  // (chat history) and the snapshot column never carry the Summary directive;
  // the snapshot lives on `scheduled_task_runs`, never in `messages`.
  let runtimeCtx: RuntimeContext = {}
  try {
    runtimeCtx = await buildRuntimeContext({ userId: ctx.userId, sessionId, taskKind: task.task_type })
  } catch {
    // Best-effort. Fall through with an empty ctx; renderer emits just the header.
  }
  const runtimeBlock = renderRuntimeContextBlock(runtimeCtx)
  try {
    await sql`
      UPDATE scheduled_task_runs
      SET runtime_context_snapshot = ${JSON.stringify(runtimeCtx)}::jsonb
      WHERE id = ${ctx.runId}
    `
  } catch {
    // Best-effort. Failure to persist the snapshot must not fail the run.
  }

  const sentContent = `${runtimeBlock}\n\n## TASK\n${content}${SUMMARY_DIRECTIVE}`
  const storedContent = `[scheduled: ${task.name}]\n\n${content}`

  // Manual runs fail fast when the target is offline instead of parking in
  // grace (immediate UI feedback) — legacy parity with the dispatcher's
  // isManual offline branch. Checked BEFORE dispatch() so no grace entry is
  // ever registered for a manual run.
  if (ctx.isManual && getChannel(sessionId) == null) {
    await finalizeRun(ctx.runId, 'failed', 'target_offline')
    return
  }

  const startedAt = Date.now()

  const store: RunStore = {
    // The run row already exists (dispatcher inserted it). Return ctx.runId so
    // the pipeline threads it as the finalize key. No new row inserted.
    async open() { return ctx.runId },
    // Gate / queue rejection. The pipeline passes the gate reason (threshold /
    // cost-cap re-check on promotion) or 'session_busy' (queue drop). Map onto
    // the existing run via finalizeRun so post-run / history stay consistent.
    async markSkipped(token, reason) {
      const status = reason.startsWith('quota_threshold_reached') ? 'skipped_quota' : 'skipped'
      await finalizeRun(token, status, reason)
      clearActive(sessionId, token)
    },
    // The exact legacy `onAssistantMessage` body: finalize the run as success
    // with the reply snippet. `finalizeRun` fires the post-run action pipeline.
    async onFinalize(token, replyContent) {
      const duration = Date.now() - startedAt
      const snippet = replyContent.length > 500 ? replyContent.slice(0, 500) + '...' : replyContent
      await finalizeRun(token, 'success', null, { duration_ms: duration, output_snippet: snippet })
      removeRunContext(token)
      clearActive(sessionId, token)
    },
    async markFailed(token, errMsg) {
      await finalizeRun(token, 'failed', `agent_send_failed: ${errMsg}`)
      clearActive(sessionId, token)
    },
  }

  const deps: PipelineDeps = {
    // IR-1: cost-cap non-bypassable. IR-2: threshold → cost-cap. Running the
    // gates here IS the waiter-promotion re-check the legacy `setOnPromote`
    // handler did — a user who crossed the cap while queued is skipped when the
    // pipeline re-dispatches the promoted waiter through this same gate list.
    gates: [thresholdGate, dailyCostCapGate],
    store,
    isOnline: (req) => getChannel(req.sessionId) != null,
    // Offline replay: re-run the task via runNow (fresh run row), mirroring the
    // legacy grace drain. Manual runs never park (handled below).
    replay: async () => {
      const { runNow } = await import('../dispatcher.ts')
      await runNow(task.id, ctx.userId, {})
    },
    // Grace TTL lapse → legacy expire-mark (skipped/target_offline).
    onParkExpire: async () => {
      await finalizeRun(ctx.runId, 'skipped', 'target_offline')
      clearActive(sessionId, ctx.runId)
    },
    // Ship the user_message: persist chat history, broadcast it, forward on the
    // agent socket WITH the runtime block + Summary directive (sent string only).
    send: async (req) => {
      const channel = getChannel(req.sessionId)
      if (!channel) throw new Error('agent_socket_missing')
      const msg = await insertMessage(req.sessionId, 'user', storedContent)
      broadcastToSubscribers(req.sessionId, {
        type: 'message', session_id: req.sessionId, message: msg, run_id: ctx.runId,
      })
      channel.ws.send(JSON.stringify({
        type: 'user_message', id: msg.id, content: sentContent, ts: msg.created_at, run_id: ctx.runId,
      }))
      markActive(req.sessionId, ctx.runId)
    },
  }

  const req: DispatchRequest = { userId: ctx.userId, sessionId, token: ctx.runId, prompt: sentContent }
  const outcome = await dispatch(req, deps)

  switch (outcome.kind) {
    case 'dispatched':
    case 'queued':
      // dispatched: send fired, finalize lands via onSessionReply.
      // queued: stays pending; promotion re-dispatches via onSessionReply.
      return
    case 'parked_offline':
      // Scheduled run parked in grace; onParkExpire marks target_offline on TTL
      // lapse, drain on reconnect re-dispatches via runNow. Manual runs already
      // failed fast above and never reach here.
      return
    case 'dropped_busy':
      // markSkipped(session_busy) already fired inside the pipeline.
      return
    case 'skipped':
    case 'failed':
      // markSkipped / markFailed already fired inside the pipeline.
      return
  }
}

/**
 * Bundle 5 fallback (TRIAGE-2026-05-28): true if a scheduled run is currently
 * in flight for `sessionId`. The `/ws/client` `send_message` handler uses this
 * to refuse manual sends while a scheduled turn is the active turn.
 */
export function isScheduledRunActive(sessionId: string): boolean {
  return (activeScheduledSessions.get(sessionId)?.size ?? 0) > 0
}

// Test-only — inspect the active-session map.
export function _activeScheduledSessions() { return activeScheduledSessions }
export { getRunContext }
