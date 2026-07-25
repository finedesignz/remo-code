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
 */
const TERMINAL_SUMMARY_RE =
  /^[^\S\n]*\*{0,2}\s*Summary:\*{0,2}\s*(BLOCKED|FAILED|SKIPPED|DEPLOY UNHEALTHY)\b/im

/** The LAST `Summary:` line of a reply, trimmed. Null when there is none. */
export function extractSummaryLine(raw: string): string | null {
  const lines = raw.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    if (SUMMARY_LINE_RE.test(lines[i])) return lines[i].trim()
  }
  return null
}

/** True when the text carries a BLOCKED / FAILED / SKIPPED / DEPLOY UNHEALTHY summary. */
export function isTerminalSummary(text: string | null | undefined): boolean {
  return TERMINAL_SUMMARY_RE.test(text ?? '')
}
