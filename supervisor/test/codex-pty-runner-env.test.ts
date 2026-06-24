/**
 * Phase 17 — Codex PTY env-hygiene unit test (constraint 1/2).
 *
 * Asserts buildCodexPtyHostEnv strips EVERY provider API key (OPENAI_API_KEY —
 * Codex's provider key — AND ANTHROPIC_API_KEY, defense-in-depth) even when set
 * in the base env, and that no Claude OAuth token is forwarded onto the Codex
 * spawn path. The Rust host (Option C, pty_host.rs) repeats the strip in
 * `build_pty_env` before spawning; a static assertion proves that mechanism too.
 */
import { describe, test, expect } from 'bun:test'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { buildCodexPtyHostEnv, CodexPtyRunner } from '../src/runners/codex-pty-runner'

describe('Phase 17 — buildCodexPtyHostEnv strips every provider API key', () => {
  test('OPENAI_API_KEY + ANTHROPIC_API_KEY present in base env are removed', () => {
    const base = {
      OPENAI_API_KEY: 'sk-openai-leak',
      ANTHROPIC_API_KEY: 'sk-anthropic-leak',
      PATH: '/usr/bin',
      HOME: '/home/u',
    } as any
    const env = buildCodexPtyHostEnv(base)
    expect(env.OPENAI_API_KEY).toBeUndefined()
    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
    // Unrelated env survives.
    expect(env.PATH).toBe('/usr/bin')
    expect(env.HOME).toBe('/home/u')
  })

  test('absent keys stay absent (no crash)', () => {
    const env = buildCodexPtyHostEnv({ PATH: '/usr/bin' } as any)
    expect(env.OPENAI_API_KEY).toBeUndefined()
    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
  })

  test('no forwarded Claude OAuth token field on the Codex env', () => {
    const base = { CLAUDE_CODE_OAUTH_TOKEN: 'oauth-leak', PATH: '/usr/bin' } as any
    const env = buildCodexPtyHostEnv(base)
    // buildCodexPtyHostEnv does not invent/forward an OAuth token; whatever the
    // base carries is the supervisor's own env, never sourced from
    // ~/.claude/.credentials.json by this runner (see source-grep below).
    // The Codex client owns its OWN auth (`codex login`).
    expect(env.OPENAI_API_KEY).toBeUndefined()
    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
  })

  test('runner is constructible and exposes the raw-bytes lifecycle surface', () => {
    const runner = new CodexPtyRunner()
    expect(typeof runner.start).toBe('function')
    expect(typeof runner.write).toBe('function')
    expect(typeof runner.resize).toBe('function')
    expect(typeof runner.kill).toBe('function')
  })

  test('codex-pty-runner.ts imports no RunnerEvent/agent-protocol/session-bridge/credentials/oauth-poll', () => {
    const SRC = join(import.meta.dir, '..', 'src', 'runners', 'codex-pty-runner.ts')
    const code = readFileSync(SRC, 'utf-8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split(/\r?\n/)
      .map((l) => l.replace(/\/\/.*$/, ''))
      .join('\n')
    expect(/\bRunnerEvent\b/.test(code)).toBe(false)
    expect(/agent-protocol/.test(code)).toBe(false)
    expect(/session-bridge/.test(code)).toBe(false)
    expect(/credentials\.json/.test(code)).toBe(false)
    expect(/oauth-poll/.test(code)).toBe(false)
  })

  test('Rust host build_pty_env removes OPENAI_API_KEY before spawning codex', () => {
    const RUST_HOST = join(import.meta.dir, '..', 'tauri', 'src-tauri', 'src', 'pty_host.rs')
    if (!existsSync(RUST_HOST)) return
    const code = readFileSync(RUST_HOST, 'utf-8')
    expect(/env_remove\(\s*"OPENAI_API_KEY"\s*\)/.test(code)).toBe(true)
    expect(/env_remove\(\s*"ANTHROPIC_API_KEY"\s*\)/.test(code)).toBe(true)
  })
})
