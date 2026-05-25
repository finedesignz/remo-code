/**
 * Phase 04 plan 003 — Hub-authoritative concurrency gate.
 *
 * The hub is the source of truth for how many parallel session_runs a given
 * supervisor may host. `reserveSessionSlot` opens a serialised window with
 * `SELECT ... FOR UPDATE` on the supervisor row, computes the effective cap as
 *   cap = LEAST(COALESCE(concurrency_override, concurrency_budget), concurrency_budget * 2)
 * and rejects with `at_capacity` when the live count of open session_runs
 * (ended_at IS NULL) is already >= cap.
 *
 * The actual `INSERT INTO session_runs` is the caller's responsibility — this
 * function only gates. That keeps the lock window tight and means callers can
 * compose the run row with whatever fields they need (restart_of, etc.).
 *
 * `releaseSessionSlot` is intentionally a no-op for now: the running count is
 * derived from `session_runs.ended_at IS NULL`, which the existing close paths
 * already update. The function exists as an explicit hook so future migrations
 * to a dedicated counter (e.g. a `supervisors.running_count` column) can land
 * without re-touching every caller.
 *
 * See .planning/phases/04-coolify-dev-supervisor/ARCHITECTURE-REVIEW.md §3.
 */
import { sql } from '../db/postgres.ts'

export type ReserveResult =
  | { ok: true; running: number; cap: number }
  | { ok: false; reason: 'at_capacity'; running: number; cap: number }
  | { ok: false; reason: 'supervisor_not_found' }

/**
 * Atomically reserve a session slot against the supervisor's effective cap.
 *
 * Runs in a transaction with `SELECT ... FOR UPDATE` so concurrent reservers
 * targeting the same supervisor are serialised: at cap, exactly one wins and
 * the others see `at_capacity`.
 */
export async function reserveSessionSlot(
  userId: string,
  supervisorId: string,
): Promise<ReserveResult> {
  return sql.begin(async (tx) => {
    const supRows = await tx<{
      concurrency_budget: number
      concurrency_override: number | null
    }[]>`
      SELECT concurrency_budget, concurrency_override
      FROM supervisors
      WHERE id = ${supervisorId} AND user_id = ${userId}
      FOR UPDATE
    `
    const sup = supRows[0]
    if (!sup) {
      return { ok: false, reason: 'supervisor_not_found' } as const
    }

    const budget = Math.max(1, Number(sup.concurrency_budget ?? 1))
    const override = sup.concurrency_override == null
      ? null
      : Math.max(1, Number(sup.concurrency_override))
    // Hard server-side ceiling: even if a stale override row exists from before
    // the Plan 002 PATCH clamp landed, the gate never lets it exceed budget*2.
    const cap = Math.min(override ?? budget, budget * 2)

    const countRows = await tx<{ running: string }[]>`
      SELECT COUNT(*)::text AS running
      FROM session_runs
      WHERE supervisor_id = ${supervisorId} AND ended_at IS NULL
    `
    const running = Number(countRows[0]?.running ?? 0)

    if (running >= cap) {
      return { ok: false, reason: 'at_capacity', running, cap } as const
    }
    return { ok: true, running, cap } as const
  }) as Promise<ReserveResult>
}

/**
 * Release a session slot. Currently a no-op — the open-count derives from
 * `session_runs.ended_at IS NULL`, which existing close paths already set.
 *
 * Kept as an explicit function so future implementations can switch to a
 * dedicated counter without touching every caller.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function releaseSessionSlot(
  _userId: string,
  _supervisorId: string,
): Promise<void> {
  return
}

/**
 * Read the current effective cap + running count for a supervisor without
 * reserving. Used to broadcast `supervisor_capacity_changed` on release.
 * Returns null if supervisor doesn't exist for the user.
 */
export async function getCapacitySnapshot(
  userId: string,
  supervisorId: string,
): Promise<{ running: number; cap: number } | null> {
  const supRows = await sql<{
    concurrency_budget: number
    concurrency_override: number | null
  }[]>`
    SELECT concurrency_budget, concurrency_override
    FROM supervisors
    WHERE id = ${supervisorId} AND user_id = ${userId}
  `
  const sup = supRows[0]
  if (!sup) return null
  const budget = Math.max(1, Number(sup.concurrency_budget ?? 1))
  const override = sup.concurrency_override == null
    ? null
    : Math.max(1, Number(sup.concurrency_override))
  const cap = Math.min(override ?? budget, budget * 2)

  const countRows = await sql<{ running: string }[]>`
    SELECT COUNT(*)::text AS running
    FROM session_runs
    WHERE supervisor_id = ${supervisorId} AND ended_at IS NULL
  `
  return { running: Number(countRows[0]?.running ?? 0), cap }
}
