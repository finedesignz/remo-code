/**
 * PTYCAP Phase 3 -- governed-automation primitives for the interactive PTY.
 *
 * This module decides whether a NON-HUMAN actor may drive a `pty-interactive`
 * session. It replaces the old human-only dispatch gate (hard rename, no alias)
 * with `governedAutomationPtyGate`, behind a flag that is OFF by default and a
 * TRUE no-op when off: with the flag unset (or any value outside 1|true|yes|on)
 * the gate returns exactly the legacy decision AND reason string for every
 * (actor x runnerType) pair, calls its resolver exactly once and invokes zero
 * governors (proven by the differential in hub/test/governed-pty-gate.test.ts).
 *
 * HONEST SCOPE: the dispatch-pipeline call sites that compose this gate (ask,
 * work, telegram) are NOT the door onto a PTY. Every automation dispatch adapter
 * sends a `user_message`, which the supervisor routes to the stream-json runner,
 * never the PTY. The door is the PTY turn preflight (plan 03-02) plus the
 * structural pins (plan 03-03). This gate is the shared decision those paths
 * and the future automation producer must pass.
 *
 * Governors (fixed order, first block wins, cheapest/most authoritative first):
 *   kill_switch, token_cap, inject_rate, lifetime_counter.
 * PTYCAP Phase 4: kill_switch and lifetime_counter are REAL. Each governor's
 * `check` IS the function the dispatcher-list gate uses (killSwitchCheck /
 * lifetimeCounterCheck from automation-controls.ts), so the two surfaces cannot
 * drift. The lifetime_counter slot refuses with `lifetime_counter_key_missing`
 * until the request carries a server-set counter key. token_cap blocks with
 * `governor_unconfigured:token_cap` when the daily token cap is explicitly
 * disabled. inject_rate COUNTS: it refuses with `over_session_inject_rate:<n>>=<cap>`
 * when the de-duplicated union of the session's inject records over the trailing
 * hour has reached the ceiling (and `governor_unconfigured:inject_rate` when the
 * ceiling is not a positive finite number), so a governed path is rate-bounded
 * even when its host gate list has no inject-rate gate. The dollar cost cap is
 * advisory and is NOT a governor. Governors are NON-CONSUMING checks: no writes,
 * no counters; the counting happens in the PTY door's atomic reservation.
 *
 * Only actors in AUTOMATION_ACTORS can ever be admitted. external-ask,
 * external-work, the empty string and unknown strings keep the unconditional
 * legacy deny even with the flag ON and every governor passing.
 *
 * Governors are injectable ONLY through the test-only setter below. There is
 * deliberately NO optional public governors parameter: a public parameter would
 * be a bypass handle.
 */
import { AUTOMATION_ACTORS, humanOnlyRejectsActor, isDailyTokenCapEnforced, isInjectRateConfigured, maxInjectsPerHour } from './gates.ts'
import { killSwitchCheck, lifetimeCounterCheck, countRateUnion } from './automation-controls.ts'
import type { DispatchGate, DispatchRequest } from './pipeline.ts'

/** The ONLY hub source file allowed to contain this literal (pinned by plan 03-03). */
export const GOVERNED_AUTOMATION_PTY_ENV = 'REMO_GOVERNED_AUTOMATION_PTY'

/**
 * Call-time flag reader (never cached). True only for 1|true|yes|on after trim +
 * lowercase; anything else, including garbage, is OFF.
 */
export function governedAutomationEnabled(): boolean {
  const raw = (process.env[GOVERNED_AUTOMATION_PTY_ENV] ?? '0').trim().toLowerCase()
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on'
}

export type GovernorName = 'kill_switch' | 'token_cap' | 'inject_rate' | 'lifetime_counter'

/** Evaluation order. The flag check precedes all governors. */
export const GOVERNOR_ORDER: readonly GovernorName[] = [
  'kill_switch',
  'token_cap',
  'inject_rate',
  'lifetime_counter',
]

export interface GovernorGate extends DispatchGate {
  name: GovernorName
}

/** Real kill switch: the SAME function reference the dispatcher-list gate runs. */
export const killSwitchGovernor: GovernorGate = {
  name: 'kill_switch',
  check: killSwitchCheck,
}

/** Enabled rule only: blocks when the daily token cap is explicitly disabled. */
export const tokenCapGovernor: GovernorGate = {
  name: 'token_cap',
  async check() {
    if (!isDailyTokenCapEnforced()) return { ok: false, reason: 'governor_unconfigured:token_cap' }
    return { ok: true }
  },
}

/**
 * Counting rate governor: the ceiling must be a positive finite number and the
 * session's trailing-hour union count (run-log inject rows U unreleased ledger
 * rows, never a max) must be under it. A count error propagates (the gate maps it
 * to governor_error:inject_rate; the door maps it to pty_preflight_error).
 */
export const injectRateGovernor: GovernorGate = {
  name: 'inject_rate',
  async check(req: DispatchRequest) {
    if (!isInjectRateConfigured()) return { ok: false, reason: 'governor_unconfigured:inject_rate' }
    const cap = maxInjectsPerHour()
    if (!Number.isFinite(cap) || cap <= 0) return { ok: false, reason: 'governor_unconfigured:inject_rate' }
    const n = await countRateUnion(req.sessionId, 60)
    if (n >= cap) return { ok: false, reason: `over_session_inject_rate:${n}>=${cap}` }
    return { ok: true }
  },
}

/** Real durable lifetime counter: the SAME function reference the dispatcher-list gate runs. */
export const lifetimeCounterGovernor: GovernorGate = {
  name: 'lifetime_counter',
  check: lifetimeCounterCheck,
}

export const PRODUCTION_GOVERNORS: readonly GovernorGate[] = [
  killSwitchGovernor,
  tokenCapGovernor,
  injectRateGovernor,
  lifetimeCounterGovernor,
]

let governors: readonly GovernorGate[] = PRODUCTION_GOVERNORS

/** The governor list currently in force (PRODUCTION_GOVERNORS unless a test swapped it). */
export function activeGovernors(): readonly GovernorGate[] {
  return governors
}

/** Test-only - replace the governor list (dependency injection for the admit path). */
export function _setGovernorsForTests(list: readonly GovernorGate[]): void {
  governors = list
}

/** Test-only - restore the production governor list. */
export function _resetGovernorsForTests(): void {
  governors = PRODUCTION_GOVERNORS
}

/** Only AUTOMATION_ACTORS members can ever be admitted (D-06). */
export function isGovernedEligibleActor(actor: string): boolean {
  return AUTOMATION_ACTORS.has(actor)
}

/** `automation_blocked_on_pty:<actor>` plus `:<governor_reason>` for a governor block. */
export function automationBlockedReason(actor: string, governorReason?: string): string {
  return governorReason === undefined
    ? `automation_blocked_on_pty:${actor}`
    : `automation_blocked_on_pty:${actor}:${governorReason}`
}

/**
 * DispatchGate form. Decision order: resolver once -> non-PTY runner or the exact
 * `human` actor is ok -> flag OFF legacy block -> ineligible actor legacy block ->
 * governors in order (a thrown governor is a typed fail-closed denial).
 */
export function governedAutomationPtyGate(
  resolveActorAndRunnerType: (req: DispatchRequest) => Promise<{ actor: string; runnerType: string }>,
): DispatchGate {
  return {
    name: 'governed_automation_pty',
    async check(req: DispatchRequest) {
      const { actor, runnerType } = await resolveActorAndRunnerType(req)
      if (!humanOnlyRejectsActor(actor, runnerType)) return { ok: true }
      if (!governedAutomationEnabled()) return { ok: false, reason: automationBlockedReason(actor) }
      if (!isGovernedEligibleActor(actor)) return { ok: false, reason: automationBlockedReason(actor) }
      for (const governor of activeGovernors()) {
        let result: { ok: true } | { ok: false; reason: string }
        try {
          result = await governor.check(req)
        } catch {
          return { ok: false, reason: automationBlockedReason(actor, `governor_error:${governor.name}`) }
        }
        if (!result.ok) return { ok: false, reason: automationBlockedReason(actor, result.reason) }
      }
      return { ok: true }
    },
  }
}
