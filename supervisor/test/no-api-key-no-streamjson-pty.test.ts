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
import { readFileSync } from 'fs'
import { join } from 'path'

const RUNNER = join(import.meta.dir, '..', 'src', 'runners', 'claude-pty-runner.ts')
const HOST = join(import.meta.dir, '..', 'src', 'runners', 'pty-host.mjs')

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

describe('Phase 15 canary — no API key, no stream-json flags on the PTY path', () => {
  test('claude-pty-runner.ts code contains no programmatic flag tokens', () => {
    const code = stripComments(readFileSync(RUNNER, 'utf-8'))
    const hits = FORBIDDEN_FLAGS.filter((f) => code.includes(f))
    expect(hits).toEqual([])
    // `-p` as a standalone argv token (quoted) must not appear in code either.
    expect(/['"]-p['"]/.test(code)).toBe(false)
  })

  test('ANTHROPIC_API_KEY only ever appears adjacent to a delete (runner + host)', () => {
    for (const path of [RUNNER, HOST]) {
      // Strip ALL comments (block + line) before scanning so the constraint
      // documentation in the headers does not trip the canary.
      const code = stripComments(readFileSync(path, 'utf-8'))
      for (const ln of code.split(/\r?\n/)) {
        if (!ln.includes('ANTHROPIC_API_KEY')) continue
        expect(/delete\b/.test(ln)).toBe(true)
      }
    }
  })
})
