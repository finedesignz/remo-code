/**
 * Phase 19 / 19-03 Task 1 — Codex as the primary human-backend fallback, no API key.
 * R-PTY-23 / T-19-03. Codex rides the SAME PTY surface (backend-agnostic) and its
 * spawn env carries no provider key (incl. inherited OPENAI_API_KEY).
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import {
  CodexPtyRunner,
  __setCodexHostSpawnForTest,
  buildCodexPtyHostEnv,
  type HostHandle,
} from '../src/runners/codex-pty-runner'
import { selectHumanPtyRunner } from '../src/runners/runner-factory'
import type { BackendSelectorConfig, HumanSessionContext } from '../src/runners/backend-selector'

const human: HumanSessionContext = { isHuman: true }
const codexCfg: BackendSelectorConfig = {
  defaultHumanBackend: 'codex',
  gate: { result: 'unknown', claudeInteractiveConfirmed: false },
}

function capturingFake(cap: { file: string; argv: string[]; env: NodeJS.ProcessEnv; frames: any[] }) {
  return (file: string, argv: string[], opts: { env: NodeJS.ProcessEnv }): HostHandle => {
    cap.file = file
    cap.argv = argv
    cap.env = opts.env
    let acc = Buffer.alloc(0)
    return {
      pid: 7,
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

describe('19-03 Codex fallback (R-PTY-23 / T-19-03)', () => {
  test('selector resolves codex-pty to a CodexPtyRunner', () => {
    const runner = selectHumanPtyRunner(human, codexCfg)
    expect(runner.constructor.name).toBe('CodexPtyRunner')
  })

  let cap: any
  let restore: () => void
  beforeEach(() => {
    cap = { file: '', argv: [], env: {}, frames: [] }
    restore = __setCodexHostSpawnForTest(capturingFake(cap))
  })
  afterEach(() => restore())

  test('Codex human-session spawn carries no OPENAI/ANTHROPIC API key, even inherited', () => {
    process.env.OPENAI_API_KEY = 'sk-codex-leak'
    process.env.ANTHROPIC_API_KEY = 'sk-anthropic-leak'
    try {
      const runner = new CodexPtyRunner()
      runner.start({ cwd: '/tmp', onData() {} })
      expect(cap.env.OPENAI_API_KEY).toBeUndefined()
      expect(cap.env.ANTHROPIC_API_KEY).toBeUndefined()
      // spawns the interactive codex TUI, empty argv
      const spawn = cap.frames.find((f: any) => f.t === 'spawn')
      expect(spawn.file).toBe('codex')
      expect(spawn.args).toEqual([])
    } finally {
      delete process.env.OPENAI_API_KEY
      delete process.env.ANTHROPIC_API_KEY
    }
  })

  test('buildCodexPtyHostEnv scrubs inherited keys (pure helper)', () => {
    const env = buildCodexPtyHostEnv({ OPENAI_API_KEY: 'x', ANTHROPIC_API_KEY: 'y', PATH: '/usr/bin' })
    expect(env.OPENAI_API_KEY).toBeUndefined()
    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(env.PATH).toBe('/usr/bin')
  })
})
