/**
 * Phase 16 (H11 / NH-4 / R-PTY-32) — the EMITTED verdict artifact validates
 * against the SAME schema the Phase-17 cutover gate consumes, and a forged /
 * provenance-stripped artifact is REJECTED.
 *
 * Round-trips fixtures through tools/cutover-deletion-gate.mjs (the real
 * consumer) via the shared schema module — proving producer/consumer cannot
 * drift (one schema, referenced by both) and that a hand-typed PASS without the
 * attestation triplet is detectable (provenance check).
 */
import { describe, test, expect } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const REPO_ROOT = join(import.meta.dir, '..', '..')
const GATE = join(REPO_ROOT, 'tools', 'cutover-deletion-gate.mjs')
const isWin = process.platform === 'win32'

function runGate(artifactPath: string): number {
  const r = spawnSync('node', [GATE, artifactPath], { encoding: 'utf8', shell: isWin })
  return r.status ?? -1
}

function tmpArtifact(content: string): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'p16verdict-'))
  const path = join(dir, '16-VERIFICATION.md')
  writeFileSync(path, content, 'utf8')
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

const FULLY_GREEN = `---
verdict: PASS
render_fidelity: PASS
mobile_reattach: PASS
automated_suite:
  result: PASS
  command: "bun run check-baseline"
  summary: "pass=1177 skip=130 fail=0 total=1307"
  run_at: "2026-06-01T15:00:00Z"
term_relay_auth:
  result: PASS
  tests: [term-relay-auth, term-relay-human-guard, term-agent-inventory-auth, term-frame-direction-allowlist, term-ws-origin-guard, pty-runner-resume-identity]
  run_at: "2026-06-01T15:00:10Z"
manual_attestation:
  render_fidelity: { by: "MM", at: "2026-06-01T15:10:00Z", device_build: "Pixel8/Chrome125 0.9.0" }
  mobile_reattach: { by: "MM", at: "2026-06-01T15:12:00Z", device_build: "Pixel8/Chrome125 0.9.0" }
---

# fully green
`

// Forged: bare PASS verdict + PASS manual flags but NO attestation triplets.
const FORGED_NO_PROVENANCE = `---
verdict: PASS
render_fidelity: PASS
mobile_reattach: PASS
automated_suite:
  result: PASS
  command: "bun run check-baseline"
  summary: "pass=1177 skip=130 fail=0 total=1307"
  run_at: "2026-06-01T15:00:00Z"
term_relay_auth:
  result: PASS
  tests: [term-relay-auth]
  run_at: "2026-06-01T15:00:10Z"
manual_attestation:
  render_fidelity: { by: "", at: "", device_build: "" }
  mobile_reattach: { by: "", at: "", device_build: "" }
---

# forged — hand-typed PASS, no attestation triplet
`

// A red automated suite must abort even with full manual provenance.
const RED_AUTOMATED = FULLY_GREEN.replace('  result: PASS\n  command', '  result: FAIL\n  command')

describe('Phase 16 — verdict artifact ↔ cutover gate round-trip (H11/NH-4)', () => {
  test('a fully-green emitted artifact PASSES the real gate (exit 0)', () => {
    const { path, cleanup } = tmpArtifact(FULLY_GREEN)
    try {
      expect(runGate(path)).toBe(0)
    } finally { cleanup() }
  })

  test('a forged artifact missing the attestation provenance is REJECTED (exit 1)', () => {
    const { path, cleanup } = tmpArtifact(FORGED_NO_PROVENANCE)
    try {
      expect(runGate(path)).toBe(1)
    } finally { cleanup() }
  })

  test('a red automated_suite ABORTS the gate even with full manual provenance', () => {
    const { path, cleanup } = tmpArtifact(RED_AUTOMATED)
    try {
      expect(runGate(path)).toBe(1)
    } finally { cleanup() }
  })

  test('a missing artifact file aborts the gate (exit 1)', () => {
    expect(runGate(join(tmpdir(), 'does-not-exist-16-VERIFICATION.md'))).toBe(1)
  })
})
