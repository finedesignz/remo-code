/**
 * Claude usage threshold gate.
 *
 * Compares the in-memory `UsageSnapshot` (from `hub/src/usage/store.ts`,
 * populated by the agent's 5-min OAuth poller) against the user's configured
 * thresholds and returns an allow / block decision.
 *
 * Semantics (per .planning/phases/claude-usage-thresholds/00-architecture-review.md §3):
 *   1. Both thresholds NULL → allowed (back-compat — gate OFF).
 *   2. snapshot null      → allowed (fail-open; no usage data yet).
 *   3. five_hour ≥ session_threshold → blocked, reason='session_threshold'.
 *   4. seven_day (or seven_day_opus) ≥ week_threshold → blocked, reason='week_threshold'.
 *   5. Otherwise → allowed.
 *
 * Session-threshold takes precedence over week-threshold when both trip
 * (deterministic — caller gets the most-imminent reset window).
 *
 * Utilization is already a percentage (0-100) in the stored payload — see
 * `web/src/components/UsageStrip.tsx` which clamps to that range.
 */
import { getUsage, type UsageSnapshot } from './store.ts'
import { getUserClaudeThresholds } from '../db/dal.ts'

export interface ThresholdDecision {
  allowed: boolean
  reason?: 'session_threshold' | 'week_threshold'
  utilization_pct?: number
  threshold_pct?: number
  resets_at?: string
}

export interface ThresholdsRow {
  claude_session_threshold_pct: number | null
  claude_week_threshold_pct: number | null
}

const ALLOW: ThresholdDecision = { allowed: true }

/**
 * Pure decision function — no DB / no store reads. Suitable for unit testing.
 */
export function evaluateThreshold(
  snap: UsageSnapshot | null,
  thresholds: ThresholdsRow,
): ThresholdDecision {
  const sessionPct = thresholds.claude_session_threshold_pct
  const weekPct = thresholds.claude_week_threshold_pct

  // (1) Gate fully OFF.
  if (sessionPct == null && weekPct == null) return ALLOW

  // (2) No data yet — fail-open (matches enforceCostCap behaviour).
  if (!snap) return ALLOW

  const fiveHourUtil = snap.usage.five_hour?.utilization ?? 0
  const sevenDayUtil = snap.usage.seven_day?.utilization ?? 0
  const sevenDayOpusUtil = snap.usage.seven_day_opus?.utilization ?? 0

  // (3) Session-window check wins ties — soonest reset.
  if (sessionPct != null && fiveHourUtil >= sessionPct) {
    return {
      allowed: false,
      reason: 'session_threshold',
      utilization_pct: Math.round(fiveHourUtil),
      threshold_pct: sessionPct,
      resets_at: snap.usage.five_hour.resets_at,
    }
  }

  // (4) Weekly cap — opus carve-out counts toward the same gate per review §3.
  if (weekPct != null) {
    const breachingUtil = Math.max(sevenDayUtil, sevenDayOpusUtil)
    if (breachingUtil >= weekPct) {
      const opusBreaches = sevenDayOpusUtil >= weekPct && sevenDayOpusUtil >= sevenDayUtil
      const window = opusBreaches ? snap.usage.seven_day_opus! : snap.usage.seven_day
      return {
        allowed: false,
        reason: 'week_threshold',
        utilization_pct: Math.round(breachingUtil),
        threshold_pct: weekPct,
        resets_at: window.resets_at,
      }
    }
  }

  return ALLOW
}

/**
 * Convenience wrapper: load thresholds + snapshot, then evaluate. Used at
 * every dispatch entry point (scheduler dispatcher, pickSessionTarget,
 * error-capture dispatcher, manual chat send).
 */
export async function checkUserThreshold(userId: string): Promise<ThresholdDecision> {
  const thresholds = await getUserClaudeThresholds(userId)
  if (thresholds.claude_session_threshold_pct == null && thresholds.claude_week_threshold_pct == null) {
    return ALLOW
  }
  const snap = getUsage(userId)
  return evaluateThreshold(snap, thresholds)
}

/** Stable error body shape for HTTP 503 refusals across all gate sites. */
export function buildRefusalPayload(decision: ThresholdDecision): {
  error: 'quota_threshold_reached'
  reason: 'session_threshold' | 'week_threshold'
  utilization_pct: number
  threshold_pct: number
  resets_at: string
} {
  return {
    error: 'quota_threshold_reached',
    reason: decision.reason!,
    utilization_pct: decision.utilization_pct ?? 0,
    threshold_pct: decision.threshold_pct ?? 0,
    resets_at: decision.resets_at ?? '',
  }
}
