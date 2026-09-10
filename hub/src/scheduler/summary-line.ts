/**
 * Workflow prompts end a turn with a `Summary: <VERDICT>: <reason>` line
 * (`prompts/dev/ship.md`, `prompts/log_check/*.md`, …). That line is the ONLY
 * machine-readable signal that a step stopped without finishing, and it lives at
 * the END of the reply — where the sender's 500-char head-truncation cuts it off
 * (the same reason `<<DECISION>>` / `<<FINDINGS>>` blocks get extracted).
 *
 * Models emit the label plain (`Summary: BLOCKED: ...`) or bolded
 * (`**Summary:** BLOCKED: ...`, `**Summary: BLOCKED:** ...`); no prompt forbids
 * either, so both are accepted.
 */

/** Matches the label of a summary line, plain or markdown-bolded. */
const SUMMARY_LINE_RE = /^[^\S\n]*\*{0,2}\s*Summary:/i

/**
 * Verdicts that mean "this step did NOT complete its job" — a chain that hits
 * any of them is wedged and the owner must hear about it, even though the run
 * itself finalizes `success` (the model answered; it just refused to proceed).
 *
 * `SKIPPED` is deliberately NOT here: `prompts/log_check/pull.md:23-24` emits it
 * as a BY-DESIGN no-op for a tauri target / a task with no deploy target, so
 * treating it as terminal would email the owner on every routine run forever.
 */
const TERMINAL_SUMMARY_RE =
  /^[^\S\n]*\*{0,2}\s*Summary:\*{0,2}\s*(BLOCKED|FAILED|DEPLOY UNHEALTHY)\b/i

/** The LAST `Summary:` line of a reply, trimmed. Null when there is none. */
export function extractSummaryLine(raw: string): string | null {
  const lines = raw.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    if (SUMMARY_LINE_RE.test(lines[i])) return lines[i].trim()
  }
  return null
}

/**
 * True when the reply's FINAL verdict is BLOCKED / FAILED / DEPLOY UNHEALTHY.
 *
 * Tests only the LAST `Summary:` line — never the raw text. A reply that quotes
 * or code-fences an earlier `Summary: BLOCKED` (retry narrative, a QC step
 * echoing a previous run, example output) must not fire on the quoted line when
 * its own verdict is fine.
 */
export function isTerminalSummary(text: string | null | undefined): boolean {
  const line = extractSummaryLine(text ?? '')
  return line != null && TERMINAL_SUMMARY_RE.test(line)
}
