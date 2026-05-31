/**
 * QC findings schema (auto-dev P4).
 *
 * The `qc_review` step (and a bare `qc` root, which renders the same review
 * prompt) emits a `<<FINDINGS ... FINDINGS>>` block at the end of its turn. The
 * post-run router parses it: ≥1 actionable finding → chain `qc_fix`; zero
 * findings → finalize clean. Mirrors the `<<DECISION>>` convention in
 * `controller-schema.ts` (block extraction + tolerant line parsing).
 *
 * Robustness: tolerant of surrounding prose, a missing block, malformed lines.
 * A missing/unparseable block yields ZERO findings (safe: nothing to fix) rather
 * than throwing — the routine just finalizes clean and re-reviews next tick.
 */
import { z } from 'zod'
import { createHash } from 'node:crypto'

export const FindingSeverity = z.enum(['low', 'medium', 'high', 'critical'])
export type FindingSeverity = z.infer<typeof FindingSeverity>

export const FindingType = z.enum(['correctness', 'reuse', 'security'])
export type FindingType = z.infer<typeof FindingType>

export interface QcFinding {
  severity: FindingSeverity
  /** `path` or `path:line` as reported by the reviewer. */
  file: string
  finding_type: FindingType
  root_cause: string
  suggested_fix: string
}

// Open marker `<<FINDINGS`, body, then a closing `FINDINGS` (bare) or
// `FINDINGS>>`, matched at a line boundary so the word inside the body doesn't
// terminate the block early. Same shape as controller-schema's BLOCK_RE.
const BLOCK_RE = /<<FINDINGS\b([\s\S]*?)(?:^|\n)\s*FINDINGS(?:>>)?(?:\s|$)/i

/**
 * Match the full `<<FINDINGS … FINDINGS>>` block (including markers) within a
 * larger reply. Used by the agent sender to preserve the block in the run's
 * output_snippet (default head-truncation would otherwise drop it). Returns the
 * matched block text, or null when no block is present.
 */
export function extractFindingsBlock(raw: string): string | null {
  const m = (raw ?? '').match(/<<FINDINGS\b[\s\S]*?(?:^|\n)\s*FINDINGS(?:>>)?(?:\s|$)/i)
  return m ? m[0].trimEnd() : null
}

/** Parse one `key=value; key=value` finding line into a field map. */
function parseFindingFields(line: string): Record<string, string> {
  const fields: Record<string, string> = {}
  for (const pair of line.split(';')) {
    const idx = pair.indexOf('=')
    if (idx === -1) continue
    const key = pair.slice(0, idx).trim().toLowerCase()
    const val = pair.slice(idx + 1).trim()
    if (key) fields[key] = val
  }
  return fields
}

/**
 * Parse the reviewer's `<<FINDINGS ... FINDINGS>>` block into a list of
 * structured findings. Lines that don't validate (bad severity / type, missing
 * file) are skipped — a malformed line never poisons the whole batch. A missing
 * block or a block with no valid `finding:` lines returns `[]` (clean).
 */
export function parseQcFindings(raw: string): QcFinding[] {
  const text = raw ?? ''
  const m = text.match(BLOCK_RE)
  if (!m) return []

  const findings: QcFinding[] = []
  for (const rawLine of m[1].split('\n')) {
    const line = rawLine.trim()
    // Only lines that start with `finding:` carry a finding.
    const fm = line.match(/^finding\s*:\s*(.+)$/i)
    if (!fm) continue

    const f = parseFindingFields(fm[1])
    const sev = FindingSeverity.safeParse((f.severity ?? '').toLowerCase())
    const typ = FindingType.safeParse((f.finding_type ?? '').toLowerCase())
    const file = (f.file ?? '').trim()
    if (!sev.success || !typ.success || !file) continue

    findings.push({
      severity: sev.data,
      file,
      finding_type: typ.data,
      root_cause: f.root_cause ?? '',
      suggested_fix: f.suggested_fix ?? '',
    })
  }
  return findings
}

/**
 * Idempotency hash for a finding within a repo: sha256(`repo|file|finding_type|top_line`).
 * `top_line` is the first `:N` in `file` (the line number), or '' when absent — so the
 * same root-cause finding hashes stably across review runs. Mirrors the
 * `github_issue_idempotency` hash recipe.
 */
export function findingHash(repo: string, finding: QcFinding): string {
  const topLine = finding.file.match(/:(\d+)/)?.[1] ?? ''
  return createHash('sha256')
    .update(`${repo}|${finding.file}|${finding.finding_type}|${topLine}`)
    .digest('hex')
}
