// hub/src/orchestrator/due-rows.ts
// Phase 23 (auto-dev-orchestrator) — DUE-row evaluation for the per-tick
// controller. Given an orchestrator task's rows, decide which command rows are
// DUE "now". Decisions D1 (schedule = eligibility, run ALL due) and D3 (Never =
// disabled, Once = max_runs=1 auto-disable).
//
// Reqs: R-ADO-09 (compute + run ALL due rows from each row's schedule_rule
// eligibility). REUSES the scheduler's schedule-eligibility logic — it does NOT
// reimplement cron/active_window/bounds.
//
// The core (`computeDueRows`) is PURE: the caller supplies `now`, `tz`, and a
// per-row run-count lookup, so it is trivially testable without a DB. A thin
// DB-backed helper (`computeDueRowsForTask`) loads the rows + per-command run
// counts and delegates.

import { shouldSkipFire, boundReason } from '../scheduler/schedule-rules.ts';
import type { ScheduleRule } from '../scheduler/schedule-rules.ts';
import {
  listOrchestratorRows,
  type OrchestratorRow,
} from '../db/orchestrator-rows-dal.ts';
import { sql } from '../db/postgres.ts';

/** Frequency labels with disabling / once semantics (D1/D3). Case-insensitive. */
export const FREQ_NEVER = 'never';
export const FREQ_ONCE = 'once';

export interface DueRow {
  row: OrchestratorRow;
  /**
   * True when this row should be auto-disabled after this tick fires it (the
   * `Once` / max_runs=1 case). Phase 23 only FLAGS it; the actual disable write
   * happens in the execution phase (24) alongside the run-log write.
   */
  autoDisableAfter: boolean;
}

/** Per-row run-count lookup: how many times this row's command has fired. */
export type RunCountForRow = (row: OrchestratorRow) => number;

/**
 * Resolve a row's effective `max_runs`. `Once` ⇒ 1; otherwise the rule's own
 * `max_runs` (if any); else `null` (unbounded cadence).
 */
function effectiveMaxRuns(row: OrchestratorRow): number | null {
  const label = (row.frequency_label ?? '').trim().toLowerCase();
  if (label === FREQ_ONCE) return 1;
  const rm = row.schedule_rule?.max_runs;
  return typeof rm === 'number' ? rm : null;
}

/** A rule's cadence interval in ms (months ≈ 30d — parity is handled by shouldSkipFire). */
const UNIT_MS: Record<string, number> = {
  minutes: 60_000,
  hours: 3_600_000,
  days: 86_400_000,
  weeks: 604_800_000,
  months: 2_592_000_000,
};
export function ruleIntervalMs(rule: ScheduleRule): number {
  const unit = UNIT_MS[rule.unit] ?? 0;
  const interval = Number.isFinite(rule.interval) && rule.interval > 0 ? rule.interval : 1;
  return unit * interval;
}

/**
 * Decide whether a single row is DUE at `now` (task-local `tz`), given how many
 * times it has already run (`runCount`).
 *
 * Order of checks (all fail-closed — an undecidable row is NOT due):
 *   1. disabled (enabled === false) ⇒ not due.
 *   2. frequency_label === 'Never' ⇒ not due (the row is parked/disabled).
 *   3. effective max_runs reached (Once after 1 run, or rule.max_runs) ⇒ not due.
 *   4. 'Once' not yet run ⇒ DUE (and flag autoDisableAfter).
 *   5. has a schedule_rule and the rule's cadence/window says fire now
 *      (`!shouldSkipFire`) and no end-bound is hit (`boundReason === null`) and the
 *      rule's INTERVAL HAS ELAPSED since `last_fired_at` ⇒ DUE.
 *   6. otherwise (no rule, no Once) ⇒ not due.
 *
 * (5) is the fix for the per-tick re-inject incident: `shouldSkipFire` is an
 * ELIGIBILITY predicate (start_at / week+month parity / active_window) — for a
 * minutes/hours/days rule it returns "fire" for *every* `now` past `start_at`. The
 * hub scheduler pairs it with `scheduled_tasks.next_fire_at`; orchestrator rows had
 * NO such state, so an `Every 4h` row was DUE on all 1440 daily ticks and the macro
 * prompt was re-injected every 60s. `last_fired_at` (stamped at dispatch by
 * `scanAndEnqueueDueCycles`) is that missing state.
 */
export function isRowDue(
  row: OrchestratorRow,
  now: Date,
  tz: string,
  runCount: number,
): { due: boolean; autoDisableAfter: boolean } {
  if (row.enabled === false) return { due: false, autoDisableAfter: false };

  const label = (row.frequency_label ?? '').trim().toLowerCase();
  if (label === FREQ_NEVER) return { due: false, autoDisableAfter: false };

  const maxRuns = effectiveMaxRuns(row);
  if (maxRuns != null && runCount >= maxRuns) {
    return { due: false, autoDisableAfter: false };
  }

  // 'Once' (and any max_runs=1 row) is due exactly once: it fires now, then
  // auto-disables. No cadence/window gating — it is a single eligible fire.
  if (label === FREQ_ONCE || maxRuns === 1) {
    return { due: true, autoDisableAfter: true };
  }

  const rule: ScheduleRule | null = row.schedule_rule ?? null;
  if (!rule) return { due: false, autoDisableAfter: false };

  if (shouldSkipFire(rule, now, tz)) return { due: false, autoDisableAfter: false };
  if (boundReason([rule], now, runCount) !== null) {
    return { due: false, autoDisableAfter: false };
  }

  // CADENCE GATE: the interval must have ELAPSED since this row last fired.
  // FAIL-CLOSED: a NON-NULL but unparseable stamp is treated as "just fired" (NOT
  // due) — otherwise a corrupt timestamp silently disables the gate and restores
  // per-tick firing. Only a NULL stamp (never fired) is a cold start.
  if (row.last_fired_at != null) {
    const lastFired = Date.parse(row.last_fired_at);
    if (!Number.isFinite(lastFired)) return { due: false, autoDisableAfter: false };
    if (now.getTime() - lastFired < ruleIntervalMs(rule)) {
      return { due: false, autoDisableAfter: false };
    }
  }

  return { due: true, autoDisableAfter: false };
}

/**
 * PURE due-set computation. Evaluates every row against `now`/`tz` using the
 * caller-supplied run-count lookup. Returns the DUE rows in input (sort) order.
 */
export function computeDueRows(
  rows: OrchestratorRow[],
  opts: { now?: Date; tz?: string; runCountForRow?: RunCountForRow } = {},
): DueRow[] {
  const now = opts.now ?? new Date();
  const tz = opts.tz ?? 'UTC';
  const runCountForRow = opts.runCountForRow ?? (() => 0);

  const due: DueRow[] = [];
  for (const row of rows) {
    const { due: isDue, autoDisableAfter } = isRowDue(row, now, tz, runCountForRow(row));
    if (isDue) due.push({ row, autoDisableAfter });
  }
  return due;
}

/**
 * DB-backed convenience: load a task's rows + per-command run counts, then
 * delegate to `computeDueRows`. Best-effort run-count source: counts
 * `routine_run_log` rows for this session whose `command` matches the row's
 * command (the run log is the durable per-command fire record; survives
 * worktrees per R-ADO-04). Callers without a DB should use `computeDueRows`.
 */
export async function computeDueRowsForTask(
  taskId: string,
  opts: { sessionId: string; now?: Date; tz?: string },
): Promise<DueRow[]> {
  const rows = await listOrchestratorRows(taskId);

  // One grouped query for all per-command run counts for this session.
  let counts = new Map<string, number>();
  try {
    const countRows = await sql<{ command: string; n: string }[]>`
      SELECT command, count(*)::text AS n
      FROM routine_run_log
      WHERE session_id = ${opts.sessionId}
      GROUP BY command
    `;
    counts = new Map(countRows.map((r) => [r.command, Number(r.n)]));
  } catch {
    // No DB / query failure → treat all as zero runs (fail-open on cadence,
    // fail-closed only matters for Once which then fires once — acceptable).
  }

  return computeDueRows(rows, {
    now: opts.now,
    tz: opts.tz,
    runCountForRow: (row) => counts.get(row.command) ?? 0,
  });
}
