/**
 * Shared dispatch gates (Phase 1, C1).
 *
 * The pluggable pre-send gates the pipeline evaluates in order. First block
 * wins. Each gate satisfies the `DispatchGate` interface from `pipeline.ts`.
 *
 * - `thresholdGate`       wraps `checkUserThreshold` (Claude usage gate).
 * - `dailyCostCapGate`    the `isOverCostCap` daily-USD SQL, defined ONCE here
 *                         (the three subsystem copies delegate to this).
 * - `concurrencyGate(id)` wraps `reserveSessionSlot` for supervisor targets.
 *
 * Gate ORDER at the call site is the caller's responsibility, but the canonical
 * order — threshold → cost-cap → (concurrency) → queue — is what every legacy
 * dispatcher uses and what `IR-2` requires. See `pipeline.ts`.
 *
 * IR-1: the cost-cap path is non-bypassable. A subsystem whose `gates[]` omits
 * `dailyCostCapGate` would dispatch uncapped — assert its presence per
 * subsystem when migrating.
 */
import { sql } from '../db/postgres.ts'
import { getTodayTokenCostUsd } from '../db/token-usage-dal.ts'
import { checkUserThreshold } from '../usage/threshold.ts'
import { reserveSessionSlot } from '../sessions/budget.ts'
import type { DispatchGate, DispatchRequest } from './pipeline.ts'

/**
 * Daily cost-cap predicate — the SINGLE source of truth for the `isOverCostCap`
 * SQL that scheduler/error-capture/revanote each copied. `dailyCostCapGate`
 * delegates here; the SQL is NOT inlined anywhere else (no double truth).
 *
 * P3a: the cap now compares against REAL accumulated token cost for TODAY (the
 * user's tz), summed from `token_usage` via `getTodayTokenCostUsd`. That ledger
 * captures EVERY turn that emits a usage_event over /ws/agent — interactive,
 * telegram, webhook AND scheduled runs — so manual chat is finally capped, not
 * just scheduled runs. token_usage is the one source, so we do NOT also add
 * `scheduled_task_runs.cost_usd` (would double-count scheduled-run cost, which
 * is already in token_usage).
 *
 * Timing: the cap is checked BEFORE a turn dispatches, but a turn's cost is only
 * known AFTER it completes (usage_event is post-turn). So the turn that crosses
 * the cap is allowed to start; the NEXT dispatch is blocked once accumulated
 * cost >= cap. We deliberately do NOT pre-estimate the pending turn.
 *
 * Returns `{ over, spent, cap }`. `over` is true when today's spend (in
 * `timezone`) is >= the user's cap. The `users.daily_cost_cap_usd` column is
 * NOT NULL DEFAULT 10, so a missing/null cap coalesces to the legacy $10 default
 * (still capped) — unchanged from the pre-P3a gate. Only a non-positive /
 * non-finite cap disables enforcement (fail-open).
 */
export async function getCostCapStatus(
  userId: string,
  timezone: string,
): Promise<{ over: boolean; spent: number; cap: number }> {
  const rows = await sql<{ cap: string | null }[]>`
    SELECT daily_cost_cap_usd::text AS cap FROM users WHERE id = ${userId} LIMIT 1
  `
  const cap = Number(rows[0]?.cap ?? 10)
  if (!Number.isFinite(cap) || cap <= 0) return { over: false, spent: 0, cap: 0 }
  const spent = await getTodayTokenCostUsd(userId, timezone)
  return { over: spent >= cap, spent, cap }
}

/** Boolean convenience wrapper around {@link getCostCapStatus}. */
export async function isOverCostCap(userId: string, timezone: string): Promise<boolean> {
  return (await getCostCapStatus(userId, timezone)).over
}

/** Resolve the user's timezone (default 'UTC') for the cost-cap window. */
async function userTimezone(userId: string): Promise<string> {
  const rows = await sql<{ tz: string | null }[]>`
    SELECT timezone AS tz FROM users WHERE id = ${userId} LIMIT 1
  `
  return rows[0]?.tz ?? 'UTC'
}

/**
 * Claude usage threshold gate. Blocks with `quota_threshold_reached:<reason>`
 * when the user crossed their configured 5h / 7d utilization threshold.
 */
export const thresholdGate: DispatchGate = {
  name: 'threshold',
  async check(req: DispatchRequest) {
    const decision = await checkUserThreshold(req.userId)
    if (decision.allowed) return { ok: true }
    const reason = `quota_threshold_reached:${decision.reason}:${decision.utilization_pct}>=${decision.threshold_pct}`
    return { ok: false, reason }
  },
}

/**
 * Daily cost-cap gate (non-bypassable, IR-1). `DispatchRequest` carries no
 * timezone field by design, so the gate resolves the user's timezone then
 * delegates to `isOverCostCap` — the single SQL source of truth.
 */
export const dailyCostCapGate: DispatchGate = {
  name: 'daily_cost_cap',
  async check(req: DispatchRequest) {
    const timezone = await userTimezone(req.userId)
    const status = await getCostCapStatus(req.userId, timezone)
    if (status.over) {
      // Surface accumulated vs cap so dispatch can tell the user the daily cost
      // cap was reached (e.g. "over_daily_cost_cap:$10.42>=$10.00").
      const reason = `over_daily_cost_cap:$${status.spent.toFixed(2)}>=$${status.cap.toFixed(2)}`
      return { ok: false, reason }
    }
    return { ok: true }
  },
}

/**
 * Supervisor concurrency gate — wraps `reserveSessionSlot`. Returns a gate
 * bound to a specific `supervisorId`. At capacity → `{ ok:false, reason }`.
 *
 * NOTE: `reserveSessionSlot` has the side-effect of opening a serialised
 * reservation window; like the legacy dispatcher, this gate is only added to
 * `gates[]` for supervisor-targeted dispatches.
 */
export function concurrencyGate(supervisorId: string): DispatchGate {
  return {
    name: 'concurrency',
    async check(req: DispatchRequest) {
      const reservation = await reserveSessionSlot(req.userId, supervisorId)
      if (reservation.ok) return { ok: true }
      const reason = reservation.reason === 'at_capacity' ? 'at_capacity' : reservation.reason
      return { ok: false, reason }
    },
  }
}
