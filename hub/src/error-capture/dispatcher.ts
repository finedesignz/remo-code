/**
 * Error-capture dispatcher (Round-2 migration — now an adapter over the shared
 * session-dispatch pipeline `hub/src/dispatch/`).
 *
 * Previously this module hand-rolled: threshold gate → offline grace park →
 * per-session queue claim → agent-socket send → run-lifecycle finalize hook.
 * All of that now lives behind `dispatch()` in `hub/src/dispatch/pipeline.ts`.
 * This file is the thin error-capture adapter: it resolves the project →
 * session, builds the prompt + a `RunStore` that persists/updates `error_runs`,
 * sets the gate list (threshold → cost-cap — IR-1/IR-2), provides the offline
 * `replay`/`onParkExpire` thunks, and maps the pipeline's `DispatchOutcome`
 * back to the WS events + `errors.dispatch_status` vocabulary error-capture
 * already emits.
 *
 * Finalize is no longer wired here: the agent ws assistant_message branch calls
 * `dispatch.onSessionReply(sessionId, content)`, which fires `RunStore.onFinalize`
 * for the in-flight error run and promotes/re-dispatches any queued errorId
 * through the full gate list again.
 *
 * Behaviour preserved verbatim:
 *   - threshold gate first, cost-cap second (IR-2); cost-cap non-bypassable (IR-1).
 *     NOTE: the legacy dispatcher had NO daily-cost-cap gate — only the Claude
 *     usage threshold. The migration ADDS `dailyCostCapGate` per the IR-1
 *     mandate (every migrated subsystem's gates[] MUST include the cost-cap).
 *   - offline target → grace park + status='skipped(session_offline)' + notify;
 *     TTL lapse → status='skipped(target_offline_expired)' (now via onParkExpire).
 *   - queue dropped → status='skipped(session_busy)' + notify dispatch_failed.
 *   - send failure → status='failed' + run 'failed' + notify dispatch_failed.
 *   - dispatched → insert error_run(in_flight), persist user message, send,
 *     status='dispatched', broadcast error_dispatched.
 *
 * Hooked into recordError as a fire-and-forget tail (no await; we never
 * block the intake POST).
 */
import {
  insertErrorRun,
  updateErrorDispatchStatus,
  updateErrorRunStatus,
} from '../db/error-capture-dal.ts'
import { sql } from '../db/postgres.ts'
import type { ErrorProject, ErrorRow } from '../db/error-capture-dal.ts'
import { getChannel, broadcastErrorEvent } from '../ws/registry.ts'
import { insertMessage } from '../db/dal.ts'
import { notifyThrottled } from './notify.ts'
import { buildErrorMessage } from './prompt.ts'
import {
  dispatch,
  type DispatchRequest,
  type PipelineDeps,
  type RunStore,
} from '../dispatch/pipeline.ts'
import { thresholdGate, dailyCostCapGate, dailyTokenCapGate } from '../dispatch/gates.ts'
import { ensureSessionOnline } from '../dispatch/spawn-on-error.ts'

export type DispatchOutcome =
  | { status: 'dispatched'; run_id: string }
  | { status: 'queued' }
  | { status: 'skipped'; skip_reason: string }
  | { status: 'failed'; skip_reason: string }
  | { status: 'noop'; skip_reason: string }

async function loadErrorRow(errorId: string): Promise<ErrorRow | null> {
  const rows = await sql<ErrorRow[]>`SELECT * FROM errors WHERE id = ${errorId} LIMIT 1`
  return rows[0] ?? null
}

export async function dispatchPendingError(errorId: string): Promise<DispatchOutcome> {
  const error = await loadErrorRow(errorId)
  if (!error) return { status: 'noop', skip_reason: 'error_not_found' }
  if (error.dispatch_status !== 'pending') {
    return { status: 'noop', skip_reason: `not_pending:${error.dispatch_status}` }
  }

  // Project resolution — owner is on the project row (unscoped lookup; the
  // errorId already authorizes us, the intake set project_id from the key).
  const projRows = await sql<ErrorProject[]>`
    SELECT * FROM error_projects WHERE id = ${error.project_id} LIMIT 1
  `
  const project = projRows[0]
  if (!project) {
    await updateErrorDispatchStatus(errorId, 'failed', 'project_missing')
    return { status: 'failed', skip_reason: 'project_missing' }
  }

  const sessionId = project.session_id
  const userId = project.user_id

  // Prompt + stored chat content. Built once; the RunStore's send persists the
  // user message and forwards it on the agent socket.
  const content = buildErrorMessage(error, project)
  const storedContent = `[error: ${project.name} — ${error.error_type}]\n\n${content}`

  const notifyCtx = { error_type: error.error_type, error_value: error.error_value }

  const store: RunStore = {
    // Insert the run row (in_flight) and RETURN its id — the pipeline threads
    // this id into the finalize hook, so onFinalize / markFailed receive the
    // real run id as their token arg. Fires exactly when the pipeline actually
    // dispatches (after gates + queue claim + online check), never for a
    // skipped / dropped / queued / parked message — matching legacy "insert the
    // run row when we send".
    async open(_req) {
      const run = await insertErrorRun(errorId, project.id, sessionId)
      await updateErrorRunStatus(run.id, { status: 'in_flight', started_at: new Date() })
      return run.id
    },
    // Gate / queue rejections. The pipeline passes the gate reason or
    // 'session_busy'. We translate to the error_capture skip vocabulary.
    async markSkipped(_token, reason) {
      await updateErrorDispatchStatus(errorId, 'skipped', reason)
      if (reason === 'session_busy') {
        void notifyThrottled('dispatch_failed', `${project.id}:${sessionId}:busy`, 900, project, {
          ...notifyCtx,
          detail: 'session_busy',
        }).catch(() => {})
      }
      broadcastErrorEvent(userId, {
        type: 'error_skipped',
        error_id: errorId,
        project_id: project.id,
        dispatch_status: 'skipped',
        skip_reason: reason,
      })
    },
    // `runId` is the id returned by open(), threaded back by the pipeline.
    async onFinalize(runId, replyContent) {
      const snippet =
        replyContent.length > 500 ? replyContent.slice(replyContent.length - 500) : replyContent
      // cost_usd left null — the agent stream protocol carries no per-turn cost.
      await updateErrorRunStatus(runId, {
        status: 'success',
        finished_at: new Date(),
        output_snippet: snippet,
        cost_usd: null,
        duration_ms: null,
      })
      broadcastErrorEvent(userId, {
        type: 'error_run_finished',
        error_id: errorId,
        project_id: project.id,
        run_id: runId,
        status: 'success',
        output_snippet: snippet,
        cost_usd: null,
        duration_ms: null,
        finished_at: new Date().toISOString(),
      })
    },
    async markFailed(runId, errMsg) {
      await updateErrorDispatchStatus(errorId, 'failed', `agent_send: ${errMsg}`)
      await updateErrorRunStatus(runId, {
        status: 'failed',
        error: `agent_send: ${errMsg}`,
        finished_at: new Date(),
      })
      void notifyThrottled('dispatch_failed', `${project.id}:${sessionId}:send`, 900, project, {
        ...notifyCtx,
        detail: errMsg,
      }).catch(() => {})
    },
  }

  const deps: PipelineDeps = {
    // IR-1: cost-cap is non-bypassable. IR-2: threshold first, then cost-cap.
    gates: [thresholdGate, dailyCostCapGate, dailyTokenCapGate],
    store,
    isOnline: (req) => getChannel(req.sessionId) != null,
    // Spawn-on-error (opt-in via REMO_SPAWN_ON_ERROR): when the bound session
    // is offline, lazy-START it via the supervisor before parking, so an idle
    // app actually auto-repairs. Runs only after the gate list passes (cost-cap
    // etc. stay non-bypassable); leak-safe + dormant by default.
    ensureOnline: (req) => ensureSessionOnline(req.userId, req.sessionId),
    // Offline replay: re-run the full dispatch for this pending error.
    replay: async () => {
      await dispatchPendingError(errorId)
    },
    // Grace TTL lapse → legacy expire-mark (skipped/target_offline_expired).
    onParkExpire: async () => {
      await updateErrorDispatchStatus(errorId, 'skipped', 'target_offline_expired')
    },
    // Ship the user_message: persist chat history then forward on the socket.
    send: async (req) => {
      const channel = getChannel(req.sessionId)
      if (!channel) throw new Error('session_offline')
      const msg = await insertMessage(req.sessionId, 'user', storedContent)
      channel.ws.send(
        JSON.stringify({ type: 'user_message', id: msg.id, content: req.prompt, ts: msg.created_at }),
      )
    },
  }

  const req: DispatchRequest = { userId, sessionId, token: errorId, prompt: content }
  const outcome = await dispatch(req, deps)

  switch (outcome.kind) {
    case 'dispatched':
      // Legacy parity: status='dispatched' + broadcast AFTER the send succeeds.
      // outcome.runId is the id open() returned (the real error_run id).
      await updateErrorDispatchStatus(errorId, 'dispatched')
      broadcastErrorEvent(userId, {
        type: 'error_dispatched',
        error_id: errorId,
        project_id: project.id,
        run_id: outcome.runId,
        dispatched_at: new Date().toISOString(),
      })
      return { status: 'dispatched', run_id: outcome.runId }
    case 'queued':
      // Stays pending; promotion re-dispatches via onSessionReply.
      return { status: 'queued' }
    case 'parked_offline':
      // Legacy parity: an offline target was marked skipped(session_offline) +
      // notified + parked in grace. The pipeline parks for us (TTL lapse fires
      // onParkExpire → target_offline_expired); we own the immediate skip-mark
      // + notify here so the row never sits at 'pending'.
      await updateErrorDispatchStatus(errorId, 'skipped', 'session_offline')
      void notifyThrottled(
        'session_offline',
        `${project.id}:${sessionId}`,
        1800,
        project,
        notifyCtx,
      ).catch(() => {})
      broadcastErrorEvent(userId, {
        type: 'error_skipped',
        error_id: errorId,
        project_id: project.id,
        dispatch_status: 'skipped',
        skip_reason: 'session_offline',
      })
      return { status: 'skipped', skip_reason: 'session_offline' }
    case 'dropped_busy':
      return { status: 'skipped', skip_reason: 'session_busy' }
    case 'skipped':
      return { status: 'skipped', skip_reason: outcome.reason }
    case 'failed':
      return { status: 'failed', skip_reason: 'agent_send_failed' }
  }
}
