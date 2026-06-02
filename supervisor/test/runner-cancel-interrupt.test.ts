/**
 * v0.8.7 CHANGE 1 — ClaudeRunner.cancel() sends the stream-json interrupt
 * control_request (ESC-style turn interrupt) instead of killing the proc.
 *
 * The web "Stop" button → {type:'cancel'} → session-bridge → runner.cancel().
 * cancel() must keep the process/session alive and only cancel the in-progress
 * turn — exactly like pressing ESC in the CLI. Verified wire format (from the
 * @anthropic-ai/claude-agent-sdk source):
 *   {"type":"control_request","request_id":"<id>","request":{"subtype":"interrupt"}}
 *
 * Uses the spawnImpl test hook to inject a fake subprocess capturing stdin
 * writes; no real `claude` binary needed.
 */
import { describe, test, expect } from 'bun:test'
import { ClaudeRunner } from '../src/runners/claude-runner'

function makeFakeProc() {
  const writes: string[] = []
  const signals: string[] = []
  let exitResolve: (code: number) => void = () => {}
  const exitPromise = new Promise<number>((res) => { exitResolve = res })
  const fakeStream = {
    getReader: () => ({ read: async () => ({ done: true, value: undefined }) }),
  }
  const proc: any = {
    pid: 4242,
    stdin: { write: (s: string) => { writes.push(s) }, flush: () => {} },
    stdout: fakeStream,
    stderr: fakeStream,
    exited: exitPromise,
    kill: (sig?: string) => { signals.push(sig ?? 'SIGTERM'); exitResolve(0) },
  }
  return { proc, writes, signals }
}

describe('ClaudeRunner.cancel() = interrupt control_request', () => {
  test('writes a control_request with request.subtype==="interrupt" and does NOT kill', () => {
    const fake = makeFakeProc()
    const runner = new ClaudeRunner('/repo', false)
    runner.spawnImpl = (() => fake.proc) as any
    runner.start(() => {})
    runner.cancel()

    expect(fake.signals.length).toBe(0) // proc NOT killed

    const interruptLines = fake.writes
      .map((w) => { try { return JSON.parse(w.trim()) } catch { return null } })
      .filter((o) => o && o.type === 'control_request')
    expect(interruptLines.length).toBe(1)
    const line = interruptLines[0]
    expect(line.request).toBeDefined()
    expect(line.request.subtype).toBe('interrupt')
    expect(typeof line.request_id).toBe('string')
    expect(line.request_id.length).toBeGreaterThan(0)
    // Must be a single newline-terminated JSON line.
    expect(fake.writes.some((w) => w.endsWith('\n'))).toBe(true)
  })

  test('generates a unique request_id per cancel', () => {
    const fake = makeFakeProc()
    const runner = new ClaudeRunner('/repo', false)
    runner.spawnImpl = (() => fake.proc) as any
    runner.start(() => {})
    runner.cancel()
    runner.cancel()
    const ids = fake.writes
      .map((w) => { try { return JSON.parse(w.trim()) } catch { return null } })
      .filter((o) => o && o.type === 'control_request')
      .map((o) => o.request_id)
    expect(ids.length).toBe(2)
    expect(ids[0]).not.toBe(ids[1])
  })

  test('cancel() is a no-op when there is no proc', () => {
    const runner = new ClaudeRunner('/repo', false)
    expect(() => runner.cancel()).not.toThrow()
  })
})
