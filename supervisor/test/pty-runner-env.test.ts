/**
 * Phase 15 — env-strip unit test (constraint 1).
 * Asserts buildPtyHostEnv removes ANTHROPIC_API_KEY even when it is set in the
 * base env. (Defense-in-depth: pty-host.mjs strips it again before spawn.)
 */
import { describe, test, expect } from 'bun:test'
import { buildPtyHostEnv } from '../src/runners/claude-pty-runner'

describe('Phase 15 — buildPtyHostEnv strips ANTHROPIC_API_KEY', () => {
  test('API key present in base env is removed', () => {
    const base = { ANTHROPIC_API_KEY: 'sk-test-leak', PATH: '/usr/bin', HOME: '/home/u' } as any
    const env = buildPtyHostEnv(base)
    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
    // Unrelated env survives.
    expect(env.PATH).toBe('/usr/bin')
    expect(env.HOME).toBe('/home/u')
  })

  test('absent API key stays absent (no crash)', () => {
    const env = buildPtyHostEnv({ PATH: '/usr/bin' } as any)
    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
  })
})
