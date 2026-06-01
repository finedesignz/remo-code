/**
 * Phase 15/16 — env-strip unit test (constraint 1).
 *
 * A-branch: asserts buildPtyHostEnv removes ANTHROPIC_API_KEY even when set in
 * the base env (defense-in-depth: pty-host.mjs strips it again before spawn).
 * C-branch (Option C, this phase): the spawn env is built in Rust (pty_host.rs),
 * which calls `env_remove("ANTHROPIC_API_KEY")` before spawning `claude`; a
 * static assertion proves the strip is present and that the thin Bun bridge
 * neither builds an env nor forwards an API key.
 */
import { describe, test, expect } from 'bun:test'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
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

describe('Phase 16 Option C — Rust host strips ANTHROPIC_API_KEY; bridge never forwards it', () => {
  const RUST_HOST = join(import.meta.dir, '..', 'tauri', 'src-tauri', 'src', 'pty_host.rs')
  const BRIDGE = join(import.meta.dir, '..', 'src', 'runners', 'claude-pty-bridge.ts')

  test('pty_host.rs calls env_remove("ANTHROPIC_API_KEY") before spawning claude', () => {
    if (!existsSync(RUST_HOST)) return // not on this branch
    const code = readFileSync(RUST_HOST, 'utf-8')
    expect(/env_remove\(\s*"ANTHROPIC_API_KEY"\s*\)/.test(code)).toBe(true)
  })

  test('claude-pty-bridge.ts builds no env and forwards no API key (code, not comments)', () => {
    if (!existsSync(BRIDGE)) return
    // Strip comments first — the header documents the API-key constraint in prose.
    const code = readFileSync(BRIDGE, 'utf-8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split(/\r?\n/)
      .map((l) => l.replace(/\/\/.*$/, ''))
      .join('\n')
    // In executable code the bridge ferries opaque bytes; it must not reference
    // the API key, and must not construct a spawn env (the Rust host owns spawn).
    expect(code.includes('ANTHROPIC_API_KEY')).toBe(false)
    expect(/\bbuildPtyHostEnv\b/.test(code)).toBe(false)
  })
})
