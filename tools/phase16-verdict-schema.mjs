/**
 * phase16-verdict-schema.mjs — SINGLE SOURCE OF TRUTH for the Phase-16 →
 * Phase-17 verdict-artifact contract (H11 / NH-4 / R-PTY-32).
 *
 * Pinned by `16-PLAN-002 §shared_verdict_artifact_schema`. BOTH sides import
 * THIS module so they cannot drift:
 *   - PRODUCER: tools/emit-phase16-verdict.mjs (Phase 16, Task 5)
 *   - CONSUMER: tools/cutover-deletion-gate.mjs (Phase 17 / 17-PLAN-002 T1)
 *
 * The artifact lives at the FIXED path below with YAML frontmatter. No deps.
 */
import { readFileSync, existsSync } from 'node:fs'

export const VERDICT_ARTIFACT_PATH =
  '.planning/phases/16-hardened-pty-relay-and-mobile-terminal/16-VERIFICATION.md'

/** The named test files whose REAL exit codes back `term_relay_auth.result`. */
export const TERM_RELAY_TESTS = [
  'term-relay-auth',
  'term-relay-human-guard',
  'term-agent-inventory-auth',
  'term-frame-direction-allowlist',
  'term-ws-origin-guard',
  'pty-runner-resume-identity',
]

/**
 * Minimal YAML-frontmatter parser (flat keys + one level of nesting + inline
 * `{ ... }` maps + `[ ... ]` arrays). Sufficient for THIS pinned schema; no YAML
 * dep. Returns the parsed frontmatter object.
 */
export function parseFrontmatter(md) {
  const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!m) return null
  const body = m[1]
  const root = {}
  const stack = [{ indent: -1, obj: root }]
  for (const rawLine of body.split(/\r?\n/)) {
    if (!rawLine.trim() || rawLine.trim().startsWith('#')) continue
    const indent = rawLine.length - rawLine.trimStart().length
    const line = rawLine.trim()
    const colon = line.indexOf(':')
    if (colon < 0) continue
    const key = line.slice(0, colon).trim()
    let val = line.slice(colon + 1).trim()
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop()
    const parent = stack[stack.length - 1].obj
    if (val === '') {
      const child = {}
      parent[key] = child
      stack.push({ indent, obj: child })
    } else {
      parent[key] = parseScalar(val)
    }
  }
  return root
}

function parseScalar(val) {
  // strip surrounding quotes
  if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
    return val.slice(1, -1)
  }
  // inline array
  if (val.startsWith('[') && val.endsWith(']')) {
    const inner = val.slice(1, -1).trim()
    if (!inner) return []
    return inner.split(',').map((s) => parseScalar(s.trim()))
  }
  // inline object { k: v, k2: v2 }
  if (val.startsWith('{') && val.endsWith('}')) {
    const inner = val.slice(1, -1).trim()
    const obj = {}
    if (inner) {
      for (const pair of splitTopLevel(inner)) {
        const c = pair.indexOf(':')
        if (c < 0) continue
        obj[pair.slice(0, c).trim()] = parseScalar(pair.slice(c + 1).trim())
      }
    }
    return obj
  }
  return val
}

function splitTopLevel(s) {
  const out = []
  let depth = 0
  let cur = ''
  for (const ch of s) {
    if (ch === '{' || ch === '[') depth++
    else if (ch === '}' || ch === ']') depth--
    if (ch === ',' && depth === 0) { out.push(cur); cur = '' } else cur += ch
  }
  if (cur.trim()) out.push(cur)
  return out
}

function isCompleteTriplet(t) {
  return !!t && typeof t === 'object' && !!t.by && !!t.at && !!t.device_build
}

/**
 * THE GATE-PASS RULE (consumed by cutover-deletion-gate.mjs). Returns
 * `{ pass: boolean, reasons: string[] }`. Exit 0 (deletions allowed) ONLY when
 * pass === true.
 *
 * pass ⇔ verdict==PASS AND render_fidelity==PASS AND mobile_reattach==PASS AND
 * automated_suite.result==PASS AND term_relay_auth.result==PASS AND each
 * manual_attestation.<field> carries a complete {by, at, device_build} triplet.
 * Missing file / any FAIL / absent provenance / incomplete triplet ⇒ fail.
 */
export function evaluateVerdict(frontmatter) {
  const reasons = []
  const fm = frontmatter
  if (!fm) return { pass: false, reasons: ['missing_or_unparseable_frontmatter'] }
  if (fm.verdict !== 'PASS') reasons.push(`verdict=${fm.verdict}`)
  if (fm.render_fidelity !== 'PASS') reasons.push(`render_fidelity=${fm.render_fidelity}`)
  if (fm.mobile_reattach !== 'PASS') reasons.push(`mobile_reattach=${fm.mobile_reattach}`)
  if (!fm.automated_suite || fm.automated_suite.result !== 'PASS') reasons.push('automated_suite!=PASS')
  if (!fm.automated_suite || !fm.automated_suite.summary) reasons.push('automated_suite.summary_missing')
  if (!fm.term_relay_auth || fm.term_relay_auth.result !== 'PASS') reasons.push('term_relay_auth!=PASS')
  const ma = fm.manual_attestation
  if (!ma) reasons.push('manual_attestation_missing')
  else {
    if (!isCompleteTriplet(ma.render_fidelity)) reasons.push('render_fidelity_attestation_incomplete')
    if (!isCompleteTriplet(ma.mobile_reattach)) reasons.push('mobile_reattach_attestation_incomplete')
  }
  return { pass: reasons.length === 0, reasons }
}

/** Convenience: read + parse + evaluate the artifact at a given path. */
export function evaluateVerdictFile(path = VERDICT_ARTIFACT_PATH) {
  if (!existsSync(path)) return { pass: false, reasons: ['artifact_missing'] }
  const md = readFileSync(path, 'utf8')
  return evaluateVerdict(parseFrontmatter(md))
}
