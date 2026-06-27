// hub/src/orchestrator/run-log.ts
// Phase 23 (auto-dev-orchestrator) — thin read/write over routine_run_log.
// Decision D4: the run log is a DB table, per session, fed into the controller's
// runtime context each tick and surviving repo resets/worktrees.
//
// This is intentionally a THIN wrapper over the Phase-21 DAL
// (orchestrator-rows-dal.ts) so the controller has a small, stable surface
// (appendRunLog / recentRunLog) without reaching into the DAL's broader API.

import {
  insertRoutineRunLog,
  recentRoutineRunLog,
  listRunLogForUser,
  type RoutineRunLogEntry,
  type NewRoutineRunLogEntry,
} from '../db/orchestrator-rows-dal.ts';

export type { RoutineRunLogEntry, NewRoutineRunLogEntry };

/** Append one run-log entry (one per command per tick). Returns the stored row. */
export function appendRunLog(entry: NewRoutineRunLogEntry): Promise<RoutineRunLogEntry> {
  return insertRoutineRunLog(entry);
}

/** Read the last `n` run-log entries for a session, newest first (D1/D4 context). */
export function recentRunLog(sessionId: string, n = 20): Promise<RoutineRunLogEntry[]> {
  return recentRoutineRunLog(sessionId, n);
}

/** Paginated, user-scoped run-log read (OBSRV-01 / RUNLOG-01/02). */
export function listRunLog(opts: {
  userId: string;
  sessionId?: string | null;
  limit: number;
  offset: number;
}): Promise<RoutineRunLogEntry[]> {
  return listRunLogForUser(opts);
}
