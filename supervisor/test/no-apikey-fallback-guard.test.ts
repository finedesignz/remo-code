/**
 * Phase 19 / 19-03 Task 3 — shared multi-provider env-sanitizer + per-backend
 * no-API-key guard (R-PTY-23 / R-PTY-36 / T-19-03 / H9 / NH-5).
 *
 * Behavioral: pre-seed EACH denylisted var into process.env, instantiate each
 * runner via its REAL spawn path (intercept the host spawn), assert the ACTUAL
 * spawned env carries NONE of them. Plus a NOVEL pattern-matched var test and a
 * benign-var survival control. Plus a static grep canary.
 */
import { describe, test, expect, afterEach } from 'bun:test'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  sanitizeSpawnEnv,
  isCredentialEnvName,
  PROVIDER_KEY_DENYLIST,
  CREDENTIAL_PATTERNS,
} from '../src/runners/env-sanitize'
import { ClaudePtyRunner, __setHostSpawnForTest, type HostHandle } from '../src/runners/claude-pty-runner'
import { CodexPtyRunner, __setCodexHostSpawnForTest } from '../src/runners/codex-pty-runner'

function fake(cap: { env: NodeJS.ProcessEnv }) {
  return (_file: string, _argv: string[], opts: { env: NodeJS.ProcessEnv }): HostHandle => {
    cap.env = opts.env
    return { pid: 1, stdin: { write() {} }, stdout: { on() {} }, on() {}, kill() {} }
  }
}

const ALL_KEYS = [...PROVIDER_KEY_DENYLIST]

describe('19-03 sanitizer unit (NH-5)', () => {
  test('named denylist all flagged', () => {
    for (const k of PROVIDER_KEY_DENYLIST) expect(isCredentialEnvName(k)).toBe(true)
  })
  test('pattern sweep catches novel + aliased credential vars', () => {
    expect(isCredentialEnvName('FOO_API_KEY')).toBe(true)
    expect(isCredentialEnvName('MISTRAL_AUTH_TOKEN')).toBe(true)
    expect(isCredentialEnvName('SOME_ACCESS_TOKEN')).toBe(true)
    expect(isCredentialEnvName('X_API_TOKEN')).toBe(true)
  })
  test('anchored patterns do not over-strip benign vars', () => {
    expect(isCredentialEnvName('MY_API_KEYBOARD_LAYOUT')).toBe(false)
    expect(isCredentialEnvName('PATH')).toBe(false)
    expect(CREDENTIAL_PATTERNS.length).toBeGreaterThan(0)
  })
  test('sanitizeSpawnEnv deletes credentials, keeps benign', () => {
    const out = sanitizeSpawnEnv({ OPENAI_API_KEY: 'x', FOO_API_KEY: 'y', PATH: '/b', HOME: '/h' })
    expect(out.OPENAI_API_KEY).toBeUndefined()
    expect(out.FOO_API_KEY).toBeUndefined()
    expect(out.PATH).toBe('/b')
    expect(out.HOME).toBe('/h')
  })
})

describe('19-03 per-backend behavioral no-API-key (real spawn path)', () => {
  let restore: () => void
  afterEach(() => restore?.())

  function seed() {
    for (const k of ALL_KEYS) process.env[k] = `seed-${k}`
    process.env.FOO_API_KEY = 'novel'
    process.env.MISTRAL_AUTH_TOKEN = 'novel2'
    process.env.MY_API_KEYBOARD_LAYOUT = 'benign'
  }
  function unseed() {
    for (const k of ALL_KEYS) delete process.env[k]
    delete process.env.FOO_API_KEY
    delete process.env.MISTRAL_AUTH_TOKEN
    delete process.env.MY_API_KEYBOARD_LAYOUT
  }

  function assertClean(env: NodeJS.ProcessEnv) {
    for (const k of ALL_KEYS) expect(env[k]).toBeUndefined()
    expect(env.FOO_API_KEY).toBeUndefined()
    expect(env.MISTRAL_AUTH_TOKEN).toBeUndefined()
    // benign anchored control survives
    expect(env.MY_API_KEYBOARD_LAYOUT).toBe('benign')
  }

  test('Claude PTY spawn env is clean (incl. inherited + novel pattern var)', () => {
    seed()
    const cap: any = {}
    restore = __setHostSpawnForTest(fake(cap))
    try {
      new ClaudePtyRunner().start({ cwd: '/tmp', onData() {} })
      assertClean(cap.env)
    } finally { unseed() }
  })

  test('Codex PTY spawn env is clean (incl. inherited + novel pattern var)', () => {
    seed()
    const cap: any = {}
    restore = __setCodexHostSpawnForTest(fake(cap))
    try {
      new CodexPtyRunner().start({ cwd: '/tmp', onData() {} })
      assertClean(cap.env)
    } finally { unseed() }
  })
})

describe('19-03 static grep canary — no runner builds an API-key env literal', () => {
  test('no runner source assigns an API-key env literal', () => {
    const dir = join(import.meta.dir, '..', 'src', 'runners')
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.ts') && !f.endsWith('.mjs')) continue
      if (f === 'env-sanitize.ts') continue // the denylist constant lives here
      const code = readFileSync(join(dir, f), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split(/\r?\n/).map((l) => l.replace(/\/\/.*$/, '')).join('\n')
      // an ASSIGNMENT of a provider key to a literal/string is forbidden
      expect(/\b(ANTHROPIC_API_KEY|OPENAI_API_KEY|GEMINI_API_KEY|GOOGLE_API_KEY)\b\s*[:=]\s*['"`]/.test(code)).toBe(false)
    }
  })
})
