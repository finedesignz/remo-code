/**
 * Per-session FIFO queue — BACK-COMPAT SHIM (Phase 1, C3).
 *
 * The queue implementation moved to `hub/src/dispatch/session-queue.ts` as the
 * `SessionQueue` class (instance-owned, no global mutable state, promotion via
 * return value). This module preserves the original FUNCTIONAL API verbatim by
 * delegating to a single shared `SessionQueue` instance, so `scheduler.test.ts`
 * — the contract — stays green unchanged and the un-migrated scheduler keeps
 * running on its own copy until its migration PR lands.
 *
 * The one piece that does NOT live in the class is the `setOnPromote` callback
 * seam (the very thing C3 kills). It stays HERE in the shim only, scoped to the
 * scheduler's legacy promotion path. When the scheduler migrates to the
 * pipeline's `onSessionReply`, this shim is deleted entirely.
 */
import { SessionQueue, type EnqueueResult } from '../dispatch/session-queue.ts'

export type { EnqueueResult }

const queue = new SessionQueue()

export function enqueue(sessionId: string, runId: string): EnqueueResult {
  return queue.enqueue(sessionId, runId)
}

export function markFinished(sessionId: string): string | null {
  return queue.markFinished(sessionId)
}

export function onSessionIdle(sessionId: string): string | null {
  return queue.markFinished(sessionId)
}

export function currentInFlight(sessionId: string): string | null {
  return queue.currentInFlight(sessionId)
}

type PromoteHandler = (sessionId: string, runId: string) => void
let onPromote: PromoteHandler | null = null
export function setOnPromote(handler: PromoteHandler | null): void {
  onPromote = handler
}

export function onSessionIdleAndPromote(sessionId: string): string | null {
  const runId = queue.markFinished(sessionId)
  if (runId && onPromote) {
    try {
      onPromote(sessionId, runId)
    } catch (err: any) {
      console.error(`[scheduler.queue] onPromote failed session=${sessionId} run=${runId}: ${err?.message}`)
    }
  }
  return runId
}

export function abandon(sessionId: string): void {
  queue.abandon(sessionId)
}

export function _reset(): void {
  queue._reset()
  onPromote = null
}
