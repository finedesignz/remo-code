/**
 * Triage sender (Phase 06 plan 008).
 *
 * Routes a `task_type='triage'` run to a LIVE LOCAL-AGENT session: the repo-keyed
 * session for the failing repo when there is one, else any online agent session
 * for the user. The send goes through the shared `dispatch()` pipeline (gates →
 * per-session queue → grace → send). The run finalizes via the agent ws
 * `assistant_message` branch → `onSessionReply` → `RunStore.onFinalize`, which
 * parses the model output with `parseTriageOutput` and finalizes (success +
 * TriageResult JSON, or 'triage_parse_error'). `finalizeRun` then fires the
 * post-run pipeline (e.g. the `github_issue` action with its 24h idempotency).
 *
 * NO SUPERVISOR SPAWN (fix/sched-triage-routing). Triage used to run through
 * `pickSessionTarget`, which prefers an online supervisor over a local agent, and
 * on a supervisor pick spawned a FRESH session via `session.start`. That path was
 * unroutable in two independent ways, and in prod it swallowed 31 of 32 triage
 * runs (all `failed/triage_timeout`, ~878s each, `session_id` NULL on every row):
 *   1. The pending waiter was keyed by the SUPERVISOR RUN id, but the only caller
 *      (`ws/agent.ts` assistant_message → `triageActiveForSession`) looks it up by
 *      SESSION id. The hub mints the session id at agent auth from the project dir
 *      (`findOrCreateAgentSessionV2`) and never binds it to a run row, so the two
 *      ids can never match — the waiter was unreachable and always expired at the
 *      15min sweep.
 *   2. `session.start` was sent with `repo_path = payload.git_repository`
 *      (e.g. `owner/repo`) and `branch = commit_sha`, i.e. a GitHub slug where the
 *      supervisor expects a local worktree path to `cd` into.
 * With no live agent session the run now finalizes IMMEDIATELY as
 * `failed/no_target_available` instead of hanging 15 minutes to `triage_timeout`.
 *
 * Bypasses `resolveTargets`: triage tasks have no fixed target_kind/target_id
 * and the dispatcher calls us directly.
 */
import type { ScheduledTask } from '../../db/scheduled-tasks-dal.ts'
import { resolveRepoKeyedAgentSession } from '../../sessions/repo-routing.ts'
import { getChannel, broadcastToSubscribers, listOnlineAgentSessionsForUser } from '../../ws/registry.ts'
import { insertMessage } from '../../db/dal.ts'
import { renderTriagePrompt } from '../triage-prompt.ts'
import { parseTriageOutput } from '../triage-schema.ts'
import { finalizeRun, removeRunContext } from '../dispatcher.ts'
import {
  dispatch,
  type DispatchRequest,
  type PipelineDeps,
  type RunStore,
} from '../../dispatch/pipeline.ts'
import { thresholdGate, dailyCostCapGate, dailyTokenCapGate } from '../../dispatch/gates.ts'

export interface TriagePayload {
  application_uuid: string
  deployment_uuid: string
  git_repository?: string
  commit_sha?: string
  log_snippet: string
}

interface RunCtxLike {
  runId: string
  taskId: string
  userId: string
}

export async function sendTriage(
  task: ScheduledTask,
  ctx: RunCtxLike,
  payload: TriagePayload,
): Promise<void> {
  // auto-dev P5: repo-keyed routing FIRST. A Coolify deploy-failure carries the
  // failing repo's `git_repository`; if a session is bound to that repo and has
  // a live agent socket, land the fix THERE rather than in a capacity-picked
  // stranger. Only when there's no repo match do we fall back to
  // `pickSessionTarget` (capacity-based), preserving prior behavior.
  const repoKeyed = await resolveRepoKeyedAgentSession(
    ctx.userId,
    payload.git_repository,
    payload.application_uuid,
  )
  const prompt = renderTriagePrompt(payload)
  if (repoKeyed) {
    console.log(
      `[triage] repo-keyed route task=${ctx.taskId} repo_key=${repoKeyed.repo_key} session=${repoKeyed.agent_session_id}`,
    )
  }
  // Local-agent only (see header). No live agent session ⇒ finalize NOW with a
  // truthful error rather than parking a waiter that can only ever time out.
  const sessionId = repoKeyed?.agent_session_id ?? listOnlineAgentSessionsForUser(ctx.userId)[0]
  if (!sessionId) {
    await finalizeRun(ctx.runId, 'failed', 'no_target_available')
    removeRunContext(ctx.runId)
    return
  }

  // Round-2 migration: route through the shared dispatch pipeline. The run row
  // already exists (the dispatcher inserted it), so the RunStore returns
  // ctx.runId as the finalize token; onFinalize does the TriageResult parse and
  // calls finalizeRun (which fires the post-run pipeline). The pipeline's
  // thresholdGate applies the same Claude-usage quota block that
  // `pickSessionTarget` used to apply here (→ skipped_quota via markSkipped).
  // Triage carries per-event payload that would be stale if replayed later, so
  // it never parks in grace — fail fast when the agent socket is gone (legacy
  // parity: the old branch returned 'agent_socket_missing' immediately).
  if (getChannel(sessionId) == null) {
    await finalizeRun(ctx.runId, 'failed', 'agent_socket_missing')
    removeRunContext(ctx.runId)
    return
  }
  const storedContent = `[triage: ${task.name}]\n\n${prompt}`
  const startedAt = Date.now()

  const store: RunStore = {
    async open() { return ctx.runId },
    async markSkipped(token, reason) {
      const status = reason.startsWith('quota_threshold_reached') ? 'skipped_quota' : 'skipped'
      await finalizeRun(token, status, reason)
      removeRunContext(token)
    },
    // Triage finalize: parse the model output as a TriageResult. ok → success +
    // JSON snippet; parse failure → 'triage_parse_error'. Matches the legacy
    // onTriageAssistantMessage body exactly.
    async onFinalize(token, content) {
      const duration = Date.now() - startedAt
      const parsed = parseTriageOutput(content)
      if (parsed.ok) {
        await finalizeRun(token, 'success', null, {
          duration_ms: duration, output_snippet: JSON.stringify(parsed.value),
        })
      } else {
        await finalizeRun(token, 'failed', 'triage_parse_error', {
          duration_ms: duration,
          output_snippet: content.length > 4000 ? content.slice(0, 4000) : content,
        })
      }
      removeRunContext(token)
    },
    async markFailed(token, errMsg) {
      await finalizeRun(token, 'failed', `agent_send_failed: ${errMsg}`)
      removeRunContext(token)
    },
  }

  const deps: PipelineDeps = {
    // IR-1 / IR-2: cost-cap non-bypassable; threshold → cost-cap (+ promotion re-check).
    gates: [thresholdGate, dailyCostCapGate, dailyTokenCapGate],
    store,
    isOnline: (req) => getChannel(req.sessionId) != null,
    // Triage runs are not replayed on reconnect (they carry per-event payload
    // that would be stale); offline → mark failed via onParkExpire.
    replay: async () => { await finalizeRun(ctx.runId, 'failed', 'agent_socket_missing') },
    onParkExpire: async () => { await finalizeRun(ctx.runId, 'failed', 'agent_socket_missing') },
    send: async (req) => {
      const ch = getChannel(req.sessionId)
      if (!ch) throw new Error('agent_socket_missing')
      const msg = await insertMessage(req.sessionId, 'user', storedContent)
      broadcastToSubscribers(req.sessionId, {
        type: 'message', session_id: req.sessionId, message: msg, run_id: ctx.runId,
      })
      ch.ws.send(JSON.stringify({
        type: 'user_message', id: msg.id, content: req.prompt, ts: msg.created_at, run_id: ctx.runId,
      }))
    },
  }

  const req: DispatchRequest = { userId: ctx.userId, sessionId, token: ctx.runId, prompt }
  const outcome = await dispatch(req, deps)
  if (outcome.kind === 'parked_offline') {
    // No live agent socket; the pipeline parked a replay that fails fast.
    // Mark immediately so the run doesn't sit pending.
    await finalizeRun(ctx.runId, 'failed', 'agent_socket_missing')
    removeRunContext(ctx.runId)
  }
}

