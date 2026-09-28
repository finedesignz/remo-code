/**
 * PTYCAP Phase 2 — PTY pre-flight gate (`.planning/phases/PTYCAP-02-pty-preflight-gate/`).
 *
 * Goal (verbatim from `.planning/ROADMAP.md`): "No programmatic turn reaches the
 * PTY without passing the full gate chain."
 *
 * WHERE THIS FITS: Phase 1 (merged, PR #395) taught the hub to RECORD what an
 * interactive PTY turn spends. Nothing yet CHECKED that spend against a ceiling
 * before the turn started — `hub/src/ws/client.ts`'s `term.input` relay forwards
 * raw keystroke bytes straight to the agent channel with only a license check +
 * the human-only guard + the write-arbitration turn lock in front of it (see
 * `docs/usage-cost.md` §"PTYCAP Phase 1": "gating the interactive PTY path
 * against the daily cost/token caps is milestone PTYCAP's Phase 2, not this
 * phase."). This module is that gate.
 *
 * TWO CHAINS, ONE SOURCE OF TRUTH:
 *   - `PTY_AUTOMATION_TURN_GATES` (SC-1) — the exact chain the ROADMAP specifies,
 *     in the ROADMAP's own order: threshold → daily token cap → daily cost cap →
 *     per-session inject-rate ceiling. This is what a NON-human actor must pass.
 *     No admission path exists yet that lets a non-human actor reach a PTY at
 *     all (`humanOnlyPtyGate` / `humanOnlyRejectsActor` reject every automation
 *     source before this module is ever consulted) — Phase 3
 *     (`governedAutomationPtyGate`) is what will open that door. This chain is
 *     built and proven NOW so Phase 3 has a tested seam to call into rather than
 *     inventing gate wiring at the same time it relaxes the human-only invariant
 *     (the ROADMAP explicitly forbids parallelizing Phase 3 ahead of Phase 2).
 *   - `PTY_HUMAN_TURN_GATES` — the SAME spend ceilings (threshold, token cap,
 *     cost cap) applied to a genuine human turn, MINUS `sessionInjectRateGate`
 *     (SC-3: "a human at a keyboard is never gated by an inject-rate ceiling" —
 *     that ceiling exists to bound a machine that could loop; a human typing
 *     cannot loop faster than they can type). `PTY_HUMAN_TURN_GATES` is a slice
 *     of `PTY_AUTOMATION_TURN_GATES` (never a hand-duplicated array), so the two
 *     chains cannot drift apart.
 *
 * EXPORTED AS A LITERAL `gates` array CONFIG OBJECT (`ptyPreflightDispatchConfig`)
 * on purpose (SC-2): `hub/test/token-cap-coverage.test.ts` bracket-balance-scans
 * every `gates` array literal in `hub/src` and hard-fails CI if one omits
 * `dailyTokenCapGate` or `dailyCostCapGate`. Writing the full chain inline here
 * (rather than only as a re-exported identifier) means this file is discovered
 * by that scan exactly like every other dispatcher's `PipelineDeps`, and the
 * coverage test's "known dispatchers" list is extended to name this file
 * explicitly.
 *
 * CALL SITE (today): `hub/src/ws/client.ts`'s `term.input`/`term.attach_file`
 * relay, checked ONCE per turn (when `turn-lock.holder(sessionId)` is `null` —
 * i.e. this write would START a fresh turn), never per keystroke. A turn
 * already in flight already passed this check and is never retroactively cut
 * off mid-stream (matching how `dispatch()` treats an in-flight stream-json
 * turn elsewhere in the codebase).
 */
import type { DispatchGate, DispatchRequest } from './pipeline.ts'
import { thresholdGate, dailyTokenCapGate, dailyCostCapGate, sessionInjectRateGate } from './gates.ts'

/**
 * The full pre-flight chain a PROGRAMMATIC (non-human) PTY turn must pass, in
 * the exact order the ROADMAP specifies (SC-1). `ptyPreflightDispatchConfig`
 * below re-exposes this same array under a literal `gates:` key purely so the
 * token-cap-coverage scan discovers it — this is the ONE array either consumer
 * reads, never duplicated.
 */
export const PTY_AUTOMATION_TURN_GATES: DispatchGate[] = [
  thresholdGate,
  dailyTokenCapGate,
  dailyCostCapGate,
  sessionInjectRateGate,
]

/**
 * A genuine human turn passes every spend ceiling EXCEPT the inject-rate
 * ceiling (SC-3). Derived as a slice of `PTY_AUTOMATION_TURN_GATES` (drops the
 * trailing `sessionInjectRateGate`) so the two chains can never silently drift
 * out of sync with each other.
 */
export const PTY_HUMAN_TURN_GATES: DispatchGate[] = PTY_AUTOMATION_TURN_GATES.slice(0, -1)

/**
 * Config-object form of {@link PTY_AUTOMATION_TURN_GATES}, written with the
 * literal gate identifiers INLINE (not just a re-exported reference) so
 * `hub/test/token-cap-coverage.test.ts`'s text-based `gates` array scan
 * finds `dailyTokenCapGate` and `dailyCostCapGate` in this file's source, the
 * same way it finds every other dispatcher's `PipelineDeps`.
 */
export const ptyPreflightDispatchConfig: { gates: DispatchGate[] } = {
  gates: [thresholdGate, dailyTokenCapGate, dailyCostCapGate, sessionInjectRateGate],
}

export type PtyPreflightActor = 'human' | (string & {})

export type PtyPreflightResult = { ok: true } | { ok: false; reason: string }

/**
 * Evaluate the PTY pre-flight gate chain for one turn. `actor === 'human'` runs
 * {@link PTY_HUMAN_TURN_GATES}; anything else (an automation source, should one
 * ever be admitted past `humanOnlyPtyGate` in a later phase) runs the full
 * {@link PTY_AUTOMATION_TURN_GATES}. Gates run in order; the first block wins
 * (matches `hub/src/dispatch/pipeline.ts`'s own IR-2 semantics) — the caller
 * gets the FIRST failing gate's reason, not a list.
 *
 * The actor must be SERVER-INFERRED by the caller (never a client-asserted
 * field) — this function trusts whatever it is given, exactly like
 * `humanOnlyPtyGate` trusts its caller's `resolveActorAndRunnerType`.
 */
export async function checkPtyTurnPreflight(input: {
  userId: string
  sessionId: string
  actor: PtyPreflightActor
}): Promise<PtyPreflightResult> {
  const req: DispatchRequest = {
    userId: input.userId,
    sessionId: input.sessionId,
    token: `pty-preflight:${input.sessionId}`,
    prompt: '',
  }
  const gates = input.actor === 'human' ? PTY_HUMAN_TURN_GATES : PTY_AUTOMATION_TURN_GATES
  for (const gate of gates) {
    const result = await gate.check(req)
    if (!result.ok) return { ok: false, reason: result.reason }
  }
  return { ok: true }
}
