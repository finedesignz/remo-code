/**
 * Bug B (2026-05-28) — ClaudeRunner.stopGracefully actually terminates the
 * subprocess (SIGINT, then SIGKILL after 3s).
 *
 * Uses `spawnImpl` test hook to inject a fake subprocess so the test does NOT
 * need a real `claude` binary on PATH. We assert that:
 *   - .kill('SIGINT') is called on graceful stop;
 *   - if the process doesn't exit within the grace window, SIGKILL fires;
 *   - `stop()` (non-graceful) also calls .kill().
 */
import { describe, test, expect } from 'bun:test'
import { ClaudeRunner } from '../src/runners/claude-runner'

function makeFakeProc(opts: { exitDelayMs?: number } = {}) {
  const signals: string[] = []
  let exitResolve: (code: number) => void = () => {}
  const exitPromise = new Promise<number>((res) => { exitResolve = res })
  let alreadyExited = false
  const fakeStream = {
    getReader: () => ({
      read: async () => ({ done: true, value: undefined }),
    }),
  }
  const proc: any = {
    pid: 9999,
    stdin: { write: () => {}, flush: () => {} },
    stdout: fakeStream,
    stderr: fakeStream,
    exited: exitPromise,
    kill: (sig?: string) => {
      signals.push(sig ?? 'SIGTERM')
      if (opts.exitDelayMs === undefined) {
        if (!alreadyExited) { alreadyExited = true; exitResolve(0) }
      } else {
        setTimeout(() => {
          if (!alreadyExited) { alreadyExited = true; exitResolve(0) }
        }, opts.exitDelayMs)
      }
    },
  }
  return { proc, signals, exitPromise, forceExit: () => { if (!alreadyExited) { alreadyExited = true; exitResolve(0) } } }
}

describe('ClaudeRunner stop / stopGracefully', () => {
  test('stop() calls kill() on the subprocess', () => {
    const fake = makeFakeProc()
    const runner = new ClaudeRunner('/repo', false)
    runner.spawnImpl = (() => fake.proc) as any
    runner.start(() => {})
    runner.stop()
    expect(fake.signals.length).toBeGreaterThanOrEqual(1)
  })

  test('stopGracefully() sends SIGINT first, then SIGKILL if still alive', async () => {
    // exitDelayMs > grace (3s) so the SIGKILL branch fires.
    const fake = makeFakeProc({ exitDelayMs: 10_000 })
    const runner = new ClaudeRunner('/repo', false)
    runner.spawnImpl = (() => fake.proc) as any
    runner.start(() => {})
    const before = Date.now()
    await runner.stopGracefully()
    const elapsed = Date.now() - before
    // SIGINT first, then SIGKILL after 3s race timeout.
    expect(fake.signals[0]).toBe('SIGINT')
    expect(fake.signals).toContain('SIGKILL')
    // stopGracefully waits at most 3s for graceful exit.
    expect(elapsed).toBeGreaterThanOrEqual(3000)
    expect(elapsed).toBeLessThan(6000)
  }, 10_000)

  test('stopGracefully() returns fast when proc exits immediately on SIGINT', async () => {
    const fake = makeFakeProc({ exitDelayMs: 50 })
    const runner = new ClaudeRunner('/repo', false)
    runner.spawnImpl = (() => fake.proc) as any
    runner.start(() => {})
    const before = Date.now()
    await runner.stopGracefully()
    const elapsed = Date.now() - before
    expect(fake.signals[0]).toBe('SIGINT')
    // Returned well before the 3s grace cap.
    expect(elapsed).toBeLessThan(1500)
  })
})
