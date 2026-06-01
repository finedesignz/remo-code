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
const HOST = join(SRC, 'pty-host.mjs')
// Option C host files (Rust pty_host.rs uses //, /* */; bridge is TS).
const BRIDGE = join(SRC, 'claude-pty-bridge.ts')
const RUST_HOST = join(RUST, 'pty_host.rs')

// Every PTY-path host file across both branches that must stay clean.
const ALL_HOST_FILES = [RUNNER, HOST, BRIDGE, RUST_HOST].filter((p) => existsSync(p))

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

  test('ANTHROPIC_API_KEY only ever appears adjacent to a delete/remove (both branches)', () => {
    for (const path of ALL_HOST_FILES) {
      // Strip ALL comments (block + line) before scanning so the constraint
      // documentation in the headers does not trip the canary.
      const code = stripComments(readFileSync(path, 'utf-8'))
      for (const ln of code.split(/\r?\n/)) {
        if (!ln.includes('ANTHROPIC_API_KEY')) continue
        // A-branch (TS/MJS): `delete env.ANTHROPIC_API_KEY`.
        // C-branch (Rust): `env_remove("ANTHROPIC_API_KEY")` (or `env.remove(...)`).
        const stripped = /\bdelete\b/.test(ln) || /\b(env_remove|remove)\b/.test(ln)
        expect(stripped).toBe(true)
      }
    }
  })
})
