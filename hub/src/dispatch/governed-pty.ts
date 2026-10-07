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
 * kill_switch and lifetime_counter are FAIL-CLOSED slots in Phase 3: their bodies
 * always block with `governor_not_implemented:<name>`; Phase 4 replaces them. So
 * with the flag ON in Phase 3 production nothing is admitted -- by design.
 * token_cap / inject_rate block with `governor_unconfigured:<name>` unless they
 * are ENABLED (the "over the limit" evaluation stays with dailyTokenCapGate and
 * the preflight chain's inject-rate gate). The dollar cost cap is advisory and is
 * NOT a governor. Governors are NON-CONSUMING checks: no writes, no counters.
 *
 * Only actors in AUTOMATION_ACTORS can ever be admitted. external-ask,
 * external-work, the empty string and unknown strings keep the unconditional
 * legacy deny even with the flag ON and every governor passing.
 *
 * Governors are injectable ONLY through the test-only setter below. There is
 * deliberately NO optional public governors parameter: a public parameter would
 * be a bypass handle.
 */
import { AUTOMATION_ACTORS, humanOnlyRejectsActor, isDailyTokenCapEnforced, maxInjectsPerHour } from './gates.ts'
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

/** Fail-closed slot: Phase 4 replaces the body with the real kill switch. */
export const killSwitchGovernor: GovernorGate = {
  name: 'kill_switch',
  async check() {
    return { ok: false, reason: 'governor_not_implemented:kill_switch' }
  },
}

/** Enabled rule only: blocks when the daily token cap is explicitly disabled. */
export const tokenCapGovernor: GovernorGate = {
  name: 'token_cap',
  async check() {
    if (!isDailyTokenCapEnforced()) return { ok: false, reason: 'governor_unconfigured:token_cap' }
    return { ok: true }
  },
}

/** Enabled rule only: blocks when the inject-rate ceiling is non-finite or <= 0. */
export const injectRateGovernor: GovernorGate = {
  name: 'inject_rate',
  async check() {
    const cap = maxInjectsPerHour()
    if (!Number.isFinite(cap) || cap <= 0) return { ok: false, reason: 'governor_unconfigured:inject_rate' }
    return { ok: true }
  },
}

/** Fail-closed slot: Phase 4 replaces the body with the durable lifetime counter. */
export const lifetimeCounterGovernor: GovernorGate = {
  name: 'lifetime_counter',
  async check() {
    return { ok: false, reason: 'governor_not_implemented:lifetime_counter' }
  },
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
