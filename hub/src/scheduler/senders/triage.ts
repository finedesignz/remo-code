/**
 * Triage sender (Phase 06 plan 008).
 *
 * Routes a `task_type='triage'` run through the Phase 04 plan 008
 * `pickSessionTarget` primitive: picks an online supervisor (with capacity)
 * or falls back to a local agent, dispatches the rendered triage prompt to
 * a fresh session, and finalizes the run when the model emits its first
 * assistant turn.
 *
 * Completion path:
 *   - LOCAL-AGENT pick (Round-2 migration): the send goes through the shared
 *     `dispatch()` pipeline (gates → per-session queue → grace → send). The run
 *     finalizes via the agent ws `assistant_message` branch → `onSessionReply`
 *     → `RunStore.onFinalize`, which parses the model output with
 *     `parseTriageOutput` and finalizes (success + TriageResult JSON, or
 *     'triage_parse_error'). `finalizeRun` then fires the post-run pipeline
 *     (e.g. the `github_issue` action with its 24h idempotency).
 *   - SUPERVISOR pick: spawns a FRESH session via the supervisor
 *     (`createRun` + `sendToSupervisor`) — NOT a per-session-queue dispatch, so
 *     it stays on the legacy `pending` map + `onTriageAssistantMessage` hook
 *     (parallel to `sendSupervisorTask`, which is also out of the migration
 *     scope). When the spawned session replies, `triageActiveForSession` gates
 *     the legacy finalize.
 *
 * Bypasses `resolveTargets`: triage tasks have no fixed target_kind/target_id
 * and the dispatcher calls us directly.
 */
import type { ScheduledTask } from '../../db/scheduled-tasks-dal.ts'
import { pickSessionTarget } from '../../sessions/routing.ts'
import { resolveRepoKeyedAgentSession } from '../../sessions/repo-routing.ts'
import { sendToSupervisor, updateSupervisorState } from '../../ws/supervisor-registry.ts'
import { releaseSessionSlot } from '../../sessions/budget.ts'
import { getChannel, broadcastToSubscribers } from '../../ws/registry.ts'
import { insertMessage, getSessionSkipPermissionsByRepo } from '../../db/dal.ts'
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

interface PendingTriage {
  runId: string
  taskId: string
  userId: string
  startedAt: number
}

// session_id → pending triage waiter. Single entry per session — triage spawns
// a fresh session per run so collisions are not expected.
const pending = new Map<string, PendingTriage>()

function parsePositiveIntEnv(raw: string | undefined, fallback: number): number {
  if (raw == null || raw === '') return fallback
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

/**
 * Max age of a pending supervisor-picked triage turn before it's finalized
 * `failed`/`triage_timeout`. Default 15min — the hardcoded 5min ceiling was
 * shorter than a real Coolify triage turn (~5.5min observed in prod), so healthy
 * runs were falsely failed. Read at sweep time (not module load) so a Coolify env
 * change takes effect on the next tick; non-positive/non-finite ⇒ default.
 */
export function triageTimeoutMs(): number {
  return parsePositiveIntEnv(process.env.REMO_TRIAGE_TIMEOUT_MS, 900_000)
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
  const triagePrompt = renderTriagePrompt(payload)
  const pick: Awaited<ReturnType<typeof pickSessionTarget>> = repoKeyed
    ? { kind: 'local_agent', agent_session_id: repoKeyed.agent_session_id }
    : await pickSessionTarget(ctx.userId, {
        // Consume the run row atomically inside the reservation tx.
        runFields: {
          sessionId: null,
          repoPath: payload.git_repository || 'unknown',
          branch: payload.commit_sha || 'HEAD',
          pulled: false,
          initialPrompt: triagePrompt,
        },
      })
  if (repoKeyed) {
    console.log(
      `[triage] repo-keyed route task=${ctx.taskId} repo_key=${repoKeyed.repo_key} session=${repoKeyed.agent_session_id}`,
    )
  }
  if (pick.kind === 'quota_blocked') {
    await finalizeRun(
      ctx.runId,
      'skipped_quota',
      `quota_threshold_reached:${pick.reason}:${pick.utilization_pct}>=${pick.threshold_pct}`,
    )
    return
  }
  if (pick.kind === 'none') {
    await finalizeRun(ctx.runId, 'failed', 'no_target_available')
    return
  }

  const prompt = triagePrompt

  if (pick.kind === 'supervisor') {
    const repo = payload.git_repository || 'unknown'
    const branch = payload.commit_sha || 'HEAD'
    // Run row already consumed atomically inside the reservation tx.
    if (!pick.run) {
      await finalizeRun(ctx.runId, 'failed', 'run_insert_failed')
      return
    }
    const run = pick.run

    const skipPerms = await getSessionSkipPermissionsByRepo(ctx.userId, repo)
    try {
      sendToSupervisor(pick.supervisor_id, {
        type: 'session.start',
        req_id: run.id,
        run_id: run.id,
        repo_path: repo,
        branch,
        pull: false,
        initial_prompt: prompt,
        api_key: '__use_local__',
        hub_url: '__same__',
        dangerously_skip_permissions: skipPerms,
      } as any)
    } catch (err: any) {
      try {
        const { endRun } = await import('../../db/supervisor-dal.ts')
        await endRun(run.id, null, `triage_dispatch_failed: ${err?.message ?? 'unknown'}`)
      } catch {}
      await releaseSessionSlot(ctx.userId, pick.supervisor_id)
      await finalizeRun(ctx.runId, 'failed', `dispatch_failed: ${err?.message ?? 'unknown'}`)
      return
    }

    try { await updateSupervisorState(pick.supervisor_id, 'starting', run.id) } catch {}

    pending.set(run.id, {
      runId: ctx.runId, taskId: ctx.taskId, userId: ctx.userId, startedAt: Date.now(),
    })
    return
  }

  // pick.kind === 'local_agent' — Round-2 migration: route through the shared
  // dispatch pipeline. The run row already exists (the dispatcher inserted it),
  // so the RunStore returns ctx.runId as the finalize token; onFinalize does the
  // TriageResult parse and calls finalizeRun (which fires the post-run pipeline).
  const sessionId = pick.agent_session_id
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

/**
 * True if `sessionId` is awaiting a triage completion. The ws/agent hook
 * checks this before routing the assistant message to the normal handler.
 */
export function triageActiveForSession(sessionId: string): boolean {
  return pending.has(sessionId)
}

/**
 * Called from `hub/src/ws/agent.ts` (and the supervisor message handler)
 * when an assistant message lands. Parses the body as a TriageResult and
 * finalizes the run.
 */
export async function onTriageAssistantMessage(
  sessionId: string,
  content: string,
): Promise<void> {
  const p = pending.get(sessionId)
  if (!p) return
  pending.delete(sessionId)

  const duration = Date.now() - p.startedAt
  const parsed = parseTriageOutput(content)
  if (parsed.ok) {
    await finalizeRun(p.runId, 'success', null, {
      duration_ms: duration,
      output_snippet: JSON.stringify(parsed.value),
    })
  } else {
    await finalizeRun(p.runId, 'failed', 'triage_parse_error', {
      duration_ms: duration,
      output_snippet: content.length > 4000 ? content.slice(0, 4000) : content,
    })
  }
  removeRunContext(p.runId)
}

setInterval(() => {
  const now = Date.now()
  const timeoutMs = triageTimeoutMs()
  for (const [sid, p] of pending) {
    if (now - p.startedAt > timeoutMs) {
      pending.delete(sid)
      void finalizeRun(p.runId, 'failed', 'triage_timeout')
      removeRunContext(p.runId)
    }
  }
}, 30_000)

// Test-only — lets the e2e flush state between cases.
export function _pending() { return pending }
