/**
 * cutover-deletion-gate.test.ts — proves the Phase-17 one-way-door gate
 * (tools/cutover-deletion-gate.mjs) aborts on every non-green / forged verdict
 * and passes ONLY on a fully-green, provenance-complete verdict.
 *
 * The gate is the mechanical Layer-1 safeguard (T-17-04/04b): it reads the
 * Phase-16 ship-verdict artifact and exits non-zero — aborting the ChatSurface
 * deletion task — unless the shared GATE-PASS RULE holds. These fixtures cover
 * the seven cases pinned in 17-PLAN-002 Task 1.
 */
import { describe, test, expect } from 'bun:test'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'

const REPO_ROOT = join(import.meta.dir, '..', '..')
const GATE = join(REPO_ROOT, 'tools', 'cutover-deletion-gate.mjs')

/** Run the gate against an explicit verdict-file path; return exit code. */
function runGate(verdictPath: string): number {
  const r = spawnSync('node', [GATE, verdictPath], { encoding: 'utf8' })
  return r.status ?? -1
}

/** Write a verdict markdown file with the given frontmatter object. */
function writeVerdict(fm: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'cutover-gate-'))
  const path = join(dir, '16-VERIFICATION.md')
  writeFileSync(path, `---\n${fm}\n---\n\n# fixture\n`, 'utf8')
  return path
}

const COMPLETE_TRIPLET = '{ by: "Michael", at: "2026-06-01T12:00:00Z", device_build: "iPhone 15 / 0.8.2" }'

const GREEN = `verdict: PASS
render_fidelity: PASS
mobile_reattach: PASS
automated_suite:
  result: PASS
  command: "bun run check-baseline"
  summary: "pass=1181 skip=130 fail=0 total=1311"
  run_at: "2026-06-01T15:19:48.545Z"
term_relay_auth:
  result: PASS
  tests: [term-relay-auth, term-relay-human-guard]
  run_at: "2026-06-01T15:19:48.545Z"
manual_attestation:
  render_fidelity: ${COMPLETE_TRIPLET}
  mobile_reattach: ${COMPLETE_TRIPLET}`

describe('Phase 17 one-way-door gate — cutover-deletion-gate.mjs', () => {
  test('(a) fully-green verdict ⇒ exit 0 (deletions allowed)', () => {
    expect(runGate(writeVerdict(GREEN))).toBe(0)
  })

  test('(b) missing file ⇒ non-zero', () => {
    expect(runGate(join(tmpdir(), 'does-not-exist-xyz', '16-VERIFICATION.md'))).not.toBe(0)
  })

  test('(c) verdict: FAIL ⇒ non-zero', () => {
    expect(runGate(writeVerdict(GREEN.replace('verdict: PASS', 'verdict: FAIL')))).not.toBe(0)
  })

  test('(d) verdict PASS but mobile_reattach absent ⇒ non-zero', () => {
    const fm = GREEN.replace('mobile_reattach: PASS\n', '')
    expect(runGate(writeVerdict(fm))).not.toBe(0)
  })

  test('(e) verdict PASS but render_fidelity: FAIL ⇒ non-zero (CI-green-but-renders-wrong)', () => {
    expect(runGate(writeVerdict(GREEN.replace('render_fidelity: PASS', 'render_fidelity: FAIL')))).not.toBe(0)
  })

  test('(f) both manual fields PASS but automated_suite block ABSENT ⇒ non-zero (provenance)', () => {
    const fm = GREEN.replace(
      /automated_suite:\n( {2}.*\n)+/,
      '',
    )
    expect(runGate(writeVerdict(fm))).not.toBe(0)
  })

  test('(g) render_fidelity PASS with NO attestation triplet ⇒ non-zero (forgery rejected)', () => {
    // Bare hand-typed PASS, manual_attestation triplets emptied.
    const fm = GREEN.replace(
      /manual_attestation:\n( {2}.*\n?)+/,
      'manual_attestation:\n  render_fidelity: { by: "", at: "", device_build: "" }\n  mobile_reattach: { by: "", at: "", device_build: "" }',
    )
    expect(runGate(writeVerdict(fm))).not.toBe(0)
  })

  test('the REAL Phase-16 artifact currently ABORTS the gate (PARTIAL, attestations empty)', () => {
    const real = join(REPO_ROOT, '.planning', 'phases', '16-hardened-pty-relay-and-mobile-terminal', '16-VERIFICATION.md')
    expect(runGate(real)).not.toBe(0)
  })
})
