/**
 * PTYCAP-08 task_qc single-open-run claim (F2-B1, D-14). One advisory-locked
 * transaction: take the per-user lock, refuse when any run of the task is still
 * non-terminal, else insert the one pending null-session run. Two overlapping
 * fires therefore cannot both claim; the loser gets null.
 */
import { sql } from '../db/postgres.ts'

export interface ClaimedTaskQcRun {
  id: string
  task_id: string
  user_id: string
  status: string
  [k: string]: unknown
}

export async function claimTaskQcRun(a: {
  taskId: string
  userId: string
  scheduledFor: Date
  triggeredByRunId?: string | null
}): Promise<ClaimedTaskQcRun | null> {
  return await (sql as any).begin(async (tx: any): Promise<ClaimedTaskQcRun | null> => {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${'taskqc:' + a.userId})::bigint)`
    const open = await tx`
      SELECT id FROM scheduled_task_runs
      WHERE task_id = ${a.taskId} AND status IN ('running', 'pending', 'in_flight')
        AND finished_at IS NULL AND completed_at IS NULL
      LIMIT 1
    `
    if (open.length > 0) return null
    const rows = await tx`
      INSERT INTO scheduled_task_runs (
        task_id, user_id, session_id, status, scheduled_for, target_kind, target_id, triggered_by_run_id, started_at
      ) VALUES (
        ${a.taskId}, ${a.userId}, NULL, 'pending', ${a.scheduledFor}, 'session', NULL, ${a.triggeredByRunId ?? null}, now()
      )
      RETURNING *
    `
    return (rows[0] as ClaimedTaskQcRun | undefined) ?? null
  })
}
