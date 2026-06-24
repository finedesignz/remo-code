/**
 * Phase 16 (H10 / R-PTY-31) — resume READS the persisted runner identity and
 * re-binds the SAME backend: no dual-spawn, no mode mis-route on
 * reconnect/restart.
 */
import { describe, test, expect } from 'bun:test'
import { decideResume } from '../src/runners/resume-binding'

describe('Phase 16 — resume reads persisted identity (no dual-spawn / no mis-route)', () => {
  test('pty-interactive WITH a persisted backend RE-BINDS (no second spawn)', () => {
    const d = decideResume({ runner_type: 'pty-interactive', pty_backend_id: 'pty_abc' }, false)
    expect(d.action).toBe('rebind')
    if (d.action === 'rebind') {
      expect(d.runnerType).toBe('pty-interactive')
      expect(d.ptyBackendId).toBe('pty_abc')
    }
  })

  test('a live-bound backend is a NOOP — never dual-spawned', () => {
    const d = decideResume({ runner_type: 'pty-interactive', pty_backend_id: 'pty_abc' }, true)
    expect(d.action).toBe('noop')
  })

  test('a pty-interactive session is NEVER resumed via the stream-json path', () => {
    const d = decideResume({ runner_type: 'pty-interactive', pty_backend_id: 'pty_abc' }, false)
    // Must not spawn a stream-json runner for a pty-interactive session.
    expect(d.action === 'spawn' && (d as any).runnerType === 'stream-json').toBe(false)
  })

  test('first run (no persisted backend) spawns ONCE on the persisted mode', () => {
    const pty = decideResume({ runner_type: 'pty-interactive', pty_backend_id: null }, false)
    expect(pty.action).toBe('spawn')
    if (pty.action === 'spawn') expect(pty.runnerType).toBe('pty-interactive')

    const sj = decideResume({ runner_type: 'stream-json', pty_backend_id: null }, false)
    expect(sj.action).toBe('spawn')
    if (sj.action === 'spawn') expect(sj.runnerType).toBe('stream-json')
  })

  test('a stream-json session with a live backend is a NOOP (idempotent reconnect)', () => {
    const d = decideResume({ runner_type: 'stream-json', pty_backend_id: null }, true)
    expect(d.action).toBe('noop')
  })
})
