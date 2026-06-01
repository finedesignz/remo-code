#!/usr/bin/env node
/**
 * cutover-deletion-gate.mjs — CONSUMER of the Phase-16 ship-verdict artifact
 * (H11 / NH-4). The Phase-17 ChatSurface rip-and-replace deletion is GATED on
 * this script exiting 0.
 *
 * SCOPE NOTE: Phase 16 ships the PRODUCER (emit-phase16-verdict.mjs) + this
 * minimal gate that enforces the shared GATE-PASS RULE. Phase 17 / 17-PLAN-002
 * T1 OWNS this gate and extends it with the actual deletion-allow logic; the
 * verdict-evaluation contract is pinned ONCE in ./phase16-verdict-schema.mjs so
 * producer and consumer cannot drift.
 *
 * Reads the FIXED artifact path, evaluates it against the shared rule, and:
 *   - exit 0  → verdict fully green with complete provenance → deletions allowed
 *   - exit 1  → missing file / any FAIL / absent provenance / incomplete
 *               attestation triplet → ABORT (zero deletions)
 *
 * A hand-edited artifact missing a provenance block (e.g. a bare
 * `render_fidelity: PASS` with no attestation triplet) FAILS the provenance
 * check — the forgery is detectable.
 */
import { VERDICT_ARTIFACT_PATH, evaluateVerdictFile } from './phase16-verdict-schema.mjs'

// Allow an explicit path arg (tests pass a fixture); default to the pinned path.
const path = process.argv[2] || VERDICT_ARTIFACT_PATH
const { pass, reasons } = evaluateVerdictFile(path)

if (pass) {
  console.log(`[cutover-deletion-gate] PASS — ${path} is fully green with provenance. Deletions allowed.`)
  process.exit(0)
} else {
  console.error(`[cutover-deletion-gate] ABORT — ${path} did not pass the gate. reasons: ${reasons.join(', ')}`)
  process.exit(1)
}
