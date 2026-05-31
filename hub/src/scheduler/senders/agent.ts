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
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
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
import { getGraceBuffer } from '../../dispatch/grace.ts'
import { launchSessionForUser } from '../../telegram/launch.ts'
import { log } from '../../observability/logger'
import { extractDecisionBlock } from '../controller-schema.ts'

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

// auto-dev P2: the controller decision-tree prompt. A bare `dev` ROOT with no
// custom prompt renders this instead of the dumb `'Continue where you left
// off.'` literal so it reads repo state and emits a `<<DECISION>>` block the
// post-run router chains on. Read once at module init (sync; the template ships
// with the hub). `{{var}}` placeholders stay literal — the live values reach the
// agent via the prepended `## RUNTIME CONTEXT` block (same as the plan/execute/
// ship templates, which also never substitute their placeholders in prod).
const CONTROLLER_TEMPLATE = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'prompts', 'dev', 'controller.md'),
  'utf8',
)

export function buildContent(task: ScheduledTask): string {
  // Phase 11: legacy `skill`/`security_scan`(root)/`continue_dev` rewritten to
  // `dev`/`security` by the DB migration; their `prompt` column carries the
  // original text verbatim. The `security_scan` chained step (under the
  // `security` workflow) keeps the `/security-review` slash-command shortcut.
  if (task.task_type === 'security_scan') return '/security-review'
  const custom = (task.payload as any)?.prompt || task.prompt
  // auto-dev P2: an explicit `dev_controller` step OR a bare `dev` root with no
  // user-supplied prompt renders the controller template. A custom prompt
  // (payload.prompt / task.prompt — the #214 fix) always wins. Chained
  // `dev_plan`/`dev_execute`/`dev_ship` steps fall through to their own prompt.
  if (task.task_type === 'dev_controller') return custom || CONTROLLER_TEMPLATE
  if (task.task_type === 'dev') {
    return custom || CONTROLLER_TEMPLATE
  }
  return custom || ''
}

const SUMMARY_DIRECTIVE = `\n\n---\nWhen finished, end your response with a single line starting with "Summary:" describing in 1-2 sentences what you accomplished or any blocker. Keep it brief — this is a scheduled run and the user only needs the headline result.`

/**
 * Outcome of the offline-session pre-launch attempt (Phase 14 autostart).
 *
 *   - 'launched'      → session.start fired; proceed to dispatch(), which parks
 *                       the run in grace keyed by sessionId. The launched runner
 *                       connects → ws/agent drains grace → replay → runNow → the
 *                       prompt is delivered to the now-online session, live.
 *   - 'launch_pending'→ a launch was ALREADY triggered by an earlier fire (a live
 *                       grace entry exists). Skip this run with `launch_pending`
 *                       so we neither fire a duplicate session.start nor stack a
 *                       second grace entry / double-deliver — the earlier parked
 *                       run already covers delivery.
 *   - 'park'          → couldn't launch but the host is offline
 *                       (no_online_supervisor). Keep today's behaviour: fall
 *                       through to dispatch() → grace park → TTL lapse marks the
 *                       run skipped/target_offline.
 *   - { skip }        → a definitive non-launchable reason (at_capacity /
 *                       ambiguous / no_project_dir / …). The run is finalized
 *                       skipped with that reason — not a misleading target_offline.
 */
type LaunchAttempt = 'launched' | 'launch_pending' | 'park' | { skip: string }

/**
 * Proactively launch an OFFLINE session whose host (supervisor) is online, so a
 * scheduled/manual run actually executes instead of parking-then-skipping with
 * `target_offline`. Reuses the gate-respecting `launchSessionForUser` (the same
 * path the Telegram `/doctor` autoheal uses) — concurrency + cost gates stay
 * enforced; we do NOT mint a parallel session.start path.
 *
 * Dedup / no thundering herd: at most one launch per session per grace window.
 * A pending grace entry for this sessionId means a launch was already triggered
 * by an earlier fire (the entry is what the reconnect-drain replays), so we skip
 * a second `session.start` and report 'launched' (the existing pending entry
 * already covers delivery). A 4h task that keeps finding the session offline
 * therefore fires session.start at most once per 10-min grace TTL, never stacks.
 */
async function maybeLaunchOfflineSession(args: {
  userId: string
  sessionId: string
}): Promise<LaunchAttempt> {
  // Dedup: a live grace entry => a launch is already in flight for this session.
  // Don't fire a duplicate session.start (the parked replay already delivers).
  if (getGraceBuffer()._pendingCount(args.sessionId) > 0) {
    log.info('scheduler.agent.launch_dedup', { session_id: args.sessionId })
    return 'launch_pending'
  }

  const res = await launchSessionForUser({ userId: args.userId, sessionId: args.sessionId })
  if (res.ok) {
    log.info('scheduler.agent.session_launched', {
      session_id: args.sessionId, supervisor_id: res.supervisorId, run_id: res.runId,
    })
    return 'launched'
  }
  switch (res.reason) {
    case 'no_online_supervisor':
      // Host truly offline — can't launch. Keep today's park/skip behaviour.
      return 'park'
    case 'at_capacity':
      return { skip: 'at_capacity' }
    default:
      // supervisor_ambiguous / no_project_dir / session_not_found / send_failed /
      // internal_error — definitive, report the specific reason.
      return { skip: res.reason }
  }
}

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
    runtimeCtx = await buildRuntimeContext({ userId: ctx.userId, sessionId, taskKind: task.task_type, taskId: task.id })
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

  // Offline session target (Phase 14 autostart). Instead of parking-then-skipping
  // with `target_offline` (which wasted every scheduled run while the session was
  // offline), proactively launch the session when its host (supervisor) is online,
  // then let dispatch() park the prompt in grace so the freshly-launched runner
  // receives it on reconnect and the user sees the run execute live.
  if (getChannel(sessionId) == null) {
    const attempt = await maybeLaunchOfflineSession({ userId: ctx.userId, sessionId })
    if (typeof attempt === 'object') {
      // Definitive non-launchable reason (at_capacity / ambiguous / …). Skip the
      // run with that specific reason — informative, not a bare target_offline.
      await finalizeRun(ctx.runId, 'skipped', attempt.skip)
      return
    }
    if (attempt === 'launch_pending') {
      // A launch for this session is already in flight (one grace entry per
      // session). Skip this fire to avoid a duplicate session.start and a second
      // parked replay — the earlier parked run delivers once the session is up.
      await finalizeRun(ctx.runId, 'skipped', 'launch_pending')
      return
    }
    if (attempt === 'park' && ctx.isManual) {
      // Host offline + manual run: keep immediate UI feedback (fail fast) rather
      // than leaving a pending row to expire — legacy parity.
      await finalizeRun(ctx.runId, 'failed', 'target_offline')
      return
    }
    // attempt === 'launched'  → fall through to dispatch(); it parks the run in
    //                           grace, drained when the launched session connects.
    // attempt === 'park' (scheduled, host offline) → fall through; dispatch()
    //                           parks → TTL lapse marks skipped/target_offline.
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
      // auto-dev P2: the controller emits a `<<DECISION ... DECISION>>` block at
      // the END of its turn. The default head-truncation (first 500 chars) would
      // drop it, so when a decision block is present, snippet the block itself
      // (plus a short lead) so the post-run router can parse the chosen action.
      const decisionBlock = extractDecisionBlock(replyContent)
      let snippet: string
      if (decisionBlock) {
        snippet = decisionBlock.length > 500
          ? decisionBlock.slice(0, 500) + '...'
          : decisionBlock
      } else {
        snippet = replyContent.length > 500 ? replyContent.slice(0, 500) + '...' : replyContent
      }
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
