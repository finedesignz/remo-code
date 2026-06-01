/**
 * Phase 15 canary (SECONDARY line — the behavioral harness in
 * pty-spawn-interception.test.ts is PRIMARY).
 *
 * Fails the build if the interactive PTY runner source reintroduces a
 * programmatic flag (constraint 5) or lets ANTHROPIC_API_KEY through without a
 * `delete` (constraint 1). Mirrors supervisor/test/no-legacy-agent-spawn.test.ts.
 *
 * Grep cannot catch a runtime-constructed violation — that is what the
 * behavioral spawn-interception harness is for. This cheap static check guards
 * the obvious literal regressions.
 */
import { describe, test, expect } from 'bun:test'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

// BRANCH-AGNOSTIC (Phase 16, R-PTY-06): the canary globs BOTH host branches so
// it holds regardless of the Task-0 verdict —
//   Option A (FALLBACK): claude-pty-runner.ts + pty-host.mjs (bundled Node host)
//   Option C (PRIMARY) : pty_host.rs (Tauri Rust ConPTY) + claude-pty-bridge.ts
// Whichever shipped, the forbidden-flag + API-key checks apply. Non-existent
// branch files are skipped so the canary never false-fails on the un-chosen one.
const SRC = join(import.meta.dir, '..', 'src', 'runners')
const RUST = join(import.meta.dir, '..', 'tauri', 'src-tauri', 'src')

// Option A host files (TS/MJS — comment syntax //, /* */).
const RUNNER = join(SRC, 'claude-pty-runner.ts')
// Phase-17 (R-PTY-12): the Codex PTY runner rides the SAME canary.
const CODEX_RUNNER = join(SRC, 'codex-pty-runner.ts')
const HOST = join(SRC, 'pty-host.mjs')
// Option C host files (Rust pty_host.rs uses //, /* */; bridge is TS).
const BRIDGE = join(SRC, 'claude-pty-bridge.ts')
const RUST_HOST = join(RUST, 'pty_host.rs')

// Every PTY-path host file across both branches that must stay clean.
const ALL_HOST_FILES = [RUNNER, CODEX_RUNNER, HOST, BRIDGE, RUST_HOST].filter((p) => existsSync(p))

// PTY RUNNERS that build a spawn env and MUST pin the API-key scrub MECHANISM in
// source (Phase-17 PARTIAL-binding / NH-4-adjacent): the absence of a literal
// `delete env.<KEY>` (or the shared `sanitizeSpawnEnv`) FAILS the build, so a
// refactor that drops the scrub is caught statically as well as behaviorally.
const PTY_RUNNERS = [RUNNER, CODEX_RUNNER].filter((p) => existsSync(p))

// Forbidden programmatic-flag tokens on the PTY path (constraint 5). We strip
// comments first so the constraint-documentation in the header does not trip
// the canary.
const FORBIDDEN_FLAGS = ['--input-format', '--output-format', '--print', 'stream-json']

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '') // block comments
    .split(/\r?\n/)
    .map((l) => l.replace(/\/\/.*$/, '')) // line comments
    .join('\n')
}

describe('Phase 15/16 canary — no API key, no stream-json flags on the PTY path', () => {
  test('at least one host branch is present (A or C)', () => {
    expect(ALL_HOST_FILES.length).toBeGreaterThan(0)
  })

  test('NO host file (A or C) contains a programmatic flag token', () => {
    for (const path of ALL_HOST_FILES) {
      const code = stripComments(readFileSync(path, 'utf-8'))
      const hits = FORBIDDEN_FLAGS.filter((f) => code.includes(f))
      expect(hits).toEqual([])
      // `-p` as a standalone argv token (quoted) must not appear in code either.
      expect(/['"]-p['"]/.test(code)).toBe(false)
    }
  })

  test('every provider API key only ever appears adjacent to a delete/remove (both branches)', () => {
    for (const path of ALL_HOST_FILES) {
      // Strip ALL comments (block + line) before scanning so the constraint
      // documentation in the headers does not trip the canary.
      const code = stripComments(readFileSync(path, 'utf-8'))
      for (const ln of code.split(/\r?\n/)) {
        if (!/\b(ANTHROPIC_API_KEY|OPENAI_API_KEY)\b/.test(ln)) continue
        // A-branch (TS/MJS): `delete env.<KEY>`.
        // C-branch (Rust): `env_remove("<KEY>")` (or `env.remove(...)`).
        const stripped = /\bdelete\b/.test(ln) || /\b(env_remove|remove|sanitizeSpawnEnv)\b/.test(ln)
        expect(stripped).toBe(true)
      }
    }
  })

  test('codex PTY runner spawns the interactive entrypoint (no headless app-server/exec)', () => {
    if (!existsSync(CODEX_RUNNER)) return
    const code = stripComments(readFileSync(CODEX_RUNNER, 'utf-8'))
    // The interactive Codex TUI is bare `codex` with EMPTY argv. The headless
    // automation entrypoints (`app-server` JSON-RPC, `exec`) belong to the
    // PRESERVED stream-json automation path — never the PTY.
    expect(/['"]app-server['"]/.test(code)).toBe(false)
    expect(/['"]exec['"]/.test(code)).toBe(false)
    // file passed to the spawn frame is the bare interactive binary.
    expect(/file:\s*'codex'/.test(code)).toBe(true)
  })

  // PARTIAL-binding / NH-4-adjacent: pin the scrub MECHANISM in each PTY runner.
  // A runner that builds a spawn env MUST contain a literal `delete env.<KEY>`
  // (or the shared `sanitizeSpawnEnv`) — not only a runtime env-object assertion.
  test('each PTY runner pins the literal API-key scrub mechanism in source', () => {
    for (const path of PTY_RUNNERS) {
      const code = stripComments(readFileSync(path, 'utf-8'))
      const hasScrub =
        /\bsanitizeSpawnEnv\b/.test(code) ||
        /\bdelete\b[^\n]*\bANTHROPIC_API_KEY\b/.test(code)
      expect(hasScrub).toBe(true)
    }
    // The Codex runner ALSO scrubs its own provider key (OPENAI_API_KEY).
    if (existsSync(CODEX_RUNNER)) {
      const code = stripComments(readFileSync(CODEX_RUNNER, 'utf-8'))
      const scrubsOpenai =
        /\bsanitizeSpawnEnv\b/.test(code) || /\bdelete\b[^\n]*\bOPENAI_API_KEY\b/.test(code)
      expect(scrubsOpenai).toBe(true)
    }
  })
})
