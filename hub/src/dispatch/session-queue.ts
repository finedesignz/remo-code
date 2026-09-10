/**
 * Per-session FIFO queue — instance form (Phase 1, C3 relocation).
 *
 * Each agent session admits AT MOST 1 in-flight run + 1 waiter. Further
 * enqueues are dropped (the caller finalizes the dropped token as
 * `skipped(session_busy)`). When the in-flight run finishes, `markFinished`
 * promotes the waiter and RETURNS its token (or null) — the caller decides
 * what to do with the promotion. No global mutable state, no `setOnPromote`
 * callback seam: the queue is an instance owned by the dispatch pipeline.
 *
 * Semantics are byte-identical to the original `scheduler/session-queue.ts`
 * functional API (`enqueue` → dispatched/queued/dropped; `markFinished`
 * promotes the waiter). That back-compat shim was deleted in the Round-2
 * collapse; this class is now the single source of truth and is exercised
 * directly by `hub/test/session-queue.test.ts`.
 */

export type EnqueueResult = 'dispatched' | 'queued' | 'dropped'

interface Slot {
  inFlight: string | null
  waiter: string | null
  /** Date.now() when `inFlight` last transitioned from null → non-null. Used by
   *  the stale-lock reaper (orchestrator/stale-lock-reaper.ts) to detect a run
   *  that never called markFinished (dead/unauthed session — the lock would
   *  otherwise wedge forever). Null whenever `inFlight` is null. */
  inFlightSince: number | null
}

export class SessionQueue {
  private slots = new Map<string, Slot>()

  private getOrCreate(sessionId: string): Slot {
    let s = this.slots.get(sessionId)
    if (!s) {
      s = { inFlight: null, waiter: null, inFlightSince: null }
      this.slots.set(sessionId, s)
    }
    return s
  }

  enqueue(sessionId: string, token: string): EnqueueResult {
    const s = this.getOrCreate(sessionId)
    if (s.inFlight === null) {
      s.inFlight = token
      s.inFlightSince = Date.now()
      return 'dispatched'
    }
    if (s.waiter === null) {
      s.waiter = token
      return 'queued'
    }
    return 'dropped'
  }

  /** Promote the waiter to in-flight; returns the promoted token (or null). */
  markFinished(sessionId: string): string | null {
    const s = this.slots.get(sessionId)
    if (!s) return null
    s.inFlight = s.waiter
    s.waiter = null
    if (s.inFlight === null) {
      this.slots.delete(sessionId)
      return null
    }
    s.inFlightSince = Date.now()
    return s.inFlight
  }

  currentInFlight(sessionId: string): string | null {
    return this.slots.get(sessionId)?.inFlight ?? null
  }

  /** Age (ms) of the current in-flight lock, or null if no lock is held. */
  inFlightAgeMs(sessionId: string, now: number = Date.now()): number | null {
    const s = this.slots.get(sessionId)
    if (!s || s.inFlight === null || s.inFlightSince === null) return null
    return now - s.inFlightSince
  }

  /** SessionIds whose in-flight lock has been held ≥ `maxAgeMs` (stale-lock reaper). */
  staleInFlight(maxAgeMs: number, now: number = Date.now()): string[] {
    const stale: string[] = []
    for (const [sessionId, s] of this.slots) {
      if (s.inFlight !== null && s.inFlightSince !== null && now - s.inFlightSince >= maxAgeMs) {
        stale.push(sessionId)
      }
    }
    return stale
  }

  abandon(sessionId: string): void {
    this.slots.delete(sessionId)
  }

  /** Test helper — clear all slots. */
  _reset(): void {
    this.slots.clear()
  }
}
