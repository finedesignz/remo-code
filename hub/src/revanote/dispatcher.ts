/**
 * Revanote dispatcher (Phase 08).
 *
 * Resolves a session for the annotation's mapping, applies cost/threshold/
 * per-source budget gates, claims the per-session queue, and ships the
 * annotation as a `user_message` to Claude — same pipeline as error-capture
 * (`error-capture/dispatcher.ts`).
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
import * as queue from '../scheduler/session-queue.ts'
import { checkUserThreshold } from '../usage/threshold.ts'
import { renderAnnotationPrompt, storagePrefix, previewComment } from './prompt.ts'
import { registerAnnotationRunForSession } from './run-lifecycle.ts'

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
 * Per-source budget gate. Treats `users.revanote_budget_pct` (default 60)
 * as a percentage of the daily cap. When today's revanote-attributed cost
 * already meets-or-exceeds that fraction, refuse new dispatches with
 * `revanote_budget_exceeded`.
 */
async function isOverRevanoteBudget(userId: string, timezone: string): Promise<{ over: boolean; cap: number; spent: number }> {
  const rows = await sql<{ cap: string; pct: number | null }[]>`
    SELECT daily_cost_cap_usd::text AS cap, revanote_budget_pct AS pct
      FROM users WHERE id = ${userId} LIMIT 1
  `
  const cap = Number(rows[0]?.cap ?? 10)
  if (!Number.isFinite(cap) || cap <= 0) return { over: false, cap: 0, spent: 0 }
  const pct = rows[0]?.pct ?? 60
  const sourceCap = cap * (pct / 100)
  const spent = await sumTodayAnnotationCostForUser(userId, timezone)
  return { over: spent >= sourceCap, cap: sourceCap, spent }
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

  // Resolve mapping (host → repo_path + deploy strategy).
  const host = hostOf(ann.page_url)
  const mapping = await resolveRevanoteMappingForHost(userId, host)

  // 1. Quota threshold gate.
  const threshold = await checkUserThreshold(userId)
  if (!threshold.allowed) {
    const reason = `quota_threshold_reached:${threshold.reason}`
    await updateAnnotationStatus(ann.id, 'failed', { skip_reason: reason })
    broadcastRevanoteEvent(userId, {
      type: 'revanote_skipped', annotation_id: ann.id, skip_reason: reason,
    })
    void enqueueRejectionCallback(ann, 'budget_threshold', reason)
    return { status: 'skipped', skip_reason: reason }
  }

  // 2. Per-source revanote budget gate.
  const budget = await isOverRevanoteBudget(userId, tz)
  if (budget.over) {
    const reason = `revanote_budget_exceeded:spent=${budget.spent.toFixed(4)}>=cap=${budget.cap.toFixed(4)}`
    await updateAnnotationStatus(ann.id, 'failed', { skip_reason: reason })
    broadcastRevanoteEvent(userId, {
      type: 'revanote_skipped', annotation_id: ann.id, skip_reason: reason,
    })
    void enqueueRejectionCallback(ann, 'budget_threshold', reason)
    return { status: 'skipped', skip_reason: reason }
  }

  // 3. Session resolution.
  const sessionId = ann.session_id || (await resolveSessionId(userId, mapping))
  if (!sessionId) {
    const reason = mapping ? 'session_not_found_for_repo' : 'no_mapping_for_host'
    await updateAnnotationStatus(ann.id, 'failed', {
      skip_reason: reason, mapping_id: mapping?.id ?? null,
    })
    broadcastRevanoteEvent(userId, {
      type: 'revanote_skipped', annotation_id: ann.id, skip_reason: reason,
    })
    void enqueueRejectionCallback(ann, 'no_target', reason)
    return { status: 'failed', skip_reason: reason }
  }

  // 4. Channel online?
  const channel = getChannel(sessionId)
  if (!channel) {
    const { register: graceRegister } = await import('./grace.ts')
    graceRegister(sessionId, ann.id)
    await updateAnnotationStatus(ann.id, 'pending', {
      skip_reason: 'session_offline',
      session_id: sessionId,
      mapping_id: mapping?.id ?? null,
    })
    broadcastRevanoteEvent(userId, {
      type: 'revanote_skipped', annotation_id: ann.id, skip_reason: 'session_offline',
    })
    return { status: 'skipped', skip_reason: 'session_offline' }
  }

  // 5. Per-session queue claim.
  const claim = queue.enqueue(sessionId, ann.id)
  if (claim === 'dropped') {
    await updateAnnotationStatus(ann.id, 'failed', {
      skip_reason: 'session_busy', session_id: sessionId, mapping_id: mapping?.id ?? null,
    })
    broadcastRevanoteEvent(userId, {
      type: 'revanote_skipped', annotation_id: ann.id, skip_reason: 'session_busy',
    })
    void enqueueRejectionCallback(ann, 'session_busy', 'session_busy')
    return { status: 'skipped', skip_reason: 'session_busy' }
  }
  if (claim === 'queued') {
    // Stays pending — queue promotion will re-enter via the agent assistant_message hook.
    return { status: 'queued' }
  }

  // 6. Insert run row + register lifecycle BEFORE sending so a fast reply is not lost.
  const run = await insertAnnotationRun({
    annotation_id: ann.id, user_id: userId, session_id: sessionId,
  })
  registerAnnotationRunForSession(sessionId, run.id, ann.id, userId, ann.callback_url)

  // 7. Build prompt + persist as user message + forward to agent.
  const promptBody = renderAnnotationPrompt({ annotation: ann, mapping })
  const stored = `${storagePrefix(ann.comment)}\n\n${promptBody}`
  let msg: { id: string; created_at: string } | null = null
  try {
    msg = await insertMessage(sessionId, 'user', stored)
  } catch (err: any) {
    await updateAnnotationStatus(ann.id, 'failed', {
      skip_reason: `insert_message_failed: ${err?.message}`,
    })
    await updateAnnotationRun(run.id, {
      status: 'failed', error: `insert_message: ${err?.message}`, finished_at: new Date(),
    })
    queue.markFinished(sessionId)
    return { status: 'failed', skip_reason: 'insert_message_failed' }
  }

  // Broadcast so any open chat view shows the message immediately.
  broadcastToSubscribers(sessionId, {
    type: 'message', session_id: sessionId, message: msg,
  })

  try {
    channel.ws.send(JSON.stringify({
      type: 'user_message', id: msg.id, content: promptBody, ts: msg.created_at,
    }))
  } catch (err: any) {
    await updateAnnotationStatus(ann.id, 'failed', {
      skip_reason: `agent_send_failed: ${err?.message}`,
    })
    await updateAnnotationRun(run.id, {
      status: 'failed', error: `agent_send: ${err?.message}`, finished_at: new Date(),
    })
    queue.markFinished(sessionId)
    return { status: 'failed', skip_reason: 'agent_send_failed' }
  }

  await updateAnnotationStatus(ann.id, 'dispatched', {
    session_id: sessionId, mapping_id: mapping?.id ?? null, dispatched_at: new Date(),
  })
  broadcastRevanoteEvent(userId, {
    type: 'revanote_dispatched',
    annotation_id: ann.id,
    run_id: run.id,
    session_id: sessionId,
    dispatched_at: new Date().toISOString(),
  })
  return { status: 'dispatched', run_id: run.id, session_id: sessionId }
}

/**
 * Helper: queue an immediate callback for a pre-dispatch rejection. Loaded
 * lazily so test environments without the callback module loaded don't crash.
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

// Re-export for the comment_preview render path used by the webhook handler.
export { previewComment }
