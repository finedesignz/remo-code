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
 * ATOMICITY: the slot-consuming `INSERT INTO session_runs` runs INSIDE the same
 * `FOR UPDATE` transaction. Pass the run fields via the `runFields` argument and
 * use the returned `run` row. This closes the over-admission race: because the
 * supervisor row stays locked until the tx commits, a concurrent reserver blocks
 * on `FOR UPDATE` until the prior reservation's INSERT has committed, so its
 * `COUNT(*)` already reflects the in-flight reservation. Under true `Promise.all`
 * parallelism at cap, exactly `cap` reservations win.
 *
 * Callers MUST pass `runFields` so reserve+consume is one tx boundary. The legacy
 * gate-only form (no `runFields`) is retained ONLY for callers that have nothing
 * to insert (pure capacity probes) — it does NOT consume a slot and re-introduces
 * the race if used as a reserve-then-insert-later gate, so don't.
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

/**
 * Run fields consumed atomically inside the reservation tx. Mirrors `createRun`
 * in supervisor-dal.ts so the INSERT can move into the FOR-UPDATE window without
 * the caller composing a separate insert.
 */
export interface ReserveRunFields {
  sessionId: string | null
  repoPath: string
  branch: string | null
  pulled: boolean
  initialPrompt: string | null
  restartOf?: string | null
  restartCount?: number
}

export type ReserveResult =
  | { ok: true; running: number; cap: number; run: { id: string } | null }
  | { ok: false; reason: 'at_capacity'; running: number; cap: number }
  | { ok: false; reason: 'supervisor_not_found' }

/**
 * Atomically reserve a session slot against the supervisor's effective cap and,
 * when `runFields` is supplied, consume it by inserting the `session_runs` row
 * inside the SAME `SELECT ... FOR UPDATE` transaction.
 *
 * Concurrent reservers targeting the same supervisor are serialised on the
 * supervisor row lock: at cap, exactly `cap` win and the rest see `at_capacity`.
 * The consuming INSERT is committed before the lock releases, so the next
 * reserver's count already includes it — no over-admission under parallelism.
 */
export async function reserveSessionSlot(
  userId: string,
  supervisorId: string,
  runFields?: ReserveRunFields,
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

    // Consume the slot inside the locked window so the reservation is reflected
    // in the open-run count seen by the next reserver waiting on FOR UPDATE.
    let run: { id: string } | null = null
    if (runFields) {
      const runRows = await tx<{ id: string }[]>`
        INSERT INTO session_runs
          (user_id, session_id, supervisor_id, repo_path, branch, pulled, initial_prompt, restart_of, restart_count)
        VALUES (
          ${userId}, ${runFields.sessionId}, ${supervisorId}, ${runFields.repoPath},
          ${runFields.branch}, ${runFields.pulled}, ${runFields.initialPrompt},
          ${runFields.restartOf ?? null}, ${runFields.restartCount ?? 0}
        )
        RETURNING id
      `
      run = runRows[0] ?? null
    }

    return { ok: true, running, cap, run } as const
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

/**
 * B4 (obs): total open session_runs across all supervisors. Used to update
 * the `remo_session_runs_in_flight` gauge at /metrics scrape time.
 */
export async function getInFlightRunCount(): Promise<number> {
  const rows = await sql<{ running: string }[]>`
    SELECT COUNT(*)::text AS running FROM session_runs WHERE ended_at IS NULL
  `
  return Number(rows[0]?.running ?? 0)
}
