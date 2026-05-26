/**
 * Phase 04 plan 008 — `pickSessionTarget` routing primitive.
 *
 * Single source of truth for "where does a new session run?". Used by:
 *   - `POST /api/sessions/heal` (this plan)
 *   - the scheduler dispatcher (Plan 04-003 caller)
 *
 * Resolution order (matches ARCHITECTURE-REVIEW §6):
 *   1. User's `preferred_supervisor_id` if online + has capacity (reservation
 *      held on success — caller owns release).
 *   2. Else first online supervisor (ordered by `last_seen_at ASC`) where
 *      `reserveSessionSlot` succeeds.
 *   3. Else local agent (any user-owned agent channel currently connected).
 *   4. Else `{ kind: 'none' }`.
 *
 * The supervisor slot reservation is atomic — two concurrent callers competing
 * for the last slot will see exactly one `kind:'supervisor'` win and the other
 * fall through.
 *
 * `excludeSupervisorIds` lets a caller retry after a WS dispatch failure
 * without re-picking the same broken supervisor.
 */
import { sql } from '../db/postgres.ts'
import { reserveSessionSlot } from './budget.ts'
import { isSupervisorOnline } from '../ws/supervisor-registry.ts'
import { listOnlineAgentSessionsForUser } from '../ws/registry.ts'
import { checkUserThreshold } from '../usage/threshold.ts'

// Recency threshold for "supervisor is online". Belt-and-braces with the
// in-memory registry check — guards against zombie rows whose WS closed
// without unregistering. Plan T1: "within 90s".
const ONLINE_RECENCY_MS = 90_000

export type PickedTarget =
  | { kind: 'supervisor'; supervisor_id: string; running: number; cap: number }
  | { kind: 'local_agent'; agent_session_id: string }
  | { kind: 'none'; reason: string }
  | {
      kind: 'quota_blocked'
      reason: 'session_threshold' | 'week_threshold'
      utilization_pct: number
      threshold_pct: number
      resets_at: string
    }

interface SupervisorRow {
  id: string
  last_seen_at: string
}

function isRecent(lastSeen: string | Date | null): boolean {
  if (!lastSeen) return false
  const t = typeof lastSeen === 'string' ? Date.parse(lastSeen) : lastSeen.getTime()
  if (Number.isNaN(t)) return false
  return Date.now() - t <= ONLINE_RECENCY_MS
}

export async function pickSessionTarget(
  userId: string,
  opts: { excludeSupervisorIds?: string[] } = {},
): Promise<PickedTarget> {
  const exclude = new Set(opts.excludeSupervisorIds ?? [])

  // Step 0: Claude usage threshold gate. Blocks new dispatch when the user
  // is over their configured 5h or 7d cap. In-flight runs are not killed —
  // only NEW target picks are refused. See review §3.
  const t = await checkUserThreshold(userId)
  if (!t.allowed) {
    return {
      kind: 'quota_blocked',
      reason: t.reason!,
      utilization_pct: t.utilization_pct ?? 0,
      threshold_pct: t.threshold_pct ?? 0,
      resets_at: t.resets_at ?? '',
    }
  }

  // Step 1: preferred supervisor.
  const userRows = await sql<{ preferred_supervisor_id: string | null }[]>`
    SELECT preferred_supervisor_id FROM users WHERE id = ${userId}
  `
  const preferredId = userRows[0]?.preferred_supervisor_id ?? null

  if (preferredId && !exclude.has(preferredId)) {
    const supRows = await sql<SupervisorRow[]>`
      SELECT id, last_seen_at FROM supervisors
      WHERE id = ${preferredId} AND user_id = ${userId}
    `
    const sup = supRows[0]
    if (sup && isSupervisorOnline(sup.id) && isRecent(sup.last_seen_at)) {
      const r = await reserveSessionSlot(userId, sup.id)
      if (r.ok) {
        return { kind: 'supervisor', supervisor_id: sup.id, running: r.running, cap: r.cap }
      }
      // at_capacity or supervisor_not_found → fall through to step 2.
    }
  }

  // Step 2: any other online supervisor, oldest-connection first (deterministic).
  const candidates = await sql<SupervisorRow[]>`
    SELECT id, last_seen_at FROM supervisors
    WHERE user_id = ${userId}
    ORDER BY last_seen_at ASC
  `
  for (const sup of candidates) {
    if (exclude.has(sup.id)) continue
    if (sup.id === preferredId) continue // already tried in step 1
    if (!isSupervisorOnline(sup.id)) continue
    if (!isRecent(sup.last_seen_at)) continue
    const r = await reserveSessionSlot(userId, sup.id)
    if (r.ok) {
      return { kind: 'supervisor', supervisor_id: sup.id, running: r.running, cap: r.cap }
    }
  }

  // Step 3: local agent fallback.
  const agentSessionIds = listOnlineAgentSessionsForUser(userId)
  if (agentSessionIds.length > 0) {
    return { kind: 'local_agent', agent_session_id: agentSessionIds[0] }
  }

  // Step 4: nothing.
  return { kind: 'none', reason: 'no_target_available' }
}
