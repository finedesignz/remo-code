/**
 * Per-session FIFO queue (W2/T6).
 *
 * Each agent session admits AT MOST 1 in-flight scheduled run + 1 waiter.
 * Further enqueues are dropped (caller finalizes as `skipped(session_busy)`).
 *
 * When the agent goes idle (thinking→online), `onSessionIdleAndPromote`
 * promotes the waiter and notifies the registered handler so the dispatcher
 * can ship it. Wiring lives in `hub/src/ws/agent.ts` (status='idle' branch).
 */

export type EnqueueResult = 'dispatched' | 'queued' | 'dropped'

interface Slot { inFlight: string | null; waiter: string | null }
const slots = new Map<string, Slot>()

function getOrCreate(sessionId: string): Slot {
  let s = slots.get(sessionId)
  if (!s) { s = { inFlight: null, waiter: null }; slots.set(sessionId, s) }
  return s
}

export function enqueue(sessionId: string, runId: string): EnqueueResult {
  const s = getOrCreate(sessionId)
  if (s.inFlight === null) { s.inFlight = runId; return 'dispatched' }
  if (s.waiter === null) { s.waiter = runId; return 'queued' }
  return 'dropped'
}

export function markFinished(sessionId: string): string | null {
  const s = slots.get(sessionId)
  if (!s) return null
  s.inFlight = s.waiter
  s.waiter = null
  if (s.inFlight === null) { slots.delete(sessionId); return null }
  return s.inFlight
}

export function onSessionIdle(sessionId: string): string | null {
  return markFinished(sessionId)
}

export function currentInFlight(sessionId: string): string | null {
  return slots.get(sessionId)?.inFlight ?? null
}

type PromoteHandler = (sessionId: string, runId: string) => void
let onPromote: PromoteHandler | null = null
export function setOnPromote(handler: PromoteHandler | null): void { onPromote = handler }

export function onSessionIdleAndPromote(sessionId: string): string | null {
  const runId = markFinished(sessionId)
  if (runId && onPromote) {
    try { onPromote(sessionId, runId) }
    catch (err: any) {
      console.error(`[scheduler.queue] onPromote failed session=${sessionId} run=${runId}: ${err?.message}`)
    }
  }
  return runId
}

export function abandon(sessionId: string): void { slots.delete(sessionId) }
export function _reset(): void { slots.clear() }
