/**
 * PTYCAP-08 boot seed: one task_qc (task-quality auditor) row per user that has at
 * least one auditable task (D-02, D-05, A-08, F2-B2, F2-B3).
 *
 * Runs once per boot from hub/src/index.ts BEFORE schedRegistry.loadAll(), so the
 * normal loader arms the row. Code at boot, never schema.sql (schema.sql re-runs
 * every boot; this is data). Idempotent: the per-user partial unique index plus
 * ON CONFLICT DO NOTHING makes a re-run, or a racing second hub, insert nothing.
 *
 * Anchor decision (F2-B2): scheduled_tasks.session_id is nullable (schema.sql DROP
 * NOT NULL), so the row binds NO session. Deleting a session cannot cascade-delete
 * the auditor, and a session-scoped kill-switch row never matches it.
 *
 * Flag OFF (default): returns before any database call. No INSERT, no UPDATE, no
 * DELETE ever targets an existing row.
 */
import { sql } from '../db/postgres.ts'
import { isValidTimezone } from '../scheduler/cron.ts'
import { isTaskQcEnabled, isTaskQcAutofixEnabled, taskQcCadenceCron } from './flags.ts'

/** Must NOT start with `__internal_` (internal plumbing is excluded from the audit set). */
export const TASK_QC_TASK_NAME = 'Task quality audit'

export interface SeedResult {
  seeded: number
}

export async function seedTaskQcTasks(): Promise<SeedResult> {
  if (!isTaskQcEnabled()) return { seeded: 0 }

  if (!isTaskQcAutofixEnabled()) {
    console.log('[task-qc.seed] auditor enabled in report-only mode (REMO_TASK_QC_AUTOFIX off): findings are proposed, nothing is changed')
  }

  let users: Array<{ id: string; timezone: string | null }>
  try {
    // Same predicate as the audit-set load (task-qc/load.ts): enabled, cron kind,
    // not task_qc, not orchestrator, not __internal_*. And no task_qc row yet.
    users = (await sql`
      SELECT u.id, u.timezone FROM users u
      WHERE EXISTS (
        SELECT 1 FROM scheduled_tasks t
        WHERE t.user_id = u.id AND t.enabled = true AND t.task_type <> 'task_qc' AND t.task_type <> 'orchestrator'
          AND NOT starts_with(t.name, '__internal_') AND t.schedule_kind = 'cron'
      )
      AND NOT EXISTS (SELECT 1 FROM scheduled_tasks q WHERE q.user_id = u.id AND q.task_type = 'task_qc')
    `) as any
  } catch (err: any) {
    console.error(`[task-qc.seed] eligibility query failed: ${err?.message ?? err}`)
    return { seeded: 0 }
  }

  const cron = taskQcCadenceCron()
  let seeded = 0
  for (const u of users) {
    const tz = u.timezone && isValidTimezone(u.timezone) ? u.timezone : 'UTC'
    try {
      const rows = (await sql`
        INSERT INTO scheduled_tasks (
          user_id, session_id, name, cron_expression, prompt, enabled,
          task_type, target_kind, target_id, payload, cron_expr, timezone,
          catchup_policy, max_concurrent, post_run_actions, email_summary, schedule_kind
        ) VALUES (
          ${u.id}, NULL, ${TASK_QC_TASK_NAME}, ${cron}, '', ${true},
          'task_qc', 'session', NULL, '{}'::jsonb, ${cron}, ${tz},
          'skip', 1, '[]'::jsonb, ${false}, 'cron'
        )
        ON CONFLICT (user_id) WHERE task_type = 'task_qc' DO NOTHING
        RETURNING id
      `) as any[]
      seeded += rows.length
    } catch (err: any) {
      console.error(`[task-qc.seed] failed for user=${u.id}: ${err?.message ?? err}`)
    }
  }
  if (seeded > 0) console.log(`[task-qc.seed] seeded ${seeded} task_qc row(s)`)
  return { seeded }
}
