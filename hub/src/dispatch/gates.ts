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
import { sumTodayCostForUser } from '../db/scheduled-tasks-dal.ts'
import { checkUserThreshold } from '../usage/threshold.ts'
import { reserveSessionSlot } from '../sessions/budget.ts'
import type { DispatchGate, DispatchRequest } from './pipeline.ts'

/**
 * Daily cost-cap predicate — the single source of truth for the
 * `isOverCostCap` SQL that scheduler/error-capture/revanote each copied.
 *
 * Returns true when the user's spend today (in `timezone`) is >= their
 * `daily_cost_cap_usd`. A non-positive or non-finite cap means "no cap"
 * (fail-open — matches the legacy behaviour).
 */
export async function isOverCostCap(userId: string, timezone: string): Promise<boolean> {
  const rows = await sql<{ cap: string }[]>`
    SELECT daily_cost_cap_usd::text AS cap FROM users WHERE id = ${userId} LIMIT 1
  `
  const cap = Number(rows[0]?.cap ?? 10)
  if (!Number.isFinite(cap) || cap <= 0) return false
  const spent = await sumTodayCostForUser(userId, timezone)
  return spent >= cap
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
 * Daily cost-cap gate (non-bypassable, IR-1). Reads the user timezone from the
 * request — `DispatchRequest` carries no timezone field by design, so this gate
 * resolves it from the `users` row alongside the cap, keeping the SQL co-located.
 */
export const dailyCostCapGate: DispatchGate = {
  name: 'daily_cost_cap',
  async check(req: DispatchRequest) {
    const rows = await sql<{ cap: string; tz: string | null }[]>`
      SELECT daily_cost_cap_usd::text AS cap, timezone AS tz
      FROM users WHERE id = ${req.userId} LIMIT 1
    `
    const cap = Number(rows[0]?.cap ?? 10)
    if (!Number.isFinite(cap) || cap <= 0) return { ok: true }
    const timezone = rows[0]?.tz ?? 'UTC'
    const spent = await sumTodayCostForUser(req.userId, timezone)
    if (spent >= cap) return { ok: false, reason: 'daily_cost_cap' }
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
