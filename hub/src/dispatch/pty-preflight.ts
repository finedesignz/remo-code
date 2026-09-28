/**
 * PTYCAP Phase 2 — PTY pre-flight gate (`.planning/phases/PTYCAP-02-pty-preflight-gate/`).
 *
 * Goal (verbatim from `.planning/ROADMAP.md`): "No programmatic turn reaches the
 * PTY without passing the full gate chain."
 *
 * Phase 1 (PR #395) taught the hub to RECORD what an interactive PTY turn spends.
 * This module CHECKS that spend against the daily ceilings before a new turn is
 * submitted to the PTY. Call site: `hub/src/ws/client.ts`'s `term.input` relay,
 * which runs it on every PROMPT SUBMIT (a frame whose bytes contain Enter —
 * see `isPtySubmit`), never on plain keystrokes, control keys, or attachments.
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
 * FAIL CLOSED: a thrown gate or a check that does not settle within
 * `PTY_PREFLIGHT_TIMEOUT_MS` is a rejection, never a pass.
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
 * True when a base64 `term.input` payload contains a carriage return or line
 * feed — i.e. it can SUBMIT a prompt (Enter, or a paste ending in a newline) and
 * so start new model work. Plain typing, Ctrl-C (0x03), Esc (0x1b) and arrow
 * keys never contain one, so a user over the cap can still type, interrupt and
 * cancel; only submitting is refused. Undecodable input counts as a submit
 * (fail closed).
 */
export function isPtySubmit(bytesB64: string): boolean {
  let raw: string
  try { raw = atob(bytesB64) } catch { return true }
  return raw.includes('\r') || raw.includes('\n')
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
