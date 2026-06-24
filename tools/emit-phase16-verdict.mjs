#!/usr/bin/env node
/**
 * emit-phase16-verdict.mjs — PRODUCER of the Phase-16 ship-verdict artifact
 * (H11 / NH-4 / R-PTY-32). Writes
 * `.planning/phases/16-hardened-pty-relay-and-mobile-terminal/16-VERIFICATION.md`
 * conforming to the SHARED schema pinned in 16-PLAN-002
 * §shared_verdict_artifact_schema (imported from ./phase16-verdict-schema.mjs).
 *
 * The two TEST-BOUND signals are DERIVED from REAL exit codes (never CLI args):
 *   - automated_suite.result ← `bun run check-baseline` exit code + summary line
 *   - term_relay_auth.result ← the named relay/guard/resume tests' exit codes
 * The two MANUAL signals (render_fidelity, mobile_reattach) are written PASS
 * ONLY when the operator supplies the full attestation triplet (by + at +
 * device_build) for that field. A bare PASS with no triplet is NOT expressible —
 * the script refuses (writes FAIL) without the triplet. So a hand-typed/forged
 * PASS cannot pass the gate's provenance check.
 *
 * Usage (manual attestation supplied as env, captured from the real device run):
 *   RENDER_BY=MM RENDER_AT=2026-06-01T18:10:00Z RENDER_DEVICE="Pixel8/Chrome125 0.9.0" \
 *   REATTACH_BY=MM REATTACH_AT=2026-06-01T18:12:00Z REATTACH_DEVICE="Pixel8/Chrome125 0.9.0" \
 *   node tools/emit-phase16-verdict.mjs
 *
 * Without the manual triplets, the script still runs the automated suites and
 * emits a PARTIAL/FAIL artifact (the manual fields FAIL) — honest, gate-blocking.
 */
import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { VERDICT_ARTIFACT_PATH, TERM_RELAY_TESTS, evaluateVerdict, parseFrontmatter } from './phase16-verdict-schema.mjs'

const isWin = process.platform === 'win32'

function runBaseline() {
  const r = spawnSync('bun', ['run', 'check-baseline'], { encoding: 'utf8', shell: isWin })
  const out = (r.stdout ?? '') + (r.stderr ?? '')
  // Capture the verbatim "actual: pass=… skip=… fail=… total=…" summary line.
  const m = out.match(/actual:\s*(pass=\d+\s+skip=\d+\s+fail=\d+\s+total=\d+)/)
  const summary = m ? m[1] : out.trim().split(/\r?\n/).slice(-1)[0] ?? ''
  return { result: r.status === 0 ? 'PASS' : 'FAIL', summary }
}

function runTermRelayTests() {
  const files = TERM_RELAY_TESTS.map((t) => `hub/test/${t}.test.ts`)
  const r = spawnSync('bun', ['test', ...files], {
    encoding: 'utf8',
    shell: isWin,
    env: { ...process.env, JWT_SECRET: process.env.JWT_SECRET || 'test-jwt-secret-at-least-32-chars-long-xx' },
  })
  return { result: r.status === 0 ? 'PASS' : 'FAIL' }
}

function manualField(byEnv, atEnv, deviceEnv) {
  const by = process.env[byEnv]
  const at = process.env[atEnv]
  const device_build = process.env[deviceEnv]
  // PASS only when the FULL triplet is supplied; otherwise FAIL (un-forgeable).
  if (by && at && device_build) {
    return { value: 'PASS', triplet: { by, at, device_build } }
  }
  return { value: 'FAIL', triplet: null }
}

function now() { return new Date().toISOString() }

function main() {
  const automated = runBaseline()
  const relay = runTermRelayTests()
  const render = manualField('RENDER_BY', 'RENDER_AT', 'RENDER_DEVICE')
  const reattach = manualField('REATTACH_BY', 'REATTACH_AT', 'REATTACH_DEVICE')

  const allPass =
    automated.result === 'PASS' &&
    relay.result === 'PASS' &&
    render.value === 'PASS' &&
    reattach.value === 'PASS'
  const anyFail =
    automated.result === 'FAIL' || relay.result === 'FAIL' ||
    render.value === 'FAIL' || reattach.value === 'FAIL'
  const verdict = allPass ? 'PASS' : anyFail ? 'PARTIAL' : 'PARTIAL'

  const lines = []
  lines.push('---')
  lines.push(`verdict: ${verdict}`)
  lines.push(`render_fidelity: ${render.value}`)
  lines.push(`mobile_reattach: ${reattach.value}`)
  lines.push('automated_suite:')
  lines.push(`  result: ${automated.result}`)
  lines.push('  command: "bun run check-baseline"')
  lines.push(`  summary: "${automated.summary.replace(/"/g, "'")}"`)
  lines.push(`  run_at: "${now()}"`)
  lines.push('term_relay_auth:')
  lines.push(`  result: ${relay.result}`)
  lines.push(`  tests: [${TERM_RELAY_TESTS.join(', ')}]`)
  lines.push(`  run_at: "${now()}"`)
  lines.push('manual_attestation:')
  if (render.triplet) {
    lines.push(`  render_fidelity: { by: "${render.triplet.by}", at: "${render.triplet.at}", device_build: "${render.triplet.device_build}" }`)
  } else {
    lines.push('  render_fidelity: { by: "", at: "", device_build: "" }')
  }
  if (reattach.triplet) {
    lines.push(`  mobile_reattach: { by: "${reattach.triplet.by}", at: "${reattach.triplet.at}", device_build: "${reattach.triplet.device_build}" }`)
  } else {
    lines.push('  mobile_reattach: { by: "", at: "", device_build: "" }')
  }
  lines.push('---')
  lines.push('')
  lines.push('# Phase 16 — Ship Verdict (machine-emitted; do NOT hand-edit)')
  lines.push('')
  lines.push('This artifact is EMITTED by `tools/emit-phase16-verdict.mjs`. The two automated')
  lines.push('signals are bound to real `bun run check-baseline` / named-test exit codes; the two')
  lines.push('manual signals require an operator attestation triplet (by + ISO-8601 at + device/build).')
  lines.push('The Phase-17 `cutover-deletion-gate.mjs` consumes THIS file via the shared schema.')
  lines.push('')

  const content = lines.join('\n')
  writeFileSync(VERDICT_ARTIFACT_PATH, content, 'utf8')

  // Self-verify the emitted artifact against the shared evaluator.
  const evald = evaluateVerdict(parseFrontmatter(content))
  console.log(`[emit-phase16-verdict] wrote ${VERDICT_ARTIFACT_PATH}`)
  console.log(`  verdict=${verdict} automated=${automated.result} relay=${relay.result} render=${render.value} reattach=${reattach.value}`)
  console.log(`  gate-pass=${evald.pass}${evald.pass ? '' : ' reasons=' + evald.reasons.join(',')}`)
  // Exit non-zero when the verdict is not a full PASS so CI can gate on it.
  process.exit(evald.pass ? 0 : 1)
}

main()
