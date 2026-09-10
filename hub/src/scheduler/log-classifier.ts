/**
 * Log classifier (Phase 06 holdover — shipped in Phase 11 cleanup).
 *
 * Cheap regex gate over container log output. Sits between a `log_check`
 * (or `log_pull`) Coolify fetch and the downstream LLM triage step
 * (`log_classify` → `log_triage`). When no patterns match, the caller is
 * expected to SKIP the LLM dispatch and finalize the run with
 * `skip_reason='no_errors_detected'`, preserving the daily cost cap.
 *
 * 16 patterns covering common deploy / runtime failure modes. Each match
 * captures a single representative sample line (first hit only — we don't
 * over-collect to keep the snippet small).
 *
 * Pure. No IO, no env, no DB.
 */
export type Severity = 'high' | 'med' | 'low'

export interface ClassifyMatch {
  pattern: string
  severity: Severity
  sample: string
}

export interface ClassifyResult {
  hasErrors: boolean
  matches: ClassifyMatch[]
}

interface PatternSpec {
  name: string
  severity: Severity
  re: RegExp
}

// Order matters only for documentation; we test all patterns against the input.
const PATTERNS: PatternSpec[] = [
  // 1. panic / fatal
  { name: 'panic_or_fatal', severity: 'high', re: /\b(panic|fatal)\b[:\s]/i },
  // 2. unhandled exception / unhandled rejection
  { name: 'unhandled_exception', severity: 'high', re: /unhandled(?:Exception|Rejection|\s+(?:exception|rejection|promise rejection))/i },
  // 3. OOM / out of memory / killed
  { name: 'out_of_memory', severity: 'high', re: /(out\s*of\s*memory|OOMKilled|JavaScript heap out of memory|FATAL ERROR:.*allocation failed)/i },
  // 4. port already in use
  { name: 'port_in_use', severity: 'high', re: /(EADDRINUSE|port\s+\d+\s+(?:is\s+)?already\s+in\s+use|address already in use)/i },
  // 5. ECONNREFUSED
  { name: 'econnrefused', severity: 'high', re: /ECONNREFUSED/ },
  // 6. 5xx HTTP response
  { name: 'http_5xx', severity: 'med', re: /\b(?:HTTP\/[\d.]+\s+)?5\d{2}\b(?:\s+(?:Internal Server Error|Bad Gateway|Service Unavailable|Gateway Timeout))?/i },
  // 7. segfault
  { name: 'segfault', severity: 'high', re: /(segmentation fault|SIGSEGV|signal 11)/i },
  // 8. stack overflow
  { name: 'stack_overflow', severity: 'high', re: /(stack overflow|Maximum call stack size exceeded|RangeError: Maximum call stack)/i },
  // 9. "error:" lines (generic — lower severity)
  { name: 'error_line', severity: 'low', re: /^\s*(?:\[[^\]]+\]\s*)?error[:\s]/im },
  // 10. container exit non-zero
  { name: 'container_exit_nonzero', severity: 'high', re: /(container\s+(?:exited|terminated)\s+with\s+(?:non-?zero|code\s+[1-9])|exit(?:ed)?\s+(?:code|status)\s+[1-9]\d*|Process exited with code [1-9])/i },
  // 11. "deploy failed"
  { name: 'deploy_failed', severity: 'high', re: /(deploy(?:ment)?\s+failed|deployment\s+(?:error|aborted))/i },
  // 12. "migration failed"
  { name: 'migration_failed', severity: 'high', re: /(migration\s+failed|migrate\s+(?:error|failed)|failed to (?:run|apply)\s+migrations?)/i },
  // 13. postgres FATAL / PANIC
  { name: 'postgres_fatal', severity: 'high', re: /\b(?:postgres|psql|pg)[^\n]*\b(FATAL|PANIC)\b/i },
  // 14. JWT / auth failures — backend auth breakage only. NB: bare HTTP
  //   `401 Unauthorized` / `403 Forbidden` are deliberately NOT matched here.
  //   Those are normal access-log outcomes (e.g. uvicorn/FastAPI logging every
  //   client request, including unauthenticated credential probes) and flooded
  //   log_check with false "errors" for probe-heavy apps (titanium-edge-aios),
  //   making every run report errors and defeating the cost-cap skip gate. Real
  //   backend auth failure still flags via JWT / invalid-token / "authentication failed".
  { name: 'auth_failure', severity: 'med', re: /(JWT\s+(?:malformed|expired|invalid|verification failed)|invalid (?:token|signature)|authentication failed)/i },
  // 15. out of disk
  { name: 'out_of_disk', severity: 'high', re: /(no space left on device|ENOSPC|disk\s+full|out of disk)/i },
  // 16. DNS resolution failure
  { name: 'dns_failure', severity: 'high', re: /(EAI_AGAIN|ENOTFOUND|getaddrinfo\s+(?:ENOTFOUND|EAI_AGAIN)|DNS (?:resolution|lookup)\s+(?:failed|error))/i },
]

function firstMatchingLine(text: string, re: RegExp): string | null {
  // Use multiline scan to grab the actual matching line, capped at 240 chars.
  const lines = text.split(/\r?\n/)
  for (const line of lines) {
    if (re.test(line)) {
      const trimmed = line.trim()
      return trimmed.length > 240 ? trimmed.slice(0, 240) + '…' : trimmed
    }
  }
  // Pattern matched across the whole text but not within a single line.
  const m = re.exec(text)
  if (m) {
    const s = m[0].trim()
    return s.length > 240 ? s.slice(0, 240) + '…' : s
  }
  return null
}

export function classifyLogs(text: string): ClassifyResult {
  if (!text || typeof text !== 'string') return { hasErrors: false, matches: [] }
  const matches: ClassifyMatch[] = []
  for (const p of PATTERNS) {
    const sample = firstMatchingLine(text, p.re)
    if (sample !== null) {
      matches.push({ pattern: p.name, severity: p.severity, sample })
    }
  }
  return { hasErrors: matches.length > 0, matches }
}

/** Exposed for tests / documentation. */
export const _PATTERN_NAMES: ReadonlyArray<string> = PATTERNS.map((p) => p.name)
