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
  type PersistablePty,
} from '../src/runners/pty-persistence'

function fakePty(): PersistablePty & { killed: number } {
  return { killed: 0, kill() { this.killed++ } }
}

describe('Phase-16 PTY persistence — ring-buffer scrollback', () => {
  test('ring-buffer keeps the last N bytes within its cap', () => {
    const ring = new RingBuffer(10)
    ring.push('abcdef')
    ring.push('ghijkl') // total 12 → cap 10 keeps last 10
    expect(ring.size).toBe(10)
    expect(ring.snapshot()).toBe('cdefghijkl')
  })

  test('recordOutput accumulates scrollback for replay', () => {
    const p = new PtyPersistence(300)
    const pty = fakePty()
    p.register('s1', pty)
    p.recordOutput('s1', 'hello ')
    p.recordOutput('s1', 'world')
    expect(p.scrollback('s1')).toBe('hello world')
  })
})

describe('Phase-16 PTY persistence — detach vs kill (R-PTY-27)', () => {
  test('client DISCONNECT detaches; PTY survives + reattach replays scrollback', () => {
    // idle grace 0 here so detach does NOT idle-reap — we are proving survival
    // across a mere disconnect, not the idle-reap path.
    const p = new PtyPersistence(0)
    const pty = fakePty()
    p.register('s1', pty)
    p.attach('s1') // client connects
    p.recordOutput('s1', 'line1\nline2\n')

    // Client disconnects (phone drops wifi). DETACH — must NOT kill.
    p.detach('s1')
    expect(pty.killed).toBe(0)
    expect(p.isAlive('s1')).toBe(true)

    // Reattach (reconnect) — scrollback replays intact, live resumes.
    const replay = p.attach('s1')
    expect(replay).toBe('line1\nline2\n')
    expect(pty.killed).toBe(0)
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
