/**
 * PTYCAP-08 task-quality engine. Deterministic: no model, no dispatch, no
 * pipeline. FINAL public signature (plans 06-08 widen the body, not this).
 * Tracer scope: loads the user's tasks + recent runs with minimal inline
 * queries, runs only the WIRED_DETECTORS, persists each finding as a
 * `proposed` row (idempotent per day) and never writes to scheduled_tasks.
 */
import { sql } from '../db/postgres.ts'
import { runDetectors } from './detectors.ts'
import { insertFinding, evidenceSig, userDay, type QueryRunner } from './findings.ts'
import { TASK_QC_BOUNDS, taskQcFailStreak } from './flags.ts'
import type {
  AuditTaskInput,
  DetectorName,
  Finding,
  RunInput,
  TaskQcOrigin,
  TaskQcResult,
  TaskQcScope,
} from './types.ts'

/** Detectors the engine runs. Plan 06 widens this single list. */
export const WIRED_DETECTORS: readonly DetectorName[] = ['FAILING']

export interface TaskQcPassArgs {
  userId: string
  /** narrowing only: it can never widen past WIRED_DETECTORS */
  scope?: TaskQcScope
  origin: TaskQcOrigin
  deps?: { now?: Date; q?: QueryRunner }
}

export async function runTaskQcPass(args: TaskQcPassArgs): Promise<TaskQcResult> {
  const q: QueryRunner = args.deps?.q ?? (sql as unknown as QueryRunner)
  const now = args.deps?.now ?? new Date()
  const { userId } = args

  const tasks = (await q`
    SELECT id, user_id, name, task_type, enabled, schedule_kind, cron_expr, cron_expression, timezone,
           created_at, last_fire_at, next_fire_at, target_kind, target_id, session_id, prompt, payload, teab_repo_ident
    FROM scheduled_tasks WHERE user_id = ${userId}
    ORDER BY created_at ASC LIMIT ${TASK_QC_BOUNDS.maxAuditedTasks}
  `) as AuditTaskInput[]

  const runRows = (await q`
    SELECT id, task_id, status, error, started_at, finished_at, output_snippet FROM (
      SELECT id, task_id, status, error, started_at, finished_at, output_snippet,
             ROW_NUMBER() OVER (PARTITION BY task_id ORDER BY started_at DESC) AS rn
      FROM scheduled_task_runs WHERE user_id = ${userId}
    ) t WHERE rn <= ${TASK_QC_BOUNDS.maxRunsPerTask}
  `) as RunInput[]
  const runsByTask: Record<string, RunInput[]> = {}
  for (const r of runRows) (runsByTask[r.task_id] ??= []).push(r)

  const requested = args.scope?.detectors
  const detectors = requested ? WIRED_DETECTORS.filter((d) => requested.includes(d)) : [...WIRED_DETECTORS]
  const scope: TaskQcScope = { taskIds: args.scope?.taskIds, detectors }
  const findings: Finding[] =
    detectors.length === 0
      ? []
      : runDetectors({ tasks, runsByTask, sessionsById: {}, now }, { failStreak: taskQcFailStreak() }, scope)

  const day = userDay('UTC', now)
  const proposals: Finding[] = []
  for (const f of findings) {
    const res = await insertFinding(q, {
      userId,
      taskId: f.taskId,
      detector: f.detector,
      severity: f.severity,
      disposition: 'proposed',
      evidence: f.evidence,
      sig: evidenceSig(f.detector, f.evidence),
      day,
    })
    if (res.inserted) proposals.push(f)
  }

  return { findings, applied: [], proposals, truncated: false }
}
