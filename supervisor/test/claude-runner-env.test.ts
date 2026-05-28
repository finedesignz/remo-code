import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ClaudeRunner } from '../src/runners/claude-runner'

let TMP: string

beforeEach(() => { TMP = mkdtempSync(join(tmpdir(), 'remo-orch-')) })
afterEach(() => { try { rmSync(TMP, { recursive: true, force: true }) } catch {} })

// Fake subprocess that just records what spawn was called with and resolves
// `.exited` immediately so the runner doesn't hang the test.
function makeFakeSpawn(captured: { cmd?: string[]; opts?: any }) {
  return (cmd: string[], opts: any) => {
    captured.cmd = cmd
    captured.opts = opts
    return {
      pid: 9999,
      exited: new Promise(() => {}), // never resolves — keeps proc "alive" for the assertions
      stdin: { write: () => {}, flush: () => {} },
      stdout: { getReader: () => ({ read: async () => ({ done: true, value: undefined }) }) },
      stderr: { getReader: () => ({ read: async () => ({ done: true, value: undefined }) }) },
      kill: () => {},
    } as any
  }
}

describe('ClaudeRunner orchestrator plumbing', () => {
  test('injects REMO_HUB_API_KEY + REMO_HUB_URL into spawn env and writes .remo-orchestrator.md', () => {
    const captured: { cmd?: string[]; opts?: any } = {}
    const runner = new ClaudeRunner(TMP, false, {
      systemPrompt: 'SEED PROMPT BODY',
      hubApiKey: 'remokey_test123',
      hubUrl: 'https://app.remo-code.test',
    })
    runner.spawnImpl = makeFakeSpawn(captured)
    runner.start(() => {})

    expect(captured.opts?.env?.REMO_HUB_API_KEY).toBe('remokey_test123')
    expect(captured.opts?.env?.REMO_HUB_URL).toBe('https://app.remo-code.test')
    expect(captured.opts?.cwd).toBe(TMP)

    const seedPath = join(TMP, '.remo-orchestrator.md')
    expect(existsSync(seedPath)).toBe(true)
    expect(readFileSync(seedPath, 'utf-8')).toBe('SEED PROMPT BODY')

    runner.stop()
  })

  test('non-orchestrator runs do NOT overwrite REMO_HUB_* or write the seed file', () => {
    const captured: { cmd?: string[]; opts?: any } = {}
    // Save and clear any inherited dev-env vars so the assertion is unambiguous.
    const prevKey = process.env.REMO_HUB_API_KEY
    const prevUrl = process.env.REMO_HUB_URL
    delete process.env.REMO_HUB_API_KEY
    delete process.env.REMO_HUB_URL
    try {
      const runner = new ClaudeRunner(TMP, false)
      runner.spawnImpl = makeFakeSpawn(captured)
      runner.start(() => {})

      expect(captured.opts?.env?.REMO_HUB_API_KEY).toBeUndefined()
      expect(captured.opts?.env?.REMO_HUB_URL).toBeUndefined()
      expect(existsSync(join(TMP, '.remo-orchestrator.md'))).toBe(false)

      runner.stop()
    } finally {
      if (prevKey !== undefined) process.env.REMO_HUB_API_KEY = prevKey
      if (prevUrl !== undefined) process.env.REMO_HUB_URL = prevUrl
    }
  })
})
