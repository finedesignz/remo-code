/**
 * Error-run lifecycle (W3/T3).
 *
 * Mirrors the scheduler's `pendingTurns` pattern in `senders/agent.ts`. When
 * an error-capture dispatcher ships a prompt to a Claude session it registers
 * the (sessionId → run_id) here. The agent ws assistant_message handler calls
 * `onAgentReply` to finalize the run as success, capture the output snippet,
 * and promote any queue waiter.
 *
 * Only ONE active error-run per session at a time (the session-queue enforces
 * this upstream). The map is the source of truth for "is the next
 * assistant_message landing on this session ours?".
 */
import { updateErrorRunStatus } from '../db/error-capture-dal.ts'
import { broadcastErrorEvent } from '../ws/registry.ts'
import * as queue from '../scheduler/session-queue.ts'

interface ActiveRun {
  runId: string
  errorId: string
  userId: string
  projectId: string
  startedAt: number
}

const bySession = new Map<string, ActiveRun>()

export function registerErrorRunForSession(
  sessionId: string,
  runId: string,
  errorId: string,
  userId: string,
  projectId: string,
): void {
  bySession.set(sessionId, { runId, errorId, userId, projectId, startedAt: Date.now() })
}

export function errorRunActiveForSession(sessionId: string): boolean {
  return bySession.has(sessionId)
}

export function getActiveErrorRun(sessionId: string): ActiveRun | undefined {
  return bySession.get(sessionId)
}

export async function onAgentReply(sessionId: string, content: string): Promise<void> {
  const active = bySession.get(sessionId)
  if (!active) return
  bySession.delete(sessionId)

  const duration = Date.now() - active.startedAt
  const snippet = content.length > 500 ? content.slice(content.length - 500) : content
  // cost_usd left null — agent stream protocol doesn't carry per-turn cost.
  await updateErrorRunStatus(active.runId, {
    status: 'success',
    finished_at: new Date(),
    output_snippet: snippet,
  })

  broadcastErrorEvent(active.userId, {
    type: 'error_run_finished',
    error_id: active.errorId,
    project_id: active.projectId,
    run_id: active.runId,
    status: 'success',
    output_snippet: snippet,
    cost_usd: null,
    duration_ms: duration,
    finished_at: new Date().toISOString(),
  })

  // Promote any waiter on this session's error-dispatch queue.
  const promoted = queue.markFinished(sessionId)
  if (promoted) {
    // The waiter is another errorId — re-dispatch it. Late import avoids cycle.
    void import('./dispatcher.ts').then((m) =>
      m.dispatchPendingError(promoted).catch((err) => {
        console.error(`[error-capture.lifecycle] promote dispatch failed run=${promoted}: ${err?.message ?? err}`)
      }),
    )
  }
}

export async function onAgentError(sessionId: string, errorMsg: string): Promise<void> {
  const active = bySession.get(sessionId)
  if (!active) return
  bySession.delete(sessionId)

  await updateErrorRunStatus(active.runId, {
    status: 'failed',
    finished_at: new Date(),
    error: errorMsg,
  })
  broadcastErrorEvent(active.userId, {
    type: 'error_run_finished',
    error_id: active.errorId,
    project_id: active.projectId,
    run_id: active.runId,
    status: 'failed',
    error: errorMsg,
    finished_at: new Date().toISOString(),
  })

  const promoted = queue.markFinished(sessionId)
  if (promoted) {
    void import('./dispatcher.ts').then((m) =>
      m.dispatchPendingError(promoted).catch(() => {}),
    )
  }
}
