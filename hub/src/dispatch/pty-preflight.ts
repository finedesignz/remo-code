/**
 * PTYCAP Phase 2 — PTY pre-flight gate (`.planning/phases/PTYCAP-02-pty-preflight-gate/`).
 *
 * Goal (verbatim from `.planning/ROADMAP.md`): "No programmatic turn reaches the
 * PTY without passing the full gate chain."
 *
 * Phase 1 (PR #395) taught the hub to RECORD what an interactive PTY turn spends.
 * This module CHECKS that spend against the daily ceilings before a new turn is
 * submitted to the PTY. Call site: `hub/src/ws/client.ts`'s `term.input` relay,
 * which runs it on every frame that can SUBMIT a prompt (Enter in any encoding —
 * see `classifyPtyInput`), never on plain keystrokes, navigation, interrupt or
 * cancel keys, or attachments.
 *
 * ONE SOURCE OF TRUTH: `ptyPreflightDispatchConfig.gates` is the literal array
 * `hub/test/token-cap-coverage.test.ts` scans AND the array that actually runs
 * (`PTY_AUTOMATION_TURN_GATES` is a reference to it, not a copy), so the
 * coverage scan cannot be satisfied by a decorative literal.
 *   - Automation chain (SC-1): threshold → daily token cap → daily cost cap →
 *     per-session inject-rate ceiling. No path admits automation to a PTY yet
 *     (`humanOnlyPtyGate`); Phase 3 will call this seam.
 *   - Human chain: the same spend ceilings MINUS the inject-rate ceiling (SC-3:
 *     a human is never rate-limited like a loop), and exempt from the
 *     programmatic-credit halt inside `dailyCostCapGate` (via the server-set
 *     `humanInteractive` request flag) — never from the cost or token caps.
 *
 * FAIL CLOSED: a thrown gate or a check that does not settle within the
 * preflight timeout (5s) is a rejection, never a pass.
 */
import type { DispatchGate, DispatchRequest } from './pipeline.ts'
import { thresholdGate, dailyTokenCapGate, dailyCostCapGate, sessionInjectRateGate } from './gates.ts'
import { log } from '../observability/logger'

export const ptyPreflightDispatchConfig: { gates: DispatchGate[] } = {
  gates: [thresholdGate, dailyTokenCapGate, dailyCostCapGate, sessionInjectRateGate],
}

/** The automation chain — the SAME array object the coverage scan reads. */
export const PTY_AUTOMATION_TURN_GATES: DispatchGate[] = ptyPreflightDispatchConfig.gates

/** The human chain: every spend ceiling except the trailing inject-rate gate. */
export const PTY_HUMAN_TURN_GATES: DispatchGate[] = PTY_AUTOMATION_TURN_GATES.filter(
  (g) => g !== sessionInjectRateGate,
)

export type PtyPreflightActor = 'human' | 'automation'

export type PtyPreflightResult = { ok: true } | { ok: false; reason: string }

let timeoutMs = 5_000
/** Test-only — shorten the fail-closed timeout. */
export function _setPtyPreflightTimeoutForTests(ms: number): void { timeoutMs = ms }
export function _resetPtyPreflightTimeoutForTests(): void { timeoutMs = 5_000 }

/**
 * Escape sequences KNOWN not to submit a prompt. Anything else that starts with
 * ESC is treated as a possible submit — e.g. the kitty/CSI-u encoding of Enter
 * (`ESC[13u`, `ESC[57414u`), which the Claude CLI's key parser honours whether
 * or not kitty mode was ever enabled, and which contains no CR/LF byte.
 * Deliberately NOT listed: `ESC O M` (keypad Enter in application mode).
 */
const SAFE_ESCAPES: RegExp[] = [
  /^\x1b\[[A-DHFZIO]/, //           arrows, Home/End, Shift-Tab, focus in/out
  /^\x1b\[1;\d{1,2}[A-DHF]/, //     modified arrows / Home / End
  /^\x1b\[[1-6](?:;\d{1,2})?~/, //  Insert/Delete/Home/End/PgUp/PgDn (+ mods)
  /^\x1b\[20[01]~/, //              bracketed-paste start/end markers
  /^\x1bO[A-DHF]/, //               application-mode arrows / Home / End
]

export type PtyInputClass = {
  /** The frame can submit a prompt (start model work) — run the preflight. */
  submit: boolean
  /** A trailing lone ESC the PTY may still join with the NEXT frame. */
  tail: string
}

/**
 * Classify a base64 `term.input` payload. `pendingTail` is the `tail` of the
 * last frame forwarded to this session's PTY: the CLI buffers an incomplete
 * escape across writes, so `ESC` + `[13u` sent as two frames is one Enter.
 *
 * `submit` is true when the frame (joined with `pendingTail`) contains CR/LF,
 * an escape sequence not on `SAFE_ESCAPES`, a C1 CSI/SS3 code point, or cannot
 * be decoded — fail closed. Plain typing, Ctrl-C (0x03), Backspace, Tab, a lone
 * Esc, Esc-Esc, arrows/Home/End/PgUp/PgDn and Alt+printable never submit, so a
 * user over the cap can still type, navigate, interrupt and cancel.
 */
export function classifyPtyInput(bytesB64: string, pendingTail = ''): PtyInputClass {
  let text: string
  try {
    const bin = atob(bytesB64)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    text = pendingTail + new TextDecoder().decode(bytes)
  } catch {
    return { submit: true, tail: '' }
  }
  let i = 0
  while (i < text.length) {
    const c = text[i]
    if (c === '\r' || c === '\n' || c === '\u009b' || c === '\u008f') return { submit: true, tail: '' }
    if (c !== '\x1b') { i++; continue }
    const next = text[i + 1]
    if (next === undefined) return { submit: false, tail: '\x1b' } // lone Esc at end
    if (next === '\x1b') { i++; continue } //                        Esc-Esc: first is a lone Esc
    const rest = text.slice(i)
    const safe = SAFE_ESCAPES.map((re) => rest.match(re)).find((m) => m)
    if (safe) { i += safe[0].length; continue }
    // Alt+printable (ESC + a printable char that opens no CSI/SS3 sequence).
    if (next !== '[' && next !== 'O' && next >= ' ' && next !== '\x7f') { i += 2; continue }
    return { submit: true, tail: '' }
  }
  return { submit: false, tail: '' }
}

/** Convenience: does this frame, on its own, possibly submit a prompt? */
export function isPtySubmit(bytesB64: string): boolean {
  return classifyPtyInput(bytesB64).submit
}

async function runChain(input: { userId: string; sessionId: string; actor: PtyPreflightActor }): Promise<PtyPreflightResult> {
  const human = input.actor === 'human'
  const req: DispatchRequest = {
    userId: input.userId,
    sessionId: input.sessionId,
    token: `pty-preflight:${input.sessionId}`,
    prompt: '',
    ...(human ? { humanInteractive: true as const } : {}),
  }
  for (const gate of human ? PTY_HUMAN_TURN_GATES : PTY_AUTOMATION_TURN_GATES) {
    const result = await gate.check(req)
    if (!result.ok) return { ok: false, reason: result.reason }
  }
  return { ok: true }
}

/**
 * Evaluate the pre-flight chain for one PTY turn. The actor MUST be
 * server-inferred by the caller, never client-asserted. First blocking gate
 * wins. Never throws: errors and timeouts resolve to a rejection.
 */
export async function checkPtyTurnPreflight(input: {
  userId: string
  sessionId: string
  actor: PtyPreflightActor
}): Promise<PtyPreflightResult> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<PtyPreflightResult>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, reason: 'pty_preflight_timeout' }), timeoutMs)
  })
  try {
    return await Promise.race([
      runChain(input).catch((err): PtyPreflightResult => {
        log.error('pty_preflight.error', {
          session_id: input.sessionId,
          error: err instanceof Error ? err.message : String(err),
        })
        return { ok: false, reason: 'pty_preflight_error' }
      }),
      timeout,
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
