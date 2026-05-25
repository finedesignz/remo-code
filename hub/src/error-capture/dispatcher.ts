/**
 * Error-capture dispatcher (W3/T2).
 *
 * Picks up a `pending` error row inserted by `recordError`, resolves the
 * project's bound agent socket, and ships the error to Claude as a
 * `user_message` via the same path the scheduler uses. Honors the per-session
 * queue (max 1 in-flight + 1 waiter). Offline targets are parked in the
 * 10-min grace buffer (see ./grace.ts).
 *
 * State machine:
 *   1. Load error + project, validate dispatch_status === 'pending' (idempotent).
 *   2. Resolve agent socket via ws registry.
 *   3. Offline   → grace.register, status='skipped(session_offline)', notify.
 *   4. queue=dropped → status='skipped(session_busy)', notify dispatch_failed.
 *   5. queue=queued → leave pending; queue promote will call us again.
 *   6. queue=dispatched → insert error_run, send prompt, mark dispatched,
 *      register run-lifecycle hook for assistant_message finalize.
 *
 * Hooked into recordError as a fire-and-forget tail (no await; we never
 * block the intake POST).
 */
import {
  getErrorProject,
  insertErrorRun,
  updateErrorDispatchStatus,
  updateErrorRunStatus,
} from '../db/error-capture-dal.ts'
import { sql } from '../db/postgres.ts'
import type { ErrorProject, ErrorRow } from '../db/error-capture-dal.ts'
import { getChannel, broadcastErrorEvent } from '../ws/registry.ts'
import { insertMessage } from '../db/dal.ts'
import * as queue from '../scheduler/session-queue.ts'
import { notifyThrottled } from './notify.ts'
import { buildErrorMessage } from './prompt.ts'
import { registerErrorRunForSession } from './run-lifecycle.ts'

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

  // Project resolution. We use the DAL's user-scoped getter via a secondary
  // unscoped lookup (the project owner is on the project row itself).
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
  const channel = getChannel(sessionId)

  // 3. Offline target → grace + skip.
  if (!channel) {
    const grace = await import('./grace.ts')
    grace.register(sessionId, errorId)
    await updateErrorDispatchStatus(errorId, 'skipped', 'session_offline')
    void notifyThrottled(
      'session_offline',
      `${project.id}:${sessionId}`,
      1800,
      project,
      { error_type: error.error_type, error_value: error.error_value },
    ).catch(() => {})
    broadcastErrorEvent(userId, {
      type: 'error_skipped',
      error_id: errorId,
      project_id: project.id,
      dispatch_status: 'skipped',
      skip_reason: 'session_offline',
    })
    return { status: 'skipped', skip_reason: 'session_offline' }
  }

  // 4. Per-session queue claim.
  const claim = queue.enqueue(sessionId, errorId)
  if (claim === 'dropped') {
    await updateErrorDispatchStatus(errorId, 'skipped', 'session_busy')
    void notifyThrottled(
      'dispatch_failed',
      `${project.id}:${sessionId}:busy`,
      900,
      project,
      { error_type: error.error_type, error_value: error.error_value, detail: 'session_busy' },
    ).catch(() => {})
    broadcastErrorEvent(userId, {
      type: 'error_skipped',
      error_id: errorId,
      project_id: project.id,
      dispatch_status: 'skipped',
      skip_reason: 'session_busy',
    })
    return { status: 'skipped', skip_reason: 'session_busy' }
  }
  if (claim === 'queued') {
    // Stays pending — queue promotion will re-enter this function.
    return { status: 'queued' }
  }

  // 5. Insert run row + register lifecycle hook BEFORE we send, so the
  //    assistant_message handler can finalize even on a fast reply.
  const run = await insertErrorRun(errorId, project.id, sessionId)
  await updateErrorRunStatus(run.id, { status: 'in_flight', started_at: new Date() })
  registerErrorRunForSession(sessionId, run.id, errorId, userId, project.id)

  // 6. Build prompt + persist as user message so it appears in chat history,
  //    then forward to the agent over the existing user_message wire.
  const content = buildErrorMessage(error, project)
  const storedContent = `[error: ${project.name} — ${error.error_type}]\n\n${content}`
  let msg: { id: string; created_at: string } | null = null
  try {
    msg = await insertMessage(sessionId, 'user', storedContent)
  } catch (err: any) {
    await updateErrorDispatchStatus(errorId, 'failed', `insert_message: ${err?.message}`)
    await updateErrorRunStatus(run.id, { status: 'failed', error: `insert_message: ${err?.message}`, finished_at: new Date() })
    queue.markFinished(sessionId)
    return { status: 'failed', skip_reason: 'insert_message_failed' }
  }

  try {
    channel.ws.send(JSON.stringify({
      type: 'user_message',
      id: msg.id,
      content,
      ts: msg.created_at,
    }))
  } catch (err: any) {
    await updateErrorDispatchStatus(errorId, 'failed', `agent_send: ${err?.message}`)
    await updateErrorRunStatus(run.id, { status: 'failed', error: `agent_send: ${err?.message}`, finished_at: new Date() })
    queue.markFinished(sessionId)
    void notifyThrottled(
      'dispatch_failed',
      `${project.id}:${sessionId}:send`,
      900,
      project,
      { error_type: error.error_type, error_value: error.error_value, detail: err?.message },
    ).catch(() => {})
    return { status: 'failed', skip_reason: 'agent_send_failed' }
  }

  await updateErrorDispatchStatus(errorId, 'dispatched')
  broadcastErrorEvent(userId, {
    type: 'error_dispatched',
    error_id: errorId,
    project_id: project.id,
    run_id: run.id,
    dispatched_at: new Date().toISOString(),
  })

  return { status: 'dispatched', run_id: run.id }
}
