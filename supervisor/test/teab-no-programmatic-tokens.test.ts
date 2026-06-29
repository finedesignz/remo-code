/**
 * TEAB-02 canary — fail the build if the supervisor's TEAB spawn ever grows a
 * programmatic flag, an API key, or a permission-skip token.
 *
 * Invariant (mirrors the human-PTY no-api-key canaries
 * `no-api-key-no-streamjson-pty.test.ts` / `no-apikey-fallback-guard.test.ts`):
 * the supervisor launches ONLY the `teab` binary with the allowlisted argv shape
 * `teab run --repo <repo>`. TEAB itself owns its `claude` spawns + permission
 * contract (the target repo's D3 `irreversible-action-guard.mjs` hook); the
 * supervisor must NEVER thread a `-p`/`--print`/`--input-format`/`--output-format`/
 * `stream-json` flag, an API key, or `--dangerously-skip-permissions` into the
 * teab process — that would re-open the programmatic / over-permissioned path.
 *
 * This is the standalone guard. TEAB-01's `teab-run.test.ts` has an inline
 * forbidden-token check; this file mirrors the repo's other `no-*` canaries so a
 * regression trips a dedicated, clearly-named test.
 */
import { describe, test, expect } from 'bun:test'
import { buildTeabSpawnArgs } from '../src/commands/teab-run'
import { sanitizeSpawnEnv, isCredentialEnvName } from '../src/runners/env-sanitize'

const REPO = '/repo' // absolute on win32 + posix

const FORBIDDEN_TOKENS = [
  '-p',
  '--print',
  '--input-format',
  '--output-format',
  'stream-json',
  '--dangerously-skip-permissions',
  'bypassPermissions',
] as const

describe('TEAB-02 canary — no programmatic tokens in the teab spawn argv', () => {
  test('built argv contains none of the forbidden programmatic / permission tokens', () => {
    const { bin, args } = buildTeabSpawnArgs(REPO)
    const argv = [bin, ...args]
    for (const tok of FORBIDDEN_TOKENS) {
      expect(argv).not.toContain(tok)
    }
  })

  test('built argv carries no API-key / auth-token-shaped token', () => {
    const { bin, args } = buildTeabSpawnArgs(REPO)
    for (const a of [bin, ...args]) {
      const up = a.toUpperCase()
      expect(up).not.toContain('API_KEY')
      expect(up).not.toContain('AUTH_TOKEN')
      expect(up).not.toContain('ACCESS_TOKEN')
    }
  })

  test('argv is exactly the allowlisted shape `teab run --repo <repo>`', () => {
    const { bin, args } = buildTeabSpawnArgs(REPO)
    expect([bin, ...args]).toEqual(['teab', 'run', '--repo', REPO])
  })

  test('honoring TEAB_BIN never injects extra argv tokens', () => {
    const prev = process.env.TEAB_BIN
    try {
      process.env.TEAB_BIN = '/opt/teab/bin/teab'
      const { bin, args } = buildTeabSpawnArgs(REPO)
      expect(args).toEqual(['run', '--repo', REPO])
      expect(bin).toBe('/opt/teab/bin/teab')
    } finally {
      if (prev === undefined) delete process.env.TEAB_BIN
      else process.env.TEAB_BIN = prev
    }
  })
})

describe('TEAB-02 canary — no provider credential survives the teab spawn env', () => {
  test('sanitizeSpawnEnv strips API-key-shaped vars from the resolved env', () => {
    const dirty: NodeJS.ProcessEnv = {
      PATH: '/usr/bin',
      ANTHROPIC_API_KEY: 'sk-should-be-gone',
      OPENAI_API_KEY: 'sk-also-gone',
      SOME_SERVICE_AUTH_TOKEN: 'gone-too',
      HOME: '/home/me',
    }
    const clean = sanitizeSpawnEnv(dirty)
    expect(clean.ANTHROPIC_API_KEY).toBeUndefined()
    expect(clean.OPENAI_API_KEY).toBeUndefined()
    expect(clean.SOME_SERVICE_AUTH_TOKEN).toBeUndefined()
    // benign vars survive (interactive CLI needs PATH/HOME)
    expect(clean.PATH).toBe('/usr/bin')
    expect(clean.HOME).toBe('/home/me')
  })

  test('credential-class names are recognized', () => {
    expect(isCredentialEnvName('ANTHROPIC_API_KEY')).toBe(true)
    expect(isCredentialEnvName('PATH')).toBe(false)
  })
})
