/**
 * Risk classifier (Phase 5).
 *
 * Heuristic-first classifier over a unified diff + soft-flags from the
 * diff-sandbox. Returns `minor | major | breaking` plus a short rationale.
 *
 * D6 in the plan: minor → auto-merge → auto-deploy; major/breaking → PR for
 * human review, no deploy.
 *
 * LLM escalation is a Phase-6 follow-up (see plan doc). The classifier
 * accepts an optional `llm` callback so the wiring stays additive — current
 * call sites pass `undefined` and the heuristic outcome stands.
 */
import type { DiffAnalysis } from './diff-sandbox.ts'

export type RiskClass = 'minor' | 'major' | 'breaking'

export interface RiskResult {
  riskClass: RiskClass
  rationale: string
  /** True when the heuristic would benefit from LLM second-opinion (Phase 6). */
  llmEscalated: boolean
}

export interface LlmEscalator {
  classify(diff: string): Promise<RiskClass | null>
}

// Path-based signals.
const MINOR_PATH_RX = [
  /\.(css|scss|less|md|markdown|txt|json5)$/i,
]
const MAJOR_PATH_RX = [
  /(^|\/)migrations?\//i,
  /\.sql$/i,
  /(^|\/)(package-lock\.json|bun\.lockb?|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|poetry\.lock)$/,
]
// Route file *additions or removals* are major; pure edits remain whatever
// the content heuristic says.
const ROUTE_PATH_RX = /(^|\/)(routes|app|pages|src\/routes)\/.+\.(ts|tsx|js|jsx|svelte|vue)$/i
const ENV_EXAMPLE_RX = /(^|\/)\.env\.example$/i
const HUB_SRC_EXPORT_RX = /(^|\/)hub\/src\/.+\.ts$/

// Heuristic: is this hunk text mostly CSS-class additions / copy-string edits
// (i.e. cosmetic) within a JS/TS/Svelte file?
function diffIsCosmetic(diff: string): boolean {
  const lines = diff.split('\n').filter((l) =>
    (l.startsWith('+') || l.startsWith('-')) &&
    !l.startsWith('+++') && !l.startsWith('---'),
  )
  if (lines.length === 0) return false
  let cosmetic = 0
  for (const ln of lines) {
    const body = ln.slice(1).trim()
    if (!body) { cosmetic++; continue }
    // CSS class tweak: `className="..."` or `class="..."`
    if (/className\s*=|class=/.test(body)) { cosmetic++; continue }
    // tailwind class addition inside curlies
    if (/^['"`][\w\s\-:/[\]]+['"`]/.test(body)) { cosmetic++; continue }
    // simple string literal change (copy edit)
    if (/^[+\-]?\s*['"`][^'"`]*['"`]\s*[,;)]?\s*$/.test(ln)) { cosmetic++; continue }
  }
  return cosmetic / lines.length >= 0.7
}

/**
 * Detect new or removed exported symbols in `hub/src/**`. This is the
 * "public API" surface for the orchestrator — additions/removals there are
 * breaking by convention because dependent modules pin imports.
 */
function exportedSymbolsChanged(diff: string): { added: string[]; removed: string[] } {
  const added: string[] = []
  const removed: string[] = []
  // Walk diff sections file-by-file; only count when the path matches
  // `hub/src/**.ts`.
  const sections = diff.split(/^diff --git /gm).slice(1)
  for (const section of sections) {
    const head = section.split('\n', 1)[0]
    const m = /a\/(\S+) b\/(\S+)/.exec(head)
    if (!m) continue
    const path = m[2] || m[1]
    if (!HUB_SRC_EXPORT_RX.test(path)) continue
    for (const ln of section.split('\n')) {
      // Examples: `+export function foo(`, `+export const bar =`, `+export class Baz`
      const exportRx = /^([+\-])\s*export\s+(?:async\s+)?(?:function|const|let|var|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/
      const em = exportRx.exec(ln)
      if (!em) continue
      if (em[1] === '+') added.push(em[2])
      else removed.push(em[2])
    }
  }
  return { added, removed }
}

function envExampleChanged(files: string[]): boolean {
  return files.some((f) => ENV_EXAMPLE_RX.test(f))
}

function routeFileStructureChanged(diff: string, files: string[]): boolean {
  // True if a route file is added or deleted (new file mode / deleted file mode header).
  const sections = diff.split(/^diff --git /gm).slice(1)
  for (const section of sections) {
    const head = section.split('\n', 2)
    const firstLine = head[0]
    const m = /a\/(\S+) b\/(\S+)/.exec(firstLine)
    if (!m) continue
    const path = m[2] || m[1]
    if (!ROUTE_PATH_RX.test(path)) continue
    if (/^new file mode /m.test(section) || /^deleted file mode /m.test(section)) return true
  }
  return false
}

/**
 * Heuristic-first classifier.
 *
 * Ordering: breaking > major > minor. First match wins.
 */
export async function classifyRisk(
  analysis: DiffAnalysis,
  opts: { llm?: LlmEscalator } = {},
): Promise<RiskResult> {
  const { diffText, fileSummary, softFlags } = analysis
  const files = fileSummary.files

  const reasons: string[] = []

  // (1) Breaking: env-example change, exported symbol churn, route add/delete.
  if (envExampleChanged(files)) {
    reasons.push('env_example_changed')
  }
  const exp = exportedSymbolsChanged(diffText)
  if (exp.added.length > 0 || exp.removed.length > 0) {
    reasons.push(`exports_changed:+${exp.added.join(',')}|-${exp.removed.join(',')}`)
  }
  if (routeFileStructureChanged(diffText, files)) {
    reasons.push('route_file_added_or_deleted')
  }
  if (reasons.length > 0) {
    return { riskClass: 'breaking', rationale: reasons.join('; '), llmEscalated: false }
  }

  // (2) Major: migrations, lockfile, dep-bump soft-flag, schema, sql.
  const majorPathHits = files.filter((f) => MAJOR_PATH_RX.some((rx) => rx.test(f)))
  if (majorPathHits.length > 0) {
    reasons.push(`major_path:${majorPathHits.join(',')}`)
  }
  if (softFlags.length > 0) {
    reasons.push(`soft_flags:${softFlags.join(',')}`)
  }
  if (reasons.length > 0) {
    return { riskClass: 'major', rationale: reasons.join('; '), llmEscalated: false }
  }

  // (3) Minor candidate: all files match minor-path patterns OR diff is cosmetic.
  const allMinorPath = files.length > 0 && files.every((f) => MINOR_PATH_RX.some((rx) => rx.test(f)))
  const cosmetic = diffIsCosmetic(diffText)

  // LLM escalation trigger: minor classification but diff is large.
  const largeDiff = (fileSummary.totalAdded + fileSummary.totalRemoved) > 200 || files.length > 5
  if ((allMinorPath || cosmetic) && largeDiff && opts.llm) {
    const llmCall = await opts.llm.classify(diffText).catch(() => null)
    if (llmCall && llmCall !== 'minor') {
      return {
        riskClass: llmCall,
        rationale: `llm_escalated: heuristic=minor but size>threshold; llm=${llmCall}`,
        llmEscalated: true,
      }
    }
  }
  if (allMinorPath) {
    return { riskClass: 'minor', rationale: 'all_paths_cosmetic_extensions', llmEscalated: false }
  }
  if (cosmetic) {
    return { riskClass: 'minor', rationale: 'diff_body_cosmetic_class_or_copy', llmEscalated: false }
  }

  // (4) Fallback: not obviously minor, not flagged — call it major to err on
  // the side of human review.
  return {
    riskClass: 'major',
    rationale: `unclassified:${files.length}_files,+${fileSummary.totalAdded}/-${fileSummary.totalRemoved}`,
    llmEscalated: false,
  }
}

// Test-only.
export const _internals = {
  diffIsCosmetic,
  exportedSymbolsChanged,
  envExampleChanged,
  routeFileStructureChanged,
}
