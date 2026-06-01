/**
 * Phase 20 plan 04 — per-session PTY write-arbitration turn lock (R-TG-10).
 *
 * Two writers feed one tmux-backed PTY stdin: the web xterm panel
 * (`/ws/client` term.input) and the Telegram bridge (keystroke injection). Their
 * keystrokes must NOT interleave mid-turn or the TUI receives garbled/unintended
 * input (T-20-10). This module is the single-writer arbiter held in the hub.
 *
 * THE ARBITRATION RULE
 * --------------------
 *   - A new HUMAN TURN (a fresh prompt/keystroke that starts work) must ACQUIRE
 *     the per-session turn lock before its bytes reach PTY stdin.
 *   - The first acquirer becomes the HOLDER and may write. Any other writer that
 *     wants to start a turn while the lock is held is QUEUED (bounded FIFO).
 *   - The lock RELEASES only on an OBSERVED `turn_complete` for that session
 *     (the transcript assistant-entry / result; or a TUI prompt-ready marker in
 *     scrape fallback) — completion is the only safe arbiter when two writers
 *     feed one TUI. A generous safety TTL backstops a missed turn_complete so the
 *     session can't wedge (T-20-11). On release the next queued writer is
 *     promoted (granted the turn).
 *   - A PERMISSION/QUESTION RESPONSE is EXEMPT from acquire — answering an
 *     in-flight prompt completes the holder's current turn rather than starting a
 *     new one; treating it as a new turn would deadlock (T-20-12). It is written
 *     immediately, regardless of who holds the turn.
 *   - The queue is bounded; on overflow the OLDEST waiter is dropped with a
 *     logged notice (the lock can't grow unbounded).
 *
 * Module-level Map (single-process hub). Redis is a future seam, same shape.
 */

const DEFAULT_QUEUE_BOUND = 16
const DEFAULT_TTL_MS = 10 * 60 * 1000 // 10 min safety backstop

export type WriterId = string // a client connection id, or 'telegram'

interface Waiter {
  writerId: WriterId
  resolve: (granted: boolean) => void
  enqueuedAtMs: number
}

interface LockState {
  holder: WriterId
  acquiredAtMs: number
  queue: Waiter[]
  ttlTimer: ReturnType<typeof setTimeout> | null
}

const locks = new Map<string, LockState>()

let queueBound = DEFAULT_QUEUE_BOUND
let ttlMs = DEFAULT_TTL_MS

/** Test-only — tune the queue bound + TTL. */
export function _configureTurnLockForTests(opts: { queueBound?: number; ttlMs?: number }): void {
  if (opts.queueBound !== undefined) queueBound = opts.queueBound
  if (opts.ttlMs !== undefined) ttlMs = opts.ttlMs
}

/** Test-only — reset all locks + config. */
export function _resetTurnLockForTests(): void {
  for (const st of locks.values()) {
    if (st.ttlTimer) clearTimeout(st.ttlTimer)
    for (const w of st.queue) w.resolve(false)
  }
  locks.clear()
  queueBound = DEFAULT_QUEUE_BOUND
  ttlMs = DEFAULT_TTL_MS
}

function armTtl(sessionId: string, st: LockState): void {
  if (st.ttlTimer) clearTimeout(st.ttlTimer)
  st.ttlTimer = setTimeout(() => {
    console.warn(`[turn-lock] safety TTL fired session=${sessionId} holder=${st.holder} — force-releasing`)
    release(sessionId)
  }, ttlMs)
}

/**
 * Acquire the turn for `writerId` on `sessionId`. Resolves `true` immediately
 * when the lock is free (the caller becomes holder). When held by ANOTHER
 * writer, the caller is queued (FIFO) and the promise resolves `true` when it is
 * later promoted to holder, or `false` if it was dropped (queue overflow / reset).
 * Re-acquire by the CURRENT holder resolves `true` immediately (idempotent — the
 * same writer streaming more keystrokes within its turn).
 */
export function acquire(sessionId: string, writerId: WriterId): Promise<boolean> {
  const st = locks.get(sessionId)
  if (!st) {
    const fresh: LockState = { holder: writerId, acquiredAtMs: Date.now(), queue: [], ttlTimer: null }
    locks.set(sessionId, fresh)
    armTtl(sessionId, fresh)
    return Promise.resolve(true)
  }
  if (st.holder === writerId) return Promise.resolve(true)
  // Held by another writer → queue (bounded).
  return new Promise<boolean>((resolve) => {
    const waiter: Waiter = { writerId, resolve, enqueuedAtMs: Date.now() }
    st.queue.push(waiter)
    if (st.queue.length > queueBound) {
      const dropped = st.queue.shift()!
      console.warn(`[turn-lock] queue overflow session=${sessionId} — dropping oldest writer=${dropped.writerId}`)
      dropped.resolve(false)
    }
  })
}

/**
 * Release the turn for `sessionId`. Promotes the next queued waiter (if any) to
 * holder and grants it. Idempotent / safe when no lock exists.
 */
export function release(sessionId: string): void {
  const st = locks.get(sessionId)
  if (!st) return
  if (st.ttlTimer) {
    clearTimeout(st.ttlTimer)
    st.ttlTimer = null
  }
  const next = st.queue.shift()
  if (next) {
    st.holder = next.writerId
    st.acquiredAtMs = Date.now()
    armTtl(sessionId, st)
    next.resolve(true)
  } else {
    locks.delete(sessionId)
  }
}

/**
 * The transcript turn_complete signal for `sessionId` — releases the lock +
 * dequeues the next writer. This is the SAME observation the bridge already
 * tails (one transcript signal, two consumers). Wired by the turn-lock consumer
 * the manager/bridge registers.
 */
export function onTurnComplete(sessionId: string): void {
  release(sessionId)
}

/** Who currently holds the turn for `sessionId` (null when free). For UI/Telegram
 *  "who holds the turn" status. */
export function holder(sessionId: string): WriterId | null {
  return locks.get(sessionId)?.holder ?? null
}

/** Current queue depth for `sessionId` (diagnostics). */
export function queueDepth(sessionId: string): number {
  return locks.get(sessionId)?.queue.length ?? 0
}

/**
 * A permission/question RESPONSE bypasses the turn lock entirely (T-20-12): it
 * completes the holder's in-flight turn rather than starting a new one. This is a
 * no-op marker the relay/injector calls to make the exemption explicit + auditable
 * — it never queues, never blocks. Returns true always (allowed).
 */
export function allowResponseBypass(_sessionId: string): boolean {
  return true
}
