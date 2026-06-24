/**
 * Phase 19 / 19-03 Task 4 — setup-token prohibition on the interactive path.
 * R-PTY-23 / T-19-03b / H9. A setup-token-derived credential must NOT reach a
 * human PTY spawn (until its billing class is verified) and must NEVER be
 * serialized to the hub (supervisor-ephemeral, mirroring the OAuth-token posture).
 *
 * Today the interactive path has NO setup-token provisioning; this test LOCKS
 * that absence — it must FAIL if a future change introduces one.
 */
import { describe, test, expect, afterEach } from 'bun:test'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { ClaudePtyRunner, __setHostSpawnForTest, type HostHandle } from '../src/runners/claude-pty-runner'
import { CodexPtyRunner, __setCodexHostSpawnForTest } from '../src/runners/codex-pty-runner'

const SETUP_TOKEN_ENVS = ['CLAUDE_SETUP_TOKEN', 'ANTHROPIC_SETUP_TOKEN', 'SETUP_TOKEN']

function fake(cap: { env: NodeJS.ProcessEnv; frames: any[] }) {
  return (_f: string, _a: string[], opts: { env: NodeJS.ProcessEnv }): HostHandle => {
    cap.env = opts.env
    let acc = Buffer.alloc(0)
    return {
      pid: 1,
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

describe('19-03 no setup-token on the interactive path (T-19-03b)', () => {
  let restore: () => void
  afterEach(() => restore?.())

  function run(make: () => any, setHook: typeof __setHostSpawnForTest) {
    for (const e of SETUP_TOKEN_ENVS) process.env[e] = 'st-leak'
    const cap: any = { env: {}, frames: [] }
    restore = setHook(fake(cap))
    try {
      make().start({ cwd: '/tmp', onData() {} })
      return cap
    } finally {
      for (const e of SETUP_TOKEN_ENVS) delete process.env[e]
    }
  }

  test('Claude PTY spawn env carries no setup-token credential', () => {
    const cap = run(() => new ClaudePtyRunner(), __setHostSpawnForTest)
    for (const e of SETUP_TOKEN_ENVS) expect(cap.env[e]).toBeUndefined()
    const blob = JSON.stringify(cap.frames)
    expect(blob).not.toContain('st-leak')
  })

  test('Codex PTY spawn env carries no setup-token credential', () => {
    const cap = run(() => new CodexPtyRunner(), __setCodexHostSpawnForTest)
    for (const e of SETUP_TOKEN_ENVS) expect(cap.env[e]).toBeUndefined()
    const blob = JSON.stringify(cap.frames)
    expect(blob).not.toContain('st-leak')
  })

  test('no supervisor source serializes a setup-token to the hub', () => {
    const srcDir = join(import.meta.dir, '..', 'src')
    const offenders: string[] = []
    const walk = (dir: string) => {
      for (const ent of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, ent.name)
        if (ent.isDirectory()) walk(p)
        else if (ent.name.endsWith('.ts')) {
          const code = readFileSync(p, 'utf8')
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .split(/\r?\n/).map((l) => l.replace(/\/\/.*$/, '')).join('\n')
          // a setup-token value placed into an outbound `send(...)`/serialized payload
          if (/setup[_-]?token/i.test(code) && /\bsend\s*\(/.test(code)) {
            // allow the oauth-poll reason STRING (no send of the token itself)
            if (!/token_expired_run_claude_setup_token/.test(code)) offenders.push(p)
          }
        }
      }
    }
    walk(srcDir)
    expect(offenders).toEqual([])
  })
})
