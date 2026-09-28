/**
 * Per-session FIFO queue — instance form (Phase 1, C3 relocation).
 *
 * Each agent session admits AT MOST 1 in-flight run + `maxWaiters` FIFO
 * waiters (constructor arg; default 1, the dispatch pipeline uses a deeper
 * queue — see pipeline.ts). Further enqueues are dropped (the caller finalizes
 * the dropped token as `skipped(session_busy)`). When the in-flight run
 * finishes, `markFinished` promotes the oldest waiter and RETURNS its token (or
 * null) — the caller decides what to do with the promotion. No global mutable state, no `setOnPromote`
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
  /** FIFO waiters, oldest first. Bounded by the queue's `maxWaiters`. */
  waiters: string[]
  /** Date.now() when `inFlight` last transitioned from null → non-null. Used by
   *  the stale-lock reaper (orchestrator/stale-lock-reaper.ts) to detect a run
   *  that never called markFinished (dead/unauthed session — the lock would
   *  otherwise wedge forever). Null whenever `inFlight` is null. */
  inFlightSince: number | null
}

export class SessionQueue {
  private slots = new Map<string, Slot>()

  /**
   * @param maxWaiters how many runs may wait behind the in-flight one before
   *   further enqueues are dropped. Defaults to 1 (the original contract); the
   *   dispatch pipeline constructs its instance with a deeper queue so a burst
   *   (e.g. a Revanote review with 20+ comments on one repo) is serialized
   *   instead of dropped as `session_busy`.
   */
  constructor(private readonly maxWaiters: number = 1) {}

  private getOrCreate(sessionId: string): Slot {
    let s = this.slots.get(sessionId)
    if (!s) {
      s = { inFlight: null, waiters: [], inFlightSince: null }
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
    // Idempotent: a token already in flight or waiting is not queued twice
    // (Revanote's retry sweep re-sends the same annotation).
    if (s.inFlight === token || s.waiters.includes(token)) return 'queued'
    if (s.waiters.length < this.maxWaiters) {
      s.waiters.push(token)
      return 'queued'
    }
    return 'dropped'
  }

  /** Promote the oldest waiter to in-flight; returns the promoted token (or null). */
  markFinished(sessionId: string): string | null {
    const s = this.slots.get(sessionId)
    if (!s) return null
    s.inFlight = s.waiters.shift() ?? null
    if (s.inFlight === null) {
      this.slots.delete(sessionId)
      return null
    }
    s.inFlightSince = Date.now()
    return s.inFlight
  }

  /**
   * Free the in-flight slot WITHOUT claiming it for anyone, and hand back the
   * oldest waiter (removed from the queue) so the caller can re-dispatch it
   * through the full gate list. Its re-dispatch then claims the free slot via
   * `enqueue`. Returns null (and drops the empty slot) when nobody waits.
   */
  releaseAndTakeNext(sessionId: string): string | null {
    const s = this.slots.get(sessionId)
    if (!s) return null
    s.inFlight = null
    s.inFlightSince = null
    const next = s.waiters.shift() ?? null
    if (s.waiters.length === 0 && next === null) this.slots.delete(sessionId)
    return next
  }

  currentInFlight(sessionId: string): string | null {
    return this.slots.get(sessionId)?.inFlight ?? null
  }

  waiterCount(sessionId: string): number {
    return this.slots.get(sessionId)?.waiters.length ?? 0
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
