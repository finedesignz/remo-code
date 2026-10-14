/**
 * PTYCAP-08 bounded read layer (D-03, D-07, D-11, D-12, D-14, F1-A3, F2-B7).
 * Builds the pure detectors' inputs from the database in ONE read-only
 * transaction with a local statement timeout derived from the pass deadline.
 * The audit set is enforced in SQL (and again by the detectors' isAuditable),
 * every statement is user-scoped, the history read is a single windowed
 * statement bounded per task, and nothing here writes.
 *
 * The one cross-module dependency is the sender's own app-uuid resolver
 * (exported, not re-implemented) used to fill resolvedAppUuid for log tasks. It
 * is imported lazily, only when a log task is audited, exactly as the
 * dispatcher itself loads that sender.
 */
import type { QueryRunner } from './findings.ts'
import { TASK_QC_BOUNDS, type TaskQcBounds } from './flags.ts'
import type { AuditTaskInput, RunInput, SessionInput, TaskQcScope } from './types.ts'

type ReadTx = QueryRunner & { unsafe(text: string): PromiseLike<any[]> }
/** The database client: postgres.js `sql` (begin accepts a mode string). */
export type ReadDb = QueryRunner & { begin<T>(mode: string, fn: (tx: ReadTx) => Promise<T>): Promise<T> }

export interface LoadArgs {
  userId: string
  scope?: TaskQcScope
  bounds?: TaskQcBounds
  /** absolute wall-clock deadline in clock() milliseconds */
  deadline: number
  clock?: () => number
  runner: ReadDb
  now?: Date
  /** take the per-user advisory lock (same key as the run claim) for the detection read */
  lock?: boolean
  resolveAppUuid?: (task: AuditTaskInput, userId: string) => Promise<string | null>
}

export interface LoadedAudit {
  tasks: AuditTaskInput[]
  runsByTask: Record<string, RunInput[]>
  sessionsById: Record<string, SessionInput | null>
  userTimezone: string
  truncated: boolean
}

const empty = (truncated: boolean): LoadedAudit => ({
  tasks: [],
  runsByTask: {},
  sessionsById: {},
  userTimezone: 'UTC',
  truncated,
})

const effectiveSession = (t: AuditTaskInput): string | null => (t.target_kind === 'session' ? (t.target_id ?? t.session_id ?? null) : null)

export async function loadAuditInputs(args: LoadArgs): Promise<LoadedAudit> {
  const { userId, runner } = args
  const bounds = args.bounds ?? TASK_QC_BOUNDS
  const clock = args.clock ?? Date.now
  const ids = Array.isArray(args.scope?.taskIds) ? args.scope!.taskIds!.filter((x) => typeof x === 'string') : null
  const want = (d: string) => !args.scope?.detectors || (args.scope.detectors as string[]).includes(d)

  // an empty narrowing audits nothing; a passed deadline reads nothing
  if (ids && ids.length === 0) return empty(false)
  const remaining = args.deadline - clock()
  if (remaining <= 0) return empty(true)

  const out = await runner.begin('read only', async (tx): Promise<LoadedAudit> => {
    if (args.lock) await tx`SELECT pg_advisory_xact_lock(hashtext(${'taskqc:' + userId})::bigint)`
    await tx.unsafe(`SET LOCAL statement_timeout = ${Math.max(1, Math.floor(remaining))}`)

    const taskRows = (await tx`
      SELECT id, user_id, name, task_type, enabled, schedule_kind, cron_expr, cron_expression, timezone,
             created_at, last_fire_at, next_fire_at, target_kind, target_id, session_id, prompt, payload, teab_repo_ident
      FROM scheduled_tasks WHERE user_id = ${userId}
        AND enabled = true AND task_type <> 'task_qc' AND task_type <> 'orchestrator'
        AND NOT starts_with(name, '__internal_') AND schedule_kind = 'cron'
        AND (${ids}::text[] IS NULL OR id = ANY(${ids}::text[]))
      ORDER BY created_at ASC LIMIT ${bounds.maxAuditedTasks + 1}
    `) as AuditTaskInput[]
    const owned = taskRows.filter((t) => t.user_id === userId)
    const truncatedTasks = owned.length > bounds.maxAuditedTasks
    const tasks = owned.slice(0, bounds.maxAuditedTasks)
    if (clock() >= args.deadline) return { ...empty(true) }
    if (tasks.length === 0) return empty(truncatedTasks)
    const taskIds = tasks.map((t) => t.id)

    const runRows = (await tx`
      SELECT id, task_id, status, error, started_at, finished_at, output_snippet FROM (
        SELECT id, task_id, status, error, started_at, finished_at, output_snippet,
               ROW_NUMBER() OVER (PARTITION BY task_id ORDER BY started_at DESC) AS rn
        FROM scheduled_task_runs WHERE user_id = ${userId} AND task_id = ANY(${taskIds}::text[])
      ) t WHERE rn <= ${bounds.maxRunsPerTask}
    `) as RunInput[]
    const runsByTask: Record<string, RunInput[]> = {}
    for (const r of runRows) (runsByTask[r.task_id] ??= []).push(r)

    const sessionsById: Record<string, SessionInput | null> = {}
    const sids = [...new Set(tasks.map(effectiveSession).filter((s): s is string => s != null))]
    if (sids.length > 0 && want('DEAD_SESSION')) {
      const rows = (await tx`
        SELECT id, status, deleted_at, last_activity, created_at, repo_key
        FROM sessions WHERE user_id = ${userId} AND id = ANY(${sids}::text[])
      `) as SessionInput[]
      for (const sid of sids) sessionsById[sid] = null
      for (const r of rows) sessionsById[r.id] = r
    }

    const tzRows = (await tx`SELECT timezone FROM users WHERE id = ${userId} LIMIT 1`) as Array<{ timezone?: string | null }>
    const userTimezone = tzRows[0]?.timezone || 'UTC'

    return { tasks, runsByTask, sessionsById, userTimezone, truncated: truncatedTasks }
  })

  // The sender's resolver reads through its own DAL (outside this transaction).
  if (out.tasks.length > 0 && want('MISCONFIGURED')) {
    const logTasks = out.tasks.filter((t) => t.task_type === 'log_check' || t.task_type === 'log_pull')
    let resolve = args.resolveAppUuid
    if (!resolve && logTasks.length > 0) {
      const { resolveAppUuid } = await import('../scheduler/senders/coolify.ts')
      resolve = (t, u) => resolveAppUuid(t as never, u)
    }
    for (const t of logTasks) {
      if (clock() >= args.deadline) return { ...out, tasks: [], runsByTask: {}, sessionsById: {}, truncated: true }
      t.resolvedAppUuid = (await resolve!(t, userId)) ?? null
    }
  }
  return out
}

/** Distinct non-empty application uuids of the user's OTHER enabled log tasks on the same session or repo. */
export async function loadSiblingUuids(q: QueryRunner, userId: string, task: AuditTaskInput): Promise<string[]> {
  const sid = task.target_id ?? task.session_id ?? null
  if (sid == null) return []
  const rows = (await q`
    SELECT DISTINCT COALESCE(NULLIF(t.payload->>'application_uuid', ''), NULLIF(t.payload->>'app_uuid', '')) AS application_uuid
    FROM scheduled_tasks t
    LEFT JOIN sessions s ON s.id = COALESCE(t.target_id, t.session_id) AND s.user_id = ${userId}
    WHERE t.user_id = ${userId} AND t.enabled = true AND t.task_type IN ('log_check', 'log_pull') AND t.id <> ${task.id}
      AND (
        COALESCE(t.target_id, t.session_id) = ${sid}
        OR (s.repo_key IS NOT NULL AND s.repo_key = (SELECT repo_key FROM sessions WHERE id = ${sid} AND user_id = ${userId}))
      )
    LIMIT 20
  `) as Array<{ application_uuid?: string | null }>
  return [...new Set(rows.map((r) => (typeof r.application_uuid === 'string' ? r.application_uuid.trim() : '')).filter((x) => x !== ''))]
}

/** Live (online or thinking), non-deleted sessions of the user with the dead session's non-NULL repo_key. */
export async function loadLiveSessionCandidates(
  q: QueryRunner,
  userId: string,
  dead: { id: string; repo_key?: string | null } | null,
): Promise<string[]> {
  const repoKey = typeof dead?.repo_key === 'string' ? dead.repo_key.trim() : ''
  if (!dead || repoKey === '') return []
  const rows = (await q`
    SELECT id FROM sessions WHERE user_id = ${userId} AND repo_key = ${repoKey}
      AND id <> ${dead.id} AND deleted_at IS NULL AND status IN ('online', 'thinking')
    LIMIT ${10}
  `) as Array<{ id: string }>
  return rows.map((r) => r.id)
}
