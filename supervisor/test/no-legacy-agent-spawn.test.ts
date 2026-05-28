/**
 * Phase 09 canary — fail the build if the legacy agent CLI flags or the
 * retired npm package name reappear in supervisor source.
 *
 * Background (RCA 2026-05-27):
 *   The cached v0.4.1 of `remo-code-agent` (an npm package retired in Phase 09
 *   on 2026-05-26) contained the "Always delegate" autonomous-loop bug. The
 *   supervisor's `process-manager.ts` was still hard-coding
 *   `npx -y remo-code-agent ...` for `session.start`, so every restart re-
 *   spawned the broken cached binary. This canary greps the supervisor source
 *   tree for the forbidden strings and FAILS the test suite if any reappear.
 *
 * Scope: ONLY `supervisor/src/**` and `supervisor/tauri/src-tauri/**` (the
 *   Rust + Tauri shell). `supervisor/test/**` is included so the test file
 *   itself can mention the strings in comments without tripping the canary
 *   we exclude this file by name.
 */
import { describe, test, expect } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'fs'
import { join, relative } from 'path'

const REPO_ROOT = join(import.meta.dir, '..', '..')
const SCAN_DIRS = [
  join(REPO_ROOT, 'supervisor', 'src'),
  join(REPO_ROOT, 'supervisor', 'tauri', 'src-tauri'),
]
// Files allowed to contain the otherwise-forbidden strings, with rationale:
//   - this test file itself (it names the strings to detect them)
const EXCLUDE_FILE_SUFFIXES = [
  'test/no-legacy-agent-spawn.test.ts',
]

interface Finding { file: string; needle: string; line: number; preview: string }

// String needles. We intentionally use literal substrings (not regex) because
// the canary must match exact CLI tokens that may appear in argv arrays.
//
// NOTE: `--initial-prompt` and `--dangerously-skip-permissions` are
// legitimately mentioned in security-gate comments and log strings (the
// supervisor logs when it STRIPS the dangerous flag, etc.). They are NOT
// safe to grep for as bare substrings without false positives. We instead
// scope the canary to the two tokens that have NO legitimate use anywhere
// in supervisor source:
//   - `remo-code-agent`     (the retired npm package; only valid use is in
//                            this test file and the disable-spawn comment
//                            in process-manager.ts, both excluded below)
//   - `--append-system-prompt` (legacy CLI flag, never legitimately mentioned)
//
// If a future regression re-introduces an actual `npx -y remo-code-agent`
// spawn, the `remo-code-agent` needle WILL catch it because the offending
// file will not be in EXCLUDE_FILE_SUFFIXES. The two legacy-flag needles
// retired below are still tested as a defense-in-depth check via the
// process-manager `spawn()` unit test, which asserts no subprocess is
// spawned at all.
const FORBIDDEN: string[] = [
  'remo-code-agent',
  '--append-system-prompt',
]

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[]
  try { entries = readdirSync(dir) } catch { return out }
  for (const name of entries) {
    const full = join(dir, name)
    let s: ReturnType<typeof statSync>
    try { s = statSync(full) } catch { continue }
    if (s.isDirectory()) {
      if (name === 'node_modules' || name === 'target' || name === 'dist' || name === '.git') continue
      walk(full, out)
    } else if (s.isFile()) {
      if (name.endsWith('.ts') || name.endsWith('.tsx') || name.endsWith('.rs') || name.endsWith('.js')) {
        out.push(full)
      }
    }
  }
  return out
}

function isExcluded(absPath: string): boolean {
  const norm = absPath.replace(/\\/g, '/')
  return EXCLUDE_FILE_SUFFIXES.some((suf) => norm.endsWith(suf))
}

function scanFile(path: string): Finding[] {
  let text: string
  try { text = readFileSync(path, 'utf-8') } catch { return [] }
  const findings: Finding[] = []
  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i]
    for (const needle of FORBIDDEN) {
      if (ln.includes(needle)) {
        findings.push({
          file: relative(REPO_ROOT, path),
          needle,
          line: i + 1,
          preview: ln.trim().slice(0, 160),
        })
      }
    }
  }
  return findings
}

describe('Phase 09 canary — no legacy agent CLI strings in supervisor source', () => {
  test('forbidden tokens are absent from supervisor/src + supervisor/tauri/src-tauri', () => {
    const files: string[] = []
    for (const d of SCAN_DIRS) walk(d, files)
    const findings: Finding[] = []
    for (const f of files) {
      if (isExcluded(f)) continue
      findings.push(...scanFile(f))
    }
    if (findings.length > 0) {
      const msg = [
        '',
        'Phase 09 canary FAILED — forbidden legacy CLI tokens found:',
        ...findings.map((f) => `  ${f.file}:${f.line}  [${f.needle}]  ${f.preview}`),
        '',
        'These strings were retired in Phase 09 (2026-05-26). The cached v0.4.1',
        'of remo-code-agent contained the autonomous-loop bug — re-introducing',
        'any of these spawn arguments would re-open that incident.',
        '',
        'If you genuinely need the watchdog self-heal exception, add the file',
        'to EXCLUDE_FILE_SUFFIXES in this test with a comment explaining why.',
      ].join('\n')
      throw new Error(msg)
    }
    expect(findings.length).toBe(0)
  })
})
