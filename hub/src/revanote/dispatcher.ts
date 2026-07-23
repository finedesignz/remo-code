/**
 * Revanote dispatcher (Round-2 migration — now an adapter over the shared
 * session-dispatch pipeline `hub/src/dispatch/`).
 *
 * Previously this module hand-rolled: threshold gate → per-source budget gate →
 * session resolution → offline grace park → per-session queue claim →
 * agent-socket send → run-lifecycle finalize hook. All of that machinery now
 * lives behind `dispatch()` in `hub/src/dispatch/pipeline.ts`. This file is the
 * thin revanote adapter: it resolves the annotation's mapping → session, builds
 * the prompt + a `RunStore` that persists/updates `annotation_runs` and the
 * `annotations` status enum, sets the gate list
 * (threshold → cost-cap → revanote-budget — IR-1/IR-2), provides the offline
 * `replay`/`onParkExpire` thunks, and maps the pipeline's `DispatchOutcome`
 * back to the WS events + annotation status vocabulary revanote already emits.
 *
 * Finalize is no longer wired here: the agent ws assistant_message branch calls
 * `dispatch.onSessionReply(sessionId, content)`, which fires `RunStore.onFinalize`
 * for the in-flight annotation run and promotes/re-dispatches any queued
 * annotationId through the full gate list again. `onFinalize` carries the exact
 * legacy `run-lifecycle.onAgentReply` behaviour: parse the `<<JSON>>…<<END>>`
 * envelope, mark the annotation resolved/failed, run the merge gate, and ENQUEUE
 * the outbound callback (always with `annotation_id`).
 *
 * The per-source revanote budget gate (`users.revanote_budget_pct`) is layered
 * ON TOP of the global daily cost cap as a third `DispatchGate` — it is NOT a
 * substitute for the cost cap (IR-1).
 *
 * Behaviour preserved verbatim:
 *   - threshold gate first, cost-cap second, revanote-budget third (IR-2);
 *     cost-cap non-bypassable (IR-1). NOTE: the legacy dispatcher had NO global
 *     daily-cost-cap gate — only the Claude usage threshold + the per-source
 *     budget. The migration ADDS `dailyCostCapGate` per the IR-1 mandate.
 *   - threshold / budget block → annotation 'failed' + skip_reason + reject
 *     callback (errorTag 'budget_threshold').
 *   - no session/mapping → annotation 'failed' + reject callback ('no_target').
 *   - offline target → grace park + annotation 'pending'(skip_reason
 *     'session_offline'); TTL lapse → 'failed_offline'(target_offline_expired)
 *     (now via onParkExpire). Revanote now opts into spawn-on-error via the
 *     `ensureOnline` dep (REMO_SPAWN_ON_ERROR): an offline-but-mapped target is
 *     lazy-STARTed through the supervisor before parking, mirroring error-capture.
 *   - queue dropped → annotation 'failed'(session_busy) + reject callback
 *     ('session_busy').
 *   - dispatched → insert annotation_run(in_flight), persist user message,
 *     broadcast it, send, annotation 'dispatched', broadcast revanote_dispatched.
 *
 * Fire-and-forget tail off the webhook handler. Never blocks intake.
 */
import { sql } from '../db/postgres.ts'
import {
  getAnnotationById,
  insertAnnotationRun,
  updateAnnotationStatus,
  updateAnnotationRun,
  resolveRevanoteMappingForHost,
  sumTodayAnnotationCostForUser,
  type AnnotationRow,
  type RevanoteMapping,
} from '../db/revanote-dal.ts'
import { findSessionByProjectDir, insertMessage } from '../db/dal.ts'
import { getChannel, broadcastRevanoteEvent, broadcastToSubscribers } from '../ws/registry.ts'
import { renderAnnotationPrompt, storagePrefix, previewComment } from './prompt.ts'
import { finalizeAnnotationReply } from './run-lifecycle.ts'
import {
  dispatch,
  type DispatchRequest,
  type DispatchGate,
  type PipelineDeps,
  type RunStore,
} from '../dispatch/pipeline.ts'
import { thresholdGate, dailyCostCapGate, dailyTokenCapGate, sessionInjectRateGate } from '../dispatch/gates.ts'
import { ensureSessionOnline } from '../dispatch/spawn-on-error.ts'

export type DispatchOutcome =
  | { status: 'dispatched'; run_id: string; session_id: string }
  | { status: 'queued' }
  | { status: 'skipped'; skip_reason: string }
  | { status: 'failed'; skip_reason: string }
  | { status: 'noop'; skip_reason: string }

function hostOf(pageUrl: string): string {
  try {
    return new URL(pageUrl).host
  } catch {
    return ''
  }
}

/**
 * Best-effort timezone read. Falls back to UTC on lookup failure.
 */
async function getUserTimezone(userId: string): Promise<string> {
  try {
    const rows = await sql<{ tz: string | null }[]>`
      SELECT COALESCE(timezone, 'UTC') AS tz FROM users WHERE id = ${userId} LIMIT 1
    `
    return rows[0]?.tz || 'UTC'
  } catch {
    return 'UTC'
  }
}

/**
 * Per-source budget gate. Treats `users.revanote_budget_pct` (default 60) as a
 * percentage of the daily cap. When today's revanote-attributed cost already
 * meets-or-exceeds that fraction, refuse new dispatches with
 * `revanote_budget_exceeded:<detail>`. This is a `DispatchGate` so it runs in
 * the shared pipeline gate chain AFTER threshold + cost-cap — layered ON TOP of
 * the global cost cap (IR-1), never a substitute.
 *
 * Exported so the budget-gate unit test can exercise it directly.
 */
export function revanoteBudgetGate(userId: string, timezone: string): DispatchGate {
  return {
    name: 'revanote_budget',
    async check(_req: DispatchRequest) {
      const rows = await sql<{ cap: string; pct: number | null }[]>`
        SELECT daily_cost_cap_usd::text AS cap, revanote_budget_pct AS pct
          FROM users WHERE id = ${userId} LIMIT 1
      `
      const cap = Number(rows[0]?.cap ?? 10)
      // No cap configured → no per-source budget either (fail-open, matches legacy).
      if (!Number.isFinite(cap) || cap <= 0) return { ok: true }
      const pct = rows[0]?.pct ?? 60
      const sourceCap = cap * (pct / 100)
      const spent = await sumTodayAnnotationCostForUser(userId, timezone)
      if (spent >= sourceCap) {
        return {
          ok: false,
          reason: `revanote_budget_exceeded:spent=${spent.toFixed(4)}>=cap=${sourceCap.toFixed(4)}`,
        }
      }
      return { ok: true }
    },
  }
}

async function resolveSessionId(
  userId: string,
  mapping: RevanoteMapping | null,
): Promise<string | null> {
  if (!mapping) return null
  const sess = await findSessionByProjectDir(userId, mapping.repo_path)
  return sess?.id ?? null
}

/**
 * Helper: queue an immediate callback for a pre-dispatch rejection. Loaded
 * lazily so test environments without the callback module loaded don't crash.
 * ALWAYS carries the external `annotation_id` (revanote invariant).
 */
async function enqueueRejectionCallback(
  ann: AnnotationRow,
  errorTag: string,
  detail: string,
): Promise<void> {
  try {
    const { scheduleImmediateCallback } = await import('./callback.ts')
    await scheduleImmediateCallback(ann, {
      annotation_id: ann.annotation_id_external,
      resolved: false,
      action_taken: errorTag,
      agent_reply: null,
      files_changed: [],
      deployed: false,
      error: detail,
    })
  } catch (err: any) {
    console.warn(`[revanote.dispatcher] enqueueRejectionCallback failed: ${err?.message ?? err}`)
  }
}

export async function dispatchPendingAnnotation(annotationId: string): Promise<DispatchOutcome> {
  const ann = await getAnnotationById(annotationId, await peekUserIdForAnnotation(annotationId))
  if (!ann) return { status: 'noop', skip_reason: 'annotation_not_found' }
  if (ann.status !== 'pending' && ann.status !== 'failed_offline') {
    return { status: 'noop', skip_reason: `not_pending:${ann.status}` }
  }
  return await dispatchAnnotationRow(ann)
}

async function peekUserIdForAnnotation(annotationId: string): Promise<string> {
  const rows = await sql<{ user_id: string }[]>`SELECT user_id FROM annotations WHERE id = ${annotationId}`
  return rows[0]?.user_id ?? ''
}

/**
 * Dispatch entrypoint used by the webhook (already has the annotation row).
 * Returns the outcome but never throws — failures are recorded on the row.
 */
export async function dispatchAnnotationRow(ann: AnnotationRow): Promise<DispatchOutcome> {
  const userId = ann.user_id
  const tz = await getUserTimezone(userId)

  // Resolve mapping (host → repo_path + deploy strategy) + session up front so
  // the pipeline has a concrete target. A missing session is NOT a pipeline gate
  // (it is a target-resolution failure with its own reject-callback semantics),
  // so we short-circuit it here before entering dispatch().
  const host = hostOf(ann.page_url)
  const mapping = await resolveRevanoteMappingForHost(userId, host)
  const sessionId = ann.session_id || (await resolveSessionId(userId, mapping))
  if (!sessionId) {
    const reason = mapping ? 'session_not_found_for_repo' : 'no_mapping_for_host'
    await updateAnnotationStatus(ann.id, 'failed', {
      skip_reason: reason,
      mapping_id: mapping?.id ?? null,
    })
    broadcastRevanoteEvent(userId, {
      type: 'revanote_skipped', annotation_id: ann.id, skip_reason: reason,
    })
    void enqueueRejectionCallback(ann, 'no_target', reason)
    return { status: 'failed', skip_reason: reason }
  }

  // Prompt + stored chat content. Built once; the RunStore's send persists the
  // user message, broadcasts it, and forwards it on the agent socket.
  const promptBody = renderAnnotationPrompt({ annotation: ann, mapping })
  const storedContent = `${storagePrefix(ann.comment)}\n\n${promptBody}`

  const store: RunStore = {
    // Insert the annotation_run row (in_flight) and RETURN its id — the pipeline
    // threads this id into the finalize hook, so onFinalize / markFailed receive
    // the real run id as their token arg. Fires exactly when the pipeline
    // actually dispatches (after gates + queue claim + online check), never for
    // a skipped / dropped / queued / parked annotation — matching the legacy
    // "insert the run row when we send" rule.
    async open(_req) {
      const run = await insertAnnotationRun({
        annotation_id: ann.id, user_id: userId, session_id: sessionId,
      })
      return run.id
    },
    // Gate / queue rejections. The pipeline passes the gate reason or
    // 'session_busy'. We translate to the revanote skip vocabulary + reject
    // callback (always carries annotation_id).
    async markSkipped(_token, reason) {
      // session_busy comes from the queue drop; everything else is a gate block
      // (quota_threshold_reached / daily_cost_cap / revanote_budget_exceeded).
      const isBusy = reason === 'session_busy'
      await updateAnnotationStatus(ann.id, 'failed', {
        skip_reason: reason,
        session_id: sessionId,
        mapping_id: mapping?.id ?? null,
      })
      broadcastRevanoteEvent(userId, {
        type: 'revanote_skipped', annotation_id: ann.id, skip_reason: reason,
      })
      void enqueueRejectionCallback(ann, isBusy ? 'session_busy' : 'budget_threshold', reason)
    },
    // `runId` is the id returned by open(), threaded back by the pipeline. This
    // is the exact legacy `run-lifecycle.onAgentReply` body: envelope parse →
    // annotation status → merge gate → outbound callback enqueue.
    async onFinalize(runId, replyContent) {
      await finalizeAnnotationReply({
        sessionId,
        runId,
        annotationId: ann.id,
        userId,
        startedAt: openStartedAt,
        content: replyContent,
      })
    },
    async markFailed(runId, errMsg) {
      await updateAnnotationStatus(ann.id, 'failed', {
        skip_reason: `agent_send_failed: ${errMsg}`,
      })
      await updateAnnotationRun(runId, {
        status: 'failed', error: `agent_send: ${errMsg}`, finished_at: new Date(),
      })
    },
  }

  // Captured when open() fires so onFinalize can compute duration_ms with legacy
  // parity (it measured from run insert → reply).
  let openStartedAt = Date.now()
  const origOpen = store.open!
  store.open = async (req) => {
    openStartedAt = Date.now()
    return origOpen(req)
  }

  const deps: PipelineDeps = {
    // IR-1: cost-cap non-bypassable. IR-2: threshold → cost-cap → revanote-budget.
    // sessionInjectRateGate: an annotation flood must not drive N turns/hour into the
    // bound session — a rate ceiling, not just a $ / token one.
    gates: [thresholdGate, dailyCostCapGate, dailyTokenCapGate, sessionInjectRateGate, revanoteBudgetGate(userId, tz)],
    store,
    isOnline: (req) => getChannel(req.sessionId) != null,
    // Spawn-on-error (opt-in via REMO_SPAWN_ON_ERROR): when the bound session is
    // offline, lazy-START it via the supervisor before parking, so an offline-but-
    // mapped target auto-wakes on an inbound annotation. Runs only after the gate
    // list passes (cost-cap etc. stay non-bypassable); leak-safe + dormant by default.
    ensureOnline: (req) => ensureSessionOnline(req.userId, req.sessionId),
    // Offline replay: re-run the full dispatch for this pending annotation.
    replay: async () => {
      await dispatchPendingAnnotation(ann.id)
    },
    // Grace TTL lapse → legacy expire-mark (failed_offline/target_offline_expired).
    onParkExpire: async () => {
      await updateAnnotationStatus(ann.id, 'failed_offline', {
        skip_reason: 'target_offline_expired',
      })
    },
    // Ship the user_message: persist chat history, broadcast to subscribers,
    // then forward on the socket.
    send: async (req) => {
      const channel = getChannel(req.sessionId)
      if (!channel) throw new Error('session_offline')
      const msg = await insertMessage(req.sessionId, 'user', storedContent)
      broadcastToSubscribers(req.sessionId, {
        type: 'message', session_id: req.sessionId, message: msg,
      })
      channel.ws.send(
        JSON.stringify({ type: 'user_message', id: msg.id, content: req.prompt, ts: msg.created_at }),
      )
    },
  }

  const req: DispatchRequest = { userId, sessionId, token: ann.id, prompt: promptBody }
  const outcome = await dispatch(req, deps)

  switch (outcome.kind) {
    case 'dispatched':
      // Legacy parity: status='dispatched' + broadcast AFTER the send succeeds.
      // outcome.runId is the id open() returned (the real annotation_run id).
      await updateAnnotationStatus(ann.id, 'dispatched', {
        session_id: sessionId, mapping_id: mapping?.id ?? null, dispatched_at: new Date(),
      })
      broadcastRevanoteEvent(userId, {
        type: 'revanote_dispatched',
        annotation_id: ann.id,
        run_id: outcome.runId,
        session_id: sessionId,
        dispatched_at: new Date().toISOString(),
      })
      return { status: 'dispatched', run_id: outcome.runId, session_id: sessionId }
    case 'queued':
      // Stays pending; promotion re-dispatches via onSessionReply.
      return { status: 'queued' }
    case 'parked_offline':
      // Legacy parity: an offline target was marked 'pending'(session_offline)
      // and parked in grace. The pipeline parks for us (TTL lapse fires
      // onParkExpire → failed_offline); we own the immediate skip-mark +
      // broadcast here so the row reflects the offline state.
      await updateAnnotationStatus(ann.id, 'pending', {
        skip_reason: 'session_offline',
        session_id: sessionId,
        mapping_id: mapping?.id ?? null,
      })
      broadcastRevanoteEvent(userId, {
        type: 'revanote_skipped', annotation_id: ann.id, skip_reason: 'session_offline',
      })
      return { status: 'skipped', skip_reason: 'session_offline' }
    case 'dropped_busy':
      // markSkipped(session_busy) already fired inside the pipeline.
      return { status: 'skipped', skip_reason: 'session_busy' }
    case 'skipped':
      // markSkipped(reason) already fired inside the pipeline (gate block).
      return { status: 'skipped', skip_reason: outcome.reason }
    case 'failed':
      // markFailed already fired inside the pipeline.
      return { status: 'failed', skip_reason: 'agent_send_failed' }
  }
}

// Re-export for the comment_preview render path used by the webhook handler.
export { previewComment }
