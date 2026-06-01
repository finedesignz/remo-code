/**
 * Phase 20 plan 03 — per-backend pending→keystroke mapping (R-TG-08).
 *
 * A Telegram approve/deny/option tap is injected into the live TUI as raw
 * keystroke BYTES via the Phase-16 `term.input` path — NOT the deleted
 * `permission_response` agent message. Each backend's TUI has its own accept/
 * deny/option-select key convention; this table is the single place that mapping
 * lives.
 *
 * ⚠️ PROVISIONAL BYTES — MANUAL GATE (autonomous:false, VALIDATION manual item 1).
 * The literal accept/deny/option byte sequences below are the COMMON TUI
 * conventions (y/n for a yes/no prompt; digit/arrow+Enter for an option list),
 * but the EXACT sequences each live Claude / Codex TUI expects MUST be captured
 * by hand from a real prompt before relying on injection in production. Until
 * that capture lands, treat this table as provisional: the wiring, fail-closed
 * gating, and disambiguation are fully testable now; the byte values are the one
 * thing pending live verification. Capture method: run the TUI, trigger a
 * permission prompt, record stdin bytes for each choice, replace the constants.
 *
 * FAIL-CLOSED: `keystrokeFor` returns null for any (cliKind, shape, optionId)
 * it cannot map. A null mapping ⇒ the caller injects NOTHING (never a guess,
 * never a default key).
 */

import type { CliKind, DetectedPending } from './permission-detector.ts'

const ENTER = '\r' // carriage return — TUI line submit
const ESC = '\x1b'

/** Common single-key answers for a boolean (Approve/Deny) prompt. */
const CLAUDE_BOOLEAN: Record<string, string> = {
  // Claude's interactive permission prompt: 'y' approves, 'n' denies (+Enter).
  approve: 'y' + ENTER,
  deny: 'n' + ENTER,
}
const CODEX_BOOLEAN: Record<string, string> = {
  // Codex approval prompt: same y/n convention (provisional — verify live).
  approve: 'y' + ENTER,
  deny: 'n' + ENTER,
}

/**
 * Map a resolved pending + the chosen optionId → the literal bytes to write to
 * the PTY, or null when unmappable (fail-closed).
 *
 * For a boolean permission we map the well-known approve/deny ids. For an
 * option-select (user_question, or a permission with an explicit enumerated
 * list), the optionId is the option INDEX (string) and we type that index then
 * Enter — the common TUI numbered-list convention. An out-of-range / non-numeric
 * id ⇒ null.
 */
export function keystrokeFor(
  cliKind: CliKind,
  pending: DetectedPending,
  optionId: string,
): string | null {
  // Boolean approve/deny path (no enumerated list, or the canonical ids).
  if (optionId === 'approve' || optionId === 'deny') {
    const table = cliKind === 'codex' ? CODEX_BOOLEAN : CLAUDE_BOOLEAN
    return table[optionId] ?? null
  }

  // Enumerated option-select: the id is the option index. Validate it is a real,
  // in-range index of THIS pending's options.
  const idx = Number(optionId)
  if (!Number.isInteger(idx) || idx < 0 || idx >= pending.options.length) return null
  // Numbered-list convention: TUIs typically 1-index the visible list, so type
  // (idx+1) then Enter. (Provisional — some TUIs use arrow-navigation; verify
  // live and switch to ARROW_DOWN*n+Enter if needed.)
  const visible = idx + 1
  if (visible > 9) {
    // A list longer than 9 needs multi-digit / arrow nav — not provisioned;
    // fail-closed rather than type an ambiguous sequence.
    return null
  }
  return String(visible) + ENTER
}

/** Bytes → base64 for a `term.input` frame payload. */
export function toBase64(bytes: string): string {
  return Buffer.from(bytes, 'utf8').toString('base64')
}

export { ENTER, ESC }
