/**
 * fix/dup-pty-writer — HUB-SIDE invariant: at most ONE live client writer per session.
 *
 * PROD EVIDENCE (2026-07-12, session fe8a21be…):
 *   [turn-lock] queue overflow session=fe8a21be… — dropping oldest writer=client:f146a909…   (×26)
 *   [turn-lock] safety TTL fired session=fe8a21be… holder=client:24549199… — force-releasing
 *   → every Telegram message answered "Session busy — try again in a moment".
 *
 * Two client connections drove one PTY. The turn lock had no notion of "one
 * client writer per session", so the second connection queued a NEW waiter for
 * EVERY character, overflowed the bound (evicting the FIFO head — including
 * Telegram's waiter) and ping-ponged the lock with the first.
 *
 * The client-side leak is fixed in `useWebSocket` (web/test/pty-single-writer.test.tsx).
 * These are the hub's defence-in-depth guarantees:
 *   1. a writer that is already queued NEVER enqueues a second waiter (no queue spam);
 *   2. a new client writer SUPERSEDES the previous client writer (last-writer-wins),
 *      so a stale/leaked connection can neither hold nor starve the lock;
 *   3. Telegram can still acquire the turn — it is never superseded by this rule.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import {
  acquire,
  release,
  releaseByWriter,
  holder,
  queueDepth,
  _configureTurnLockForTests,
  _resetTurnLockForTests,
} from '../src/telegram/turn-lock.ts'
import {
  claimTermWriter,
  currentTermWriter,
  dropTermWriter,
  _resetTermWritersForTests,
} from '../src/ws/term-writers.ts'

const SESSION = 'fe8a21be-0000-0000-0000-000000000000'
const W1 = 'client:24549199-aaaa-bbbb-cccc-000000000001' // prod holder
const W2 = 'client:f146a909-aaaa-bbbb-cccc-000000000002' // prod queuer (leaked socket)
const TG = 'telegram'

beforeEach(() => {
  _resetTurnLockForTests()
  _resetTermWritersForTests()
  _configureTurnLockForTests({ queueBound: 16, ttlMs: 60_000 })
})
afterEach(() => {
  _resetTurnLockForTests()
  _resetTermWritersForTests()
})

describe('turn lock — a blocked writer never queue-spams (prod: 26× queue overflow)', () => {
  test('26 keystrokes from a queued writer produce ONE waiter, not 26', async () => {
    expect(await acquire(SESSION, W1)).toBe(true) // W1 holds

    // W2 streams a full word of keystrokes while blocked. Pre-fix each one
    // pushed its own waiter → the bounded queue overflowed and dropped the head.
    const pending = Array.from({ length: 26 }, () => acquire(SESSION, W2))
    await Promise.resolve()

    expect(queueDepth(SESSION)).toBe(1)

    // …and every one of those awaits is satisfied by the single grant.
    release(SESSION)
    expect(holder(SESSION)).toBe(W2)
    expect(await Promise.all(pending)).toEqual(Array(26).fill(true))
  })

  test("a queued writer's spam cannot evict Telegram's waiter (the 'Session busy' wedge)", async () => {
    _configureTurnLockForTests({ queueBound: 4, ttlMs: 60_000 })
    expect(await acquire(SESSION, W1)).toBe(true)

    const tgTurn = acquire(SESSION, TG) // Telegram queues FIRST
    const spam = Array.from({ length: 40 }, () => acquire(SESSION, W2))
    await Promise.resolve()

    // Telegram is still in the queue — it was never overflowed out.
    expect(queueDepth(SESSION)).toBe(2)

    release(SESSION) // W1's turn completes → Telegram is promoted, in FIFO order
    expect(holder(SESSION)).toBe(TG)
    expect(await tgTurn).toBe(true)

    release(SESSION)
    expect(await Promise.all(spam)).toEqual(Array(40).fill(true))
  })
})

describe('single client writer per session — last-writer-wins supersede', () => {
  test('a second client writer SUPERSEDES the first: one writer, one PTY write per keystroke', async () => {
    // Connection 1 attaches + holds the turn.
    expect(claimTermWriter(SESSION, W1)).toBeNull()
    expect(await acquire(SESSION, W1)).toBe(true)
    expect(holder(SESSION)).toBe(W1)

    // Connection 2 (the leaked/second socket, or a new tab) writes. It takes the
    // claim, and W1 is released from the lock instead of ping-ponging with it.
    expect(claimTermWriter(SESSION, W2)).toBe(W1)
    expect(currentTermWriter(SESSION)).toBe(W2)
    expect(await acquire(SESSION, W2)).toBe(true)

    expect(holder(SESSION)).toBe(W2)
    expect(queueDepth(SESSION)).toBe(0) // no ping-pong, no queued waiters
  })

  test('a superseded writer that is still alive cannot starve the lock or Telegram', async () => {
    claimTermWriter(SESSION, W1)
    await acquire(SESSION, W1)
    claimTermWriter(SESSION, W2)
    await acquire(SESSION, W2) // W2 is now the sole client writer + holder

    // Telegram still arbitrates normally against the single client writer.
    const tgTurn = acquire(SESSION, TG)
    await Promise.resolve()
    expect(queueDepth(SESSION)).toBe(1)
    release(SESSION)
    expect(await tgTurn).toBe(true)
    expect(holder(SESSION)).toBe(TG)
  })

  test('Telegram is NEVER superseded by a client claim (human-only arbitration preserved)', async () => {
    expect(await acquire(SESSION, TG)).toBe(true)
    // A client claiming the session must not evict the Telegram holder.
    expect(claimTermWriter(SESSION, W1)).toBeNull()
    expect(holder(SESSION)).toBe(TG)
  })

  test('closing a connection drops its claim (dropTermWriter + releaseByWriter)', async () => {
    claimTermWriter(SESSION, W1)
    await acquire(SESSION, W1)

    releaseByWriter(W1)
    dropTermWriter(W1)

    expect(currentTermWriter(SESSION)).toBeNull()
    expect(holder(SESSION)).toBeNull()

    // The next connection starts clean.
    expect(claimTermWriter(SESSION, W2)).toBeNull()
    expect(await acquire(SESSION, W2)).toBe(true)
  })
})
