/**
 * Phase 15 — BEHAVIORAL spawn-interception harness (R-PTY-26 / H6).
 * PRIMARY enforcement of the spawn invariants (the grep canary is secondary).
 *
 * Intercepts the runner's real host-spawn factory via the test-only seam,
 * drives the runner's start path, and asserts on the REAL { file, argv, env }
 * the runner hands the PTY host — plus the `claude` spawn frame the runner
 * actually sends over the host stdin. This catches a runtime-constructed
 * violation (string-concat flag, env merged from process.env) that the static
 * grep cannot see.
 *
 * REUSED BY: Phase 16 (productionized runner), Phase 17 (Codex PTY runner),
 * Phase 19 (cutover). Keep the capture-fake pattern stable.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { ClaudePtyRunner, __setHostSpawnForTest, type HostHandle } from '../src/runners/claude-pty-runner'

interface Captured {
  file: string
  argv: string[]
  env: NodeJS.ProcessEnv
  frames: any[]
}

function makeCapturingFake(cap: Captured): (file: string, argv: string[], opts: { env: NodeJS.ProcessEnv }) => HostHandle {
  return (file, argv, opts) => {
    cap.file = file
    cap.argv = argv
    cap.env = opts.env
    let acc = Buffer.alloc(0)
    return {
      pid: 4242,
      stdin: {
        write(chunk: Buffer | string) {
          acc = Buffer.concat([acc, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)])
          while (acc.length >= 4) {
            const len = acc.readUInt32BE(0)
            if (acc.length < 4 + len) break
            try { cap.frames.push(JSON.parse(acc.subarray(4, 4 + len).toString('utf8'))) } catch {}
            acc = acc.subarray(4 + len)
          }
        },
      },
      stdout: { on() {} },
      on() {},
      kill() {},
    }
  }
}

let restore: () => void
let cap: Captured

beforeEach(() => {
  cap = { file: '', argv: [], env: {}, frames: [] }
  restore = __setHostSpawnForTest(makeCapturingFake(cap))
})
afterEach(() => restore())

describe('Phase 15 — behavioral spawn-interception (H6 / R-PTY-26)', () => {
  test('host is spawned with node + the pty-host script; env has no ANTHROPIC_API_KEY even when process.env sets it', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-runtime-leak'
    try {
      const runner = new ClaudePtyRunner()
      runner.start({ cwd: process.cwd(), cols: 100, rows: 30, onData: () => {} })
      expect(cap.file).toBe('node')
      expect(cap.argv.length).toBe(1)
      expect(cap.argv[0]).toMatch(/pty-host\.mjs$/)
      // CONSTRAINT 1 — captured env handed to the host must not carry the key.
      expect(cap.env.ANTHROPIC_API_KEY).toBeUndefined()
    } finally {
      delete process.env.ANTHROPIC_API_KEY
    }
  })

  test('the claude spawn frame the runner sends has file=claude, EMPTY argv, no programmatic flags', () => {
    const runner = new ClaudePtyRunner()
    runner.start({ cwd: process.cwd(), onData: () => {} })
    const spawnFrame = cap.frames.find((f) => f.t === 'spawn')
    expect(spawnFrame).toBeDefined()
    expect(spawnFrame.file).toBe('claude')
    expect(Array.isArray(spawnFrame.args)).toBe(true)
    expect(spawnFrame.args.length).toBe(0) // CONSTRAINT 5 — interactive, no flags
    const argStr = (spawnFrame.args as string[]).join(' ')
    for (const forbidden of ['-p', '--print', '--input-format', '--output-format', 'stream-json']) {
      expect(argStr.includes(forbidden)).toBe(false)
    }
  })

  test('input/resize/kill frames carry raw bytes only (no RunnerEvent translation)', () => {
    const runner = new ClaudePtyRunner()
    runner.start({ cwd: process.cwd(), onData: () => {} })
    runner.write('echo hi\r')
    runner.resize(120, 40)
    runner.kill()
    const kinds = cap.frames.map((f) => f.t)
    expect(kinds).toContain('input')
    expect(kinds).toContain('resize')
    expect(kinds).toContain('kill')
    const input = cap.frames.find((f) => f.t === 'input')
    expect(input.d).toBe('echo hi\r') // raw bytes, verbatim
  })
})
