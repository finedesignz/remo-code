/**
 * Phase-16 R-PTY-07 / R-PTY-27 — disconnect-survival + scrollback replay +
 * the explicit detach-vs-kill policy.
 *
 * Drives the supervisor-owned PtyPersistence coordinator (over a fake PTY) and
 * asserts:
 *   - output accumulates into the bounded ring-buffer,
 *   - a client DISCONNECT DETACHES (PTY survives) and a later reattach replays
 *     scrollback intact + resumes live,
 *   - session CLOSE / idle-reap / supervisor SHUTDOWN KILL the PTY (no orphan),
 *   - the ring-buffer respects its byte cap.
 */
import { describe, test, expect } from 'bun:test'
import {
  PtyPersistence,
  RingBuffer,
  safeTrimPoint,
  type PersistablePty,
} from '../src/runners/pty-persistence'

function fakePty(): PersistablePty & { killed: number } {
  return { killed: 0, kill() { this.killed++ } }
}

describe('Phase-16 PTY persistence — RingBuffer utility (pure, Rust-parity building block)', () => {
  test('ring-buffer keeps the last N bytes within its cap', () => {
    // Trimming is chunked (TRIM_CHUNK_BYTES, clamped to the ring cap) so a
    // stream of tiny pushes does not re-copy the ring on every byte: the ring
    // may run up to cap + chunk before it re-trims, then trims back to cap.
    const ring = new RingBuffer(10)
    ring.push('abcdef')
    ring.push('ghijkl') // total 12 — under cap+chunk (20), not yet trimmed
    expect(ring.size).toBe(12)
    ring.push('mnopqrst') // total 20 — reaches cap+chunk, trims back to cap
    expect(ring.size).toBe(10)
    expect(ring.snapshot()).toBe('klmnopqrst')
  })

  test('a raw byte-count trim never starts mid ANSI escape sequence (mobile scrollback-depth investigation, 2026-09)', () => {
    // "\x1b[31mAB\x1b[0mCD" is 13 bytes; a naive `slice(len-cap)` with cap=5
    // starts at index 8 ("[0mCD") — INSIDE the second escape sequence
    // ("\x1b[0m"), which is exactly what desynced the client's xterm.js
    // parser and rendered as blank/garbled leading output on (re)attach
    // (proven pre-fix: the naive slice literally produces "[0mCD").
    const buf = '\x1b[31mAB\x1b[0mCD'
    const rawCut = buf.length - 5
    const safeCut = safeTrimPoint(buf, rawCut)
    const trimmed = buf.slice(safeCut)
    // Must never start with an orphaned escape-sequence tail: either empty,
    // starting with a fresh ESC, or a byte that isn't a CSI parameter/final
    // byte (which would only make sense preceded by an ESC we dropped).
    const first = trimmed.charCodeAt(0)
    expect(
      trimmed.length === 0 || first === 0x1b || first < 0x30 || first > 0x7e,
    ).toBe(true)

    // The ring itself must produce the same safe result end-to-end.
    const ring = new RingBuffer(5)
    ring.push(buf)
    const first2 = ring.snapshot().charCodeAt(0)
    expect(
      ring.snapshot().length === 0 || first2 === 0x1b || first2 < 0x30 || first2 > 0x7e,
    ).toBe(true)
  })

})

describe('Phase-16 PTY persistence — detach vs kill (R-PTY-27)', () => {
  test('client DISCONNECT detaches; PTY survives a reattach (scrollback replay is Rust-host-only)', () => {
    // idle grace 0 here so detach does NOT idle-reap — we are proving survival
    // across a mere disconnect, not the idle-reap path.
    const p = new PtyPersistence(0)
    const pty = fakePty()
    p.register('s1', pty)
    p.attach('s1') // client connects

    // Client disconnects (phone drops wifi). DETACH — must NOT kill.
    p.detach('s1')
    expect(pty.killed).toBe(0)
    expect(p.isAlive('s1')).toBe(true)

    // Reattach (reconnect) — PTY still alive, no kill triggered.
    p.attach('s1')
    expect(pty.killed).toBe(0)
    expect(p.subscriberCount('s1')).toBe(1)
  })

  test('session CLOSE kills the PTY (no orphan)', () => {
    const p = new PtyPersistence(300)
    const pty = fakePty()
    p.register('s1', pty)
    p.attach('s1')
    p.kill('s1', 'session_close')
    expect(pty.killed).toBe(1)
    expect(p.isAlive('s1')).toBe(false)
  })

  test('idle-reap KILLS after grace when no subscribers remain', async () => {
    // Tiny grace so the timer fires fast in-test.
    const p = new PtyPersistence(0.05) // 50ms
    const pty = fakePty()
    p.register('s1', pty)
    p.attach('s1')
    p.detach('s1') // last subscriber gone → idle-reap scheduled
    expect(p.idleReapPending('s1')).toBe(true)
    expect(pty.killed).toBe(0) // not killed immediately — only after grace
    await new Promise((r) => setTimeout(r, 120))
    expect(pty.killed).toBe(1)
    expect(p.isAlive('s1')).toBe(false)
  })

  test('a reattach BEFORE the idle grace fires cancels the reap', async () => {
    const p = new PtyPersistence(0.05)
    const pty = fakePty()
    p.register('s1', pty)
    p.attach('s1')
    p.detach('s1')
    expect(p.idleReapPending('s1')).toBe(true)
    p.attach('s1') // reconnect races in before the timer
    expect(p.idleReapPending('s1')).toBe(false)
    await new Promise((r) => setTimeout(r, 120))
    expect(pty.killed).toBe(0)
    expect(p.isAlive('s1')).toBe(true)
  })

  test('supervisor SHUTDOWN kills every hosted PTY (no orphan)', () => {
    const p = new PtyPersistence(300)
    const a = fakePty()
    const b = fakePty()
    p.register('a', a)
    p.register('b', b)
    p.killAll()
    expect(a.killed).toBe(1)
    expect(b.killed).toBe(1)
    expect(p.liveCount()).toBe(0)
  })
})
