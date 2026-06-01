/**
 * Phase 18 (R-PTY-18) — programmatic-credit leak detection + the opt-in
 * hard-halt predicate.
 *
 * Two guardrails, both erring toward VISIBLE (never silent suppression):
 *
 *  1. Leak alert (always on). "Leak" = the programmatic credit `used_usd` rose
 *     since the previous snapshot while the hub observed NO automation dispatch
 *     in flight for that user, OR the per-interval drain RATE exceeded a
 *     user-configured threshold. A leak surfaces as a `programmatic_leak_alert`
 *     WS event + a usage-tab notice. The detector is pure: it takes the prev and
 *     new snapshots, the in-flight-automation flag, and the threshold, and
 *     returns the alert or null. The CALLER (the hub usage-report site) supplies
 *     the in-flight flag because it owns dispatch state.
 *
 *  2. Hard-halt (opt-in, OFF by default). When the user has set a
 *     `programmatic_halt_usd` bound AND the polled credit `used_usd` >= that
 *     bound, `isOverProgrammaticHalt` returns true. This is consumed as an
 *     ADDITIONAL predicate at the SINGLE existing `dailyCostCapGate` chokepoint
 *     (hub/src/dispatch/gates.ts) — never a parallel gate. It denies only
 *     programmatic/automation dispatch; human interactive PTY turns do not flow
 *     through that gate for this reason.
 *
 * No OAuth token is ever read here — only the parsed dollar snapshot.
 */
import type { ProgrammaticCredit } from './store'

export interface ProgrammaticLeakAlert {
  type: 'programmatic_leak_alert'
  /** Why the alert fired. */
  reason: 'drain_without_automation' | 'drain_rate_exceeded'
  /** Dollars consumed since the previous snapshot. */
  delta_usd: number
  /** Current credit used / limit for context. */
  used_usd: number
  limit_usd: number
  detected_at: string
}

export interface LeakDetectInput {
  prev: ProgrammaticCredit | null | undefined
  next: ProgrammaticCredit | null | undefined
  /** True when at least one automation dispatch is in flight for this user. */
  automationInFlight: boolean
  /**
   * Optional user threshold: max acceptable drain per poll interval in dollars.
   * When the observed delta exceeds it, the alert fires even WITH automation in
   * flight (a runaway). Null/undefined disables the rate check.
   */
  drainRateThresholdUsd?: number | null
  now?: () => string
}

/**
 * Pure leak detector. Returns an alert or null.
 *
 * Fires when:
 *   (a) used_usd rose AND no automation dispatch is in flight  -> drain_without_automation
 *   (b) used_usd rose by more than the configured per-interval threshold (if set) -> drain_rate_exceeded
 *
 * Never fires when used_usd did not increase, or when the bucket is
 * absent/unclaimed (no number to compare). Erring toward (a) keeps a genuine
 * drain visible; (b) catches a runaway even during legitimate automation.
 */
export function detectProgrammaticLeak(input: LeakDetectInput): ProgrammaticLeakAlert | null {
  const { prev, next, automationInFlight, drainRateThresholdUsd } = input
  // Need a usable before+after dollar figure to compute a delta.
  if (!prev || !next) return null
  if (!Number.isFinite(prev.used_usd) || !Number.isFinite(next.used_usd)) return null

  const delta = next.used_usd - prev.used_usd
  if (delta <= 0) return null // no drain, or a reset/refresh — never a leak

  const now = (input.now ?? (() => new Date().toISOString()))()
  const base = {
    delta_usd: delta,
    used_usd: next.used_usd,
    limit_usd: next.limit_usd,
    detected_at: now,
  }

  // (b) rate threshold — a runaway, even if automation is legitimately running.
  if (
    typeof drainRateThresholdUsd === 'number' &&
    Number.isFinite(drainRateThresholdUsd) &&
    drainRateThresholdUsd > 0 &&
    delta > drainRateThresholdUsd
  ) {
    return { type: 'programmatic_leak_alert', reason: 'drain_rate_exceeded', ...base }
  }

  // (a) drain with no automation in flight — the canonical leak.
  if (!automationInFlight) {
    return { type: 'programmatic_leak_alert', reason: 'drain_without_automation', ...base }
  }

  return null
}

/**
 * Hard-halt predicate (R-PTY-18). True ONLY when the user opted in (a non-null,
 * positive `programmatic_halt_usd` bound) AND the polled programmatic credit
 * used_usd has reached/crossed it. Null bound, absent credit, or unclaimed
 * bucket => false (default OFF — no surprise stop).
 *
 * Consumed beside `isOverCostCap` inside the single `dailyCostCapGate`.
 */
export function isOverProgrammaticHalt(
  haltBoundUsd: number | null | undefined,
  credit: ProgrammaticCredit | null | undefined,
): boolean {
  if (typeof haltBoundUsd !== 'number' || !Number.isFinite(haltBoundUsd) || haltBoundUsd <= 0) {
    return false // not configured => OFF
  }
  if (!credit || !credit.claimed || !Number.isFinite(credit.used_usd)) return false
  return credit.used_usd >= haltBoundUsd
}
