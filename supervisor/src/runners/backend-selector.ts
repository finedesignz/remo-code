/**
 * backend-selector.ts — Phase 19 / 19-02 (R-PTY-22). Resolves which PTY runner a
 * NEW human session uses, GATED on the June-15 cutover-gate result.
 *
 * HARD INVARIANTS (interactive-pty-runner-SPEC.md; threat T-19-02/02b/02c/02d):
 *   - Resolves ONLY to an EXPLICIT PTY runner id — 'claude-pty' | 'codex-pty'.
 *     NEVER the bare 'claude'/'codex' id and NEVER the legacy stream-json runner.
 *     The legacy/stream-json runner is unreachable from this function.
 *   - HARD-REJECT (throw) any config/flag combination that would yield a non-PTY
 *     or legacy/stream-json id — no silent downgrade onto a programmatic-billed
 *     path.
 *   - DEFENSE-IN-DEPTH: re-asserts ctx.isHuman === true at resolution time
 *     (independent of the Phase-16 relay-boundary guard). Automation contexts
 *     never obtain a PTY backend here.
 *   - FAIL-SAFE: until the cutover gate records `claude_interactive_confirmed`,
 *     the default human backend is NOT Claude-PTY — it resolves to 'codex-pty'.
 *     Users are never silently put on a programmatic-billed path.
 *   - POST-FAILED-GATE: when the recorded gate result is 'programmatic', the
 *     Claude-PTY backend is DISABLED/unlisted — never returned for new OR
 *     existing sessions until an explicit operator override clears it (alert on
 *     the disable).
 *
 * The selector governs ONLY human sessions. Automation (stream-json/programmatic)
 * routes through the dispatch pipeline and never calls this function.
 *
 * The gate flag is an OPERATOR-RECORDED value set after the cutover-gate runbook
 * (docs/cutover-gate-june15.md). No production code path writes it — it is
 * operator/config tooling only (asserted by the 19-02 test).
 */

/** The only ids a human session may resolve to. Legacy/stream-json is absent. */
export type HumanBackendId = 'claude-pty' | 'codex-pty'

/** Configured preference. 'claude' is honored ONLY after the gate confirms. */
export type DefaultHumanBackend = 'claude' | 'codex'

/** Operator-recorded result of the June-15 billing measurement (check 1). */
export type CutoverGateResult = 'interactive' | 'programmatic' | 'unknown'

/** Ids that must NEVER be returned for a human session (legacy/programmatic). */
const FORBIDDEN_HUMAN_IDS = new Set([
  'claude',
  'codex',
  'stream-json',
  'claude-stream-json',
  'legacy',
  'claude-runner',
])

export interface CutoverGateState {
  /**
   * Operator-recorded result of check 1 (interactive `claude` PTY turn billing).
   * Drives both the confirm and the post-failed-gate disable.
   */
  result: CutoverGateResult
  /**
   * Set true by the operator ONLY when result === 'interactive' AND they record
   * the flip. Fail-safe: when false/absent, Claude-PTY is never the default.
   */
  claudeInteractiveConfirmed: boolean
  /**
   * Operator override that re-enables Claude-PTY after a 'programmatic' result
   * (e.g. a later remeasurement flipped back). Absent/false ⇒ disabled stays.
   */
  operatorOverrideClaudePty?: boolean
}

export interface BackendSelectorConfig {
  /** Configured preference; honored only post-confirm. Pollution throws. */
  defaultHumanBackend: DefaultHumanBackend
  gate: CutoverGateState
}

export interface HumanSessionContext {
  /** MUST be true. Defense-in-depth re-assertion of the human-only guard. */
  isHuman: boolean
  /** Optional explicit per-session backend request (still PTY-only, gated). */
  requestedBackend?: DefaultHumanBackend
}

/** Emitted when Claude-PTY is disabled by a 'programmatic' gate result. */
export type SelectorAlert = (msg: string) => void
let alertSink: SelectorAlert = (msg) => {
  try {
    console.error(`[backend-selector] ALERT: ${msg}`)
  } catch {}
}

/** TEST-ONLY: capture alerts. Returns a restore fn. */
export function __setSelectorAlertForTest(fn: SelectorAlert): () => void {
  const prev = alertSink
  alertSink = fn
  return () => {
    alertSink = prev
  }
}

function assertPtyId(id: string): asserts id is HumanBackendId {
  if (id !== 'claude-pty' && id !== 'codex-pty') {
    throw new Error(
      `backend-selector: refusing to resolve human session to non-PTY/legacy backend id '${id}'`,
    )
  }
}

/** True when the recorded gate result forbids Claude-PTY (programmatic, no override). */
export function isClaudePtyDisabled(gate: CutoverGateState): boolean {
  return gate.result === 'programmatic' && gate.operatorOverrideClaudePty !== true
}

/**
 * Resolve the human backend id for a NEW (or in-flight) human session.
 * @throws if ctx is non-human, or any path would yield a non-PTY/legacy id.
 */
export function resolveHumanBackend(
  ctx: HumanSessionContext,
  config: BackendSelectorConfig,
): HumanBackendId {
  // Defense-in-depth: never hand a PTY backend to a non-human (automation) ctx.
  if (ctx?.isHuman !== true) {
    throw new Error(
      'backend-selector: resolveHumanBackend called for a non-human context (isHuman !== true)',
    )
  }

  // Reject a polluted config preference that names a legacy/bare id.
  const pref = (ctx.requestedBackend ?? config.defaultHumanBackend) as string
  if (FORBIDDEN_HUMAN_IDS.has(pref) && pref !== 'claude' && pref !== 'codex') {
    throw new Error(
      `backend-selector: config requested a forbidden/legacy backend '${pref}'`,
    )
  }
  if (pref !== 'claude' && pref !== 'codex') {
    throw new Error(
      `backend-selector: unknown default_human_backend '${pref}' (expected 'claude' | 'codex')`,
    )
  }

  const gate = config.gate

  // POST-FAILED-GATE: Claude-PTY disabled on a 'programmatic' result (no override).
  if (isClaudePtyDisabled(gate)) {
    if (pref === 'claude') {
      alertSink(
        "Claude-PTY requested but DISABLED by a 'programmatic' cutover-gate result — resolving to fail-safe 'codex-pty'. An operator override is required to re-enable.",
      )
    }
    const id = 'codex-pty'
    assertPtyId(id)
    return id
  }

  // FAIL-SAFE: Claude-PTY is the default ONLY after the gate confirms interactive.
  let id: HumanBackendId
  if (pref === 'claude') {
    id = gate.claudeInteractiveConfirmed ? 'claude-pty' : 'codex-pty'
  } else {
    id = 'codex-pty'
  }

  assertPtyId(id)
  return id
}
