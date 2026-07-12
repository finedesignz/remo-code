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

/**
 * THE WRITE PATH (hub/src/ws/client.ts). Claiming alone only stops a stale socket
 * from WEDGING the lock — it does not MUZZLE it. `acquire` awaits, so a connection
 * can be superseded WHILE its frame sits in the turn-lock queue; without the
 * post-acquire `currentTermWriter === writerId` re-check the loser's bytes still
 * reach PTY stdin (the prod two-writer ingress). These tests assert on what
 * actually lands on the agent channel.
 *
 * `relayTermInput` mirrors client.ts's write-turn tail EXACTLY: claim → acquire →
 * drop-if-not-current-writer → send. Telegram is not a client writer and is never
 * subjected to the drop.
 */
describe('write path — a superseded client connection is DROPPED, not relayed', () => {
  /** Bytes that reached the (fake) PTY channel, in order. */
  let pty: Array<{ writer: string; data: string }>
  const send = (writer: string, data: string) => { pty.push({ writer, data }) }

  beforeEach(() => { pty = [] })

  /** The client.ts write-turn tail for a term.input frame. */
  async function relayTermInput(sessionId: string, writerId: string, data: string): Promise<boolean> {
    claimTermWriter(sessionId, writerId)
    const granted = await acquire(sessionId, writerId)
    if (!granted) return false
    // gate: 'not_current_writer' — superseded while queued.
    if (currentTermWriter(sessionId) !== writerId) return false
    send(writerId, data)
    return true
  }

  /** Telegram's path: turn lock only, no client-writer claim/drop. */
  async function relayTelegram(sessionId: string, data: string): Promise<boolean> {
    const granted = await acquire(sessionId, TG)
    if (!granted) return false
    send(TG, data)
    return true
  }

  test('a frame queued by W1 and superseded by W2 mid-await never reaches the PTY', async () => {
    // W1 holds the lock and starts a keystroke that must queue behind itself…
    expect(await acquire(SESSION, W1)).toBe(true)
    claimTermWriter(SESSION, W1)
    const w1Frame = relayTermInput(SESSION, W1, 'a') // queues (W1 already holds)

    // …while it is queued, the OTHER live socket (the leak) writes and supersedes W1.
    const w2Frame = relayTermInput(SESSION, W2, 'b')
    await Promise.resolve()
    release(SESSION) // W1's original turn completes → queue drains

    expect(await w1Frame).toBe(false) // DROPPED: W1 is no longer the current writer
    expect(await w2Frame).toBe(true) // the current writer IS relayed

    // Exactly ONE byte reached stdin — not the doubled write prod saw.
    expect(pty).toEqual([{ writer: W2, data: 'b' }])
  })

  test('the current writer relays normally; only the superseded one is muzzled', async () => {
    expect(await relayTermInput(SESSION, W1, 'x')).toBe(true)
    release(SESSION)
    expect(await relayTermInput(SESSION, W2, 'y')).toBe(true) // W2 supersedes, relays
    release(SESSION)
    expect(await relayTermInput(SESSION, W2, 'z')).toBe(true) // still current
    release(SESSION)

    expect(pty).toEqual([
      { writer: W1, data: 'x' },
      { writer: W2, data: 'y' },
      { writer: W2, data: 'z' },
    ])
    expect(currentTermWriter(SESSION)).toBe(W2)
  })

  test('a still-live superseded socket keystroking cannot double-write the PTY', async () => {
    await relayTermInput(SESSION, W2, 'b') // W2 is the current writer
    release(SESSION)

    // The leaked W1 socket is still open, authed and subscribed — it keeps sending.
    // Last-writer-wins means it RE-CLAIMS, which is deliberate (tab switch), so it
    // relays — but only ONE of the two writers is ever current, so each keystroke
    // hits stdin exactly once. The pathology was BOTH writers relaying per keypress.
    await relayTermInput(SESSION, W1, 'a')
    release(SESSION)

    expect(pty).toEqual([
      { writer: W2, data: 'b' },
      { writer: W1, data: 'a' },
    ])
    expect(currentTermWriter(SESSION)).toBe(W1)
  })

  test('supersede on session A does NOT drop the same connection’s waiter on session B', async () => {
    // One socket, two sessions (grid view drives up to 12). W1 is queued on B…
    const B = 'fe8a21be-0000-0000-0000-0000000000bb'
    expect(await acquire(B, W2)).toBe(true) // someone else holds B
    claimTermWriter(B, W1)
    const w1OnB = relayTermInput(B, W1, 'b-key') // W1 queues on B

    // …while W1 is superseded on session A. The all-sessions releaseByWriter would
    // resolve W1's session-B waiter false here — one silently lost frame.
    claimTermWriter(SESSION, W1)
    claimTermWriter(SESSION, W2) // supersedes W1 on A only

    release(B) // B's holder finishes → W1 is promoted on B
    expect(await w1OnB).toBe(true)
    expect(pty).toEqual([{ writer: W1, data: 'b-key' }])
  })

  test('Telegram is NEVER superseded or dropped by the client write path', async () => {
    claimTermWriter(SESSION, W1)
    expect(await acquire(SESSION, W1)).toBe(true)

    const tg = relayTelegram(SESSION, 'tg-turn') // queues behind W1
    await Promise.resolve()

    // A second client connection supersedes W1 while Telegram waits…
    const w2 = relayTermInput(SESSION, W2, 'b')
    await Promise.resolve()
    release(SESSION) // W1's turn completes

    // …Telegram is promoted in FIFO order and its bytes are relayed, untouched.
    expect(await tg).toBe(true)
    release(SESSION)
    expect(await w2).toBe(true)

    expect(pty).toContainEqual({ writer: TG, data: 'tg-turn' })
    expect(currentTermWriter(SESSION)).toBe(W2) // client claim never names Telegram
  })
})
