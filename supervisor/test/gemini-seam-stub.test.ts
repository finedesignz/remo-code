/**
 * Phase 19 / 19-03 Task 2 — Gemini runner stub seam. R-PTY-23 / T-19-04.
 * The seam exists (interface-conforming) but is OFF / not-implemented and NEVER
 * default-selected. Explicit selection surfaces a clear not-available error.
 */
import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  GeminiPtyRunner,
  GEMINI_BACKEND_ENABLED,
  GEMINI_NOT_AVAILABLE_MESSAGE,
  buildGeminiPtyHostEnv,
} from '../src/runners/gemini-pty-runner'
import { resolveHumanBackend, type BackendSelectorConfig } from '../src/runners/backend-selector'

describe('19-03 Gemini stub seam (R-PTY-23 / T-19-04)', () => {
  test('feature flag is OFF', () => {
    expect(GEMINI_BACKEND_ENABLED).toBe(false)
  })

  test('start() throws a clear not-available error', () => {
    const r = new GeminiPtyRunner()
    expect(() => r.start({ cwd: '/tmp', onData() {} })).toThrow(/not available/i)
    expect(GEMINI_NOT_AVAILABLE_MESSAGE.toLowerCase()).toContain('no api-key fallback')
  })

  test('selector never resolves to gemini (only claude-pty | codex-pty)', () => {
    const cfgs: BackendSelectorConfig[] = [
      { defaultHumanBackend: 'claude', gate: { result: 'interactive', claudeInteractiveConfirmed: true } },
      { defaultHumanBackend: 'codex', gate: { result: 'unknown', claudeInteractiveConfirmed: false } },
    ]
    for (const c of cfgs) {
      const out = resolveHumanBackend({ isHuman: true }, c)
      expect(['claude-pty', 'codex-pty']).toContain(out)
      expect(out).not.toContain('gemini')
    }
  })

  test('its env helper still routes through the shared sanitizer', () => {
    const env = buildGeminiPtyHostEnv({ GEMINI_API_KEY: 'g', GOOGLE_API_KEY: 'h', PATH: '/x' })
    expect(env.GEMINI_API_KEY).toBeUndefined()
    expect(env.GOOGLE_API_KEY).toBeUndefined()
    expect(env.PATH).toBe('/x')
  })

  test('header documents WHY (June-18-2026 sunset)', () => {
    const code = readFileSync(join(import.meta.dir, '..', 'src', 'runners', 'gemini-pty-runner.ts'), 'utf8')
    expect(code).toContain('June 18 2026')
    expect(code.toLowerCase()).toContain('antigravity')
  })
})
