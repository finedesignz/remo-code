/**
 * term-writers.ts — "at most ONE live client writer per session" (fix/dup-pty-writer).
 *
 * WHY THIS EXISTS
 * ---------------
 * The PTY has exactly one stdin. The hub already arbitrates BETWEEN writer
 * CLASSES (xterm connection vs Telegram) with the per-session turn lock, but it
 * had no invariant on how many CLIENT connections could be writers for one
 * session at once. In prod (2026-07-12) a leaked `/ws/client` socket meant two
 * client writers drove one session: the turn lock ping-ponged between a holder
 * (`client:2454…`) and a queuer (`client:f146…`), the queue overflowed, and
 * Telegram's `acquire` never won ("Session busy — try again in a moment").
 *
 * THE INVARIANT: for a given session, the MOST RECENT client connection to
 * attach/write a terminal is THE client writer. Any earlier client writer is
 * SUPERSEDED — its turn-lock ownership + queued waiters are released, so a
 * stale/leaked connection can neither hold nor queue-spam the lock.
 *
 * This module RECORDS the claim; it does not by itself stop a superseded socket's
 * bytes. The write path (`ws/client.ts`) ENFORCES the invariant: after acquiring
 * the turn lock it re-checks `currentTermWriter(session) === writerId` and DROPS
 * the frame otherwise (`gate: 'not_current_writer'`). `acquire` awaits, so a
 * connection can be superseded while its frame sits in the queue — without that
 * post-acquire check a superseded writer could not WEDGE the lock but its bytes
 * would still reach PTY stdin.
 *
 * Last-writer-wins is deliberate: a user moving between tabs/devices must always
 * be able to take the keyboard. Only `client:*` writers are superseded here —
 * the Telegram writer is arbitrated by the turn lock alone and is never evicted
 * by this module, nor is it ever dropped by the client write path.
 *
 * Module-level Map (single-process hub), same shape as turn-lock.
 */
import { releaseWriterInSession, type WriterId } from '../telegram/turn-lock'

/** sessionId → the current client writer id (`client:<uuid>`). */
const writers = new Map<string, WriterId>()

export function isClientWriter(writerId: WriterId): boolean {
  return writerId.startsWith('client:')
}

/**
 * Claim `sessionId` for `writerId` (called on a client terminal attach/write).
 * When a DIFFERENT client connection held the claim, that stale writer is
 * released from the turn lock FOR THIS SESSION ONLY (holder → released +
 * promoted; queued waiters → resolved false) and its id is returned. Returns null
 * when nothing was superseded.
 *
 * Scoped, not the all-sessions `releaseByWriter`: one socket can legitimately
 * drive up to 12 sessions (grid view), and losing session A's claim must not drop
 * that socket's queued waiter on session B.
 */
export function claimTermWriter(sessionId: string, writerId: WriterId): WriterId | null {
  const prev = writers.get(sessionId)
  writers.set(sessionId, writerId)
  if (!prev || prev === writerId || !isClientWriter(prev)) return null
  releaseWriterInSession(sessionId, prev)
  return prev
}

/** The current client writer for `sessionId` (null when none). */
export function currentTermWriter(sessionId: string): WriterId | null {
  return writers.get(sessionId) ?? null
}

/** A client connection went away — drop every session claim it owned. */
export function dropTermWriter(writerId: WriterId): void {
  for (const [sessionId, id] of Array.from(writers.entries())) {
    if (id === writerId) writers.delete(sessionId)
  }
}

/** Test-only. */
export function _resetTermWritersForTests(): void {
  writers.clear()
}
