import { sql } from './postgres.ts'

export type OnCompleteAction =
  | { type: 'none' }
  | { type: 'chain'; chain_task_id: string }
  | { type: 'notify'; notify_email?: string }

// ── New shape (architect-approved) ────────────────────────────────────────────
// PostRunAction is intentionally typed as `any` for the DAL — strict Zod schema
// lives in `hub/src/scheduler/post-run/schema.ts` (T8.6) and gates writes at
// the API layer.
export type PostRunAction = any

export type TaskType = 'prompt' | 'skill' | 'security_scan' | 'log_check' | 'continue_dev' | 'triage'
export type TargetKind = 'session' | 'supervisor' | 'all_agents' | 'all_supervisors'
export type CatchupPolicy = 'skip' | 'run_once'
export type RunStatus =
  | 'pending'
  | 'in_flight'
  | 'running' // legacy alias, still accepted by the CHECK constraint
  | 'success'
  | 'failed'
  | 'skipped'
  | 'skipped_quota'
  | 'cancelled'

export interface ScheduledTask {
  id: string
  user_id: string
  session_id: string | null
  name: string
  cron_expression: string
  prompt: string
  enabled: boolean
  last_run_at: string | null
  next_run_at: string | null
  on_complete: OnCompleteAction
  created_at: string
  updated_at: string
  // New shape — present on rows created by the new dispatcher; may be NULL/default
  // on legacy rows during the transition window.
  task_type: TaskType
  target_kind: TargetKind
  target_id: string | null
  payload: Record<string, any>
  cron_expr: string | null
  timezone: string
  catchup_policy: CatchupPolicy
  max_concurrent: number
  last_fire_at: string | null
  next_fire_at: string | null
  post_run_actions: PostRunAction[]
  // Auto-name parts. `name_prefix` is the server-computed locked portion
  // (e.g. "Continue Dev on finedesignz/kh-hub every 4h"); `name_suffix` is
  // the user's optional free-form note. The legacy `name` column stays
  // authoritative for back-compat — DAL writes keep all three in sync.
  name_prefix: string | null
  name_suffix: string | null
  // Simpler-cron picker: structured rules. NULL on legacy rows (UI falls
  // back to deriving a single rule from `cron_expr`). Array of
  // `{interval, unit, start_at}`.
  schedule_rules: any[] | null
  // Derived from latest finalized run via LATERAL JOIN in listTasksForUser/getTask.
  last_run_cost_usd?: number | null
  last_run_duration_ms?: number | null
}

export interface ScheduledTaskRun {
  id: string
  task_id: string
  user_id: string
  session_id: string | null
  started_at: string
  completed_at: string | null
  status: RunStatus
  error: string | null
  // New columns (nullable on legacy rows)
  scheduled_for: string | null
  finished_at: string | null
  target_kind: TargetKind | null
  target_id: string | null
  cost_usd: string | null // numeric returned as string by node-postgres
  duration_ms: number | null
  output_snippet: string | null
  triggered_by_run_id: string | null
  created_at: string
}

export async function listTasksForUser(userId: string): Promise<ScheduledTask[]> {
  const rows = await sql<ScheduledTask[]>`
    SELECT t.*,
           latest.cost_usd AS last_run_cost_usd,
           latest.duration_ms AS last_run_duration_ms
    FROM scheduled_tasks t
    LEFT JOIN LATERAL (
      SELECT r.cost_usd,
             EXTRACT(EPOCH FROM (r.finished_at - r.started_at)) * 1000 AS duration_ms
      FROM scheduled_task_runs r
      WHERE r.task_id = t.id
        AND r.finished_at IS NOT NULL
      ORDER BY r.finished_at DESC
      LIMIT 1
    ) latest ON true
    WHERE t.user_id = ${userId}
    ORDER BY t.created_at DESC
  `
  return rows.map(normalize)
}

export async function getTask(id: string, userId: string): Promise<ScheduledTask | null> {
  const rows = await sql<ScheduledTask[]>`
    SELECT t.*,
           latest.cost_usd AS last_run_cost_usd,
           latest.duration_ms AS last_run_duration_ms
    FROM scheduled_tasks t
    LEFT JOIN LATERAL (
      SELECT r.cost_usd,
             EXTRACT(EPOCH FROM (r.finished_at - r.started_at)) * 1000 AS duration_ms
      FROM scheduled_task_runs r
      WHERE r.task_id = t.id
        AND r.finished_at IS NOT NULL
      ORDER BY r.finished_at DESC
      LIMIT 1
    ) latest ON true
    WHERE t.id = ${id} AND t.user_id = ${userId}
    LIMIT 1
  `
  return rows[0] ? normalize(rows[0]) : null
}

export async function getTaskById(id: string): Promise<ScheduledTask | null> {
  const rows = await sql<ScheduledTask[]>`
    SELECT * FROM scheduled_tasks WHERE id = ${id} LIMIT 1
  `
  return rows[0] ? normalize(rows[0]) : null
}

export async function deleteTask(id: string, userId: string): Promise<boolean> {
  const rows = await sql`DELETE FROM scheduled_tasks WHERE id = ${id} AND user_id = ${userId} RETURNING id`
  return rows.length > 0
}

export async function markOrphanedRunsInterrupted() {
  await sql`
    UPDATE scheduled_task_runs SET status = 'failed', error = 'hub_restart', completed_at = now()
    WHERE status = 'running'
  `
}

function normalize(row: any): ScheduledTask {
  const on_complete =
    typeof row.on_complete === 'string' ? JSON.parse(row.on_complete) : row.on_complete
  const payload =
    typeof row.payload === 'string' ? JSON.parse(row.payload) : (row.payload ?? {})
  const post_run_actions =
    typeof row.post_run_actions === 'string'
      ? JSON.parse(row.post_run_actions)
      : (row.post_run_actions ?? [])
  const schedule_rules =
    row.schedule_rules == null
      ? null
      : typeof row.schedule_rules === 'string'
        ? JSON.parse(row.schedule_rules)
        : row.schedule_rules
  // node-postgres returns NUMERIC as string; coerce when present. EXTRACT(EPOCH ...)
  // comes back as a number (double precision) but normalize defensively.
  const last_run_cost_usd =
    row.last_run_cost_usd === null || row.last_run_cost_usd === undefined
      ? null
      : Number(row.last_run_cost_usd)
  const last_run_duration_ms =
    row.last_run_duration_ms === null || row.last_run_duration_ms === undefined
      ? null
      : Number(row.last_run_duration_ms)
  return {
    ...row,
    on_complete,
    payload,
    post_run_actions,
    schedule_rules,
    last_run_cost_usd,
    last_run_duration_ms,
  }
}

// ── V2 API (architect-approved scheduled-tasks phase) ────────────────────────
// Operates on the extended columns added in the Wave 1 migration
// (task_type/target_kind/target_id/payload/cron_expr/timezone/catchup_policy/
// max_concurrent/last_fire_at/next_fire_at/post_run_actions on tasks;
// scheduled_for/finished_at/target_kind/target_id/cost_usd/duration_ms/
// output_snippet/triggered_by_run_id/created_at on runs).

export async function listEnabledTasks(): Promise<ScheduledTask[]> {
  const rows = await sql<ScheduledTask[]>`
    SELECT * FROM scheduled_tasks WHERE enabled = true ORDER BY created_at ASC
  `
  return rows.map(normalize)
}

export async function createTaskV2(input: {
  user_id: string
  name: string
  task_type: TaskType
  target_kind: TargetKind
  target_id?: string | null
  payload?: Record<string, any>
  cron_expr: string
  timezone: string
  catchup_policy?: CatchupPolicy
  max_concurrent?: number
  enabled?: boolean
  post_run_actions?: PostRunAction[]
  // Legacy `scheduled_tasks` columns kept for backward compat. session_id is
  // NULL for fan-out kinds (all_agents/all_supervisors) and the target session
  // id for `target_kind = 'session'`.
  session_id: string | null
  cron_expression?: string
  prompt?: string
  name_prefix?: string | null
  name_suffix?: string | null
  schedule_rules?: any[] | null
}): Promise<ScheduledTask> {
  const rows = await sql<ScheduledTask[]>`
    INSERT INTO scheduled_tasks (
      user_id, session_id, name, cron_expression, prompt, enabled,
      task_type, target_kind, target_id, payload, cron_expr, timezone,
      catchup_policy, max_concurrent, post_run_actions,
      name_prefix, name_suffix, schedule_rules
    ) VALUES (
      ${input.user_id}, ${input.session_id}, ${input.name},
      ${input.cron_expression ?? input.cron_expr}, ${input.prompt ?? ''},
      ${input.enabled ?? true},
      ${input.task_type}, ${input.target_kind}, ${input.target_id ?? null},
      ${sql.json((input.payload ?? {}) as any)}, ${input.cron_expr},
      ${input.timezone}, ${input.catchup_policy ?? 'skip'},
      ${input.max_concurrent ?? 1},
      ${sql.json((input.post_run_actions ?? []) as any)},
      ${input.name_prefix ?? null}, ${input.name_suffix ?? null},
      ${input.schedule_rules ? sql.json(input.schedule_rules as any) : null}
    )
    RETURNING *
  `
  return normalize(rows[0])
}

export async function updateTaskV2(
  id: string,
  userId: string,
  fields: Partial<{
    name: string
    enabled: boolean
    task_type: TaskType
    target_kind: TargetKind
    target_id: string | null
    payload: Record<string, any>
    cron_expr: string
    timezone: string
    catchup_policy: CatchupPolicy
    max_concurrent: number
    post_run_actions: PostRunAction[]
    name_prefix: string | null
    name_suffix: string | null
    schedule_rules: any[] | null
  }>,
): Promise<ScheduledTask | null> {
  const sets: any[] = []
  if (fields.name !== undefined) sets.push(sql`name = ${fields.name}`)
  if (fields.name_prefix !== undefined) sets.push(sql`name_prefix = ${fields.name_prefix}`)
  if (fields.name_suffix !== undefined) sets.push(sql`name_suffix = ${fields.name_suffix}`)
  if (fields.enabled !== undefined) sets.push(sql`enabled = ${fields.enabled}`)
  if (fields.task_type !== undefined) sets.push(sql`task_type = ${fields.task_type}`)
  if (fields.target_kind !== undefined) sets.push(sql`target_kind = ${fields.target_kind}`)
  if (fields.target_id !== undefined) sets.push(sql`target_id = ${fields.target_id}`)
  if (fields.payload !== undefined) sets.push(sql`payload = ${sql.json(fields.payload as any)}`)
  if (fields.cron_expr !== undefined) {
    sets.push(sql`cron_expr = ${fields.cron_expr}`)
    sets.push(sql`cron_expression = ${fields.cron_expr}`)
  }
  if (fields.timezone !== undefined) sets.push(sql`timezone = ${fields.timezone}`)
  if (fields.catchup_policy !== undefined) sets.push(sql`catchup_policy = ${fields.catchup_policy}`)
  if (fields.max_concurrent !== undefined) sets.push(sql`max_concurrent = ${fields.max_concurrent}`)
  if (fields.post_run_actions !== undefined) {
    sets.push(sql`post_run_actions = ${sql.json(fields.post_run_actions as any)}`)
  }
  if (fields.schedule_rules !== undefined) {
    sets.push(sql`schedule_rules = ${fields.schedule_rules ? sql.json(fields.schedule_rules as any) : null}`)
  }
  if (sets.length === 0) return getTask(id, userId)
  sets.push(sql`updated_at = now()`)

  let q = sql`UPDATE scheduled_tasks SET `
  for (let i = 0; i < sets.length; i++) {
    q = i === 0 ? sql`${q}${sets[i]}` : sql`${q}, ${sets[i]}`
  }
  const rows = await sql<ScheduledTask[]>`${q} WHERE id = ${id} AND user_id = ${userId} RETURNING *`
  return rows[0] ? normalize(rows[0]) : null
}

export async function setTaskFireTimestamps(
  id: string,
  last: Date | null,
  next: Date | null,
): Promise<void> {
  await sql`
    UPDATE scheduled_tasks
    SET last_fire_at = ${last}, next_fire_at = ${next},
        last_run_at = COALESCE(${last}, last_run_at),
        next_run_at = ${next},
        updated_at = now()
    WHERE id = ${id}
  `
}

export async function insertRunV2(input: {
  task_id: string
  user_id: string
  status: RunStatus
  scheduled_for: Date
  target_kind: TargetKind
  target_id?: string | null
  session_id?: string | null
  triggered_by_run_id?: string | null
  error?: string | null
  output_snippet?: string | null
  started_at?: Date | null
  finished_at?: Date | null
}): Promise<ScheduledTaskRun> {
  const startedAt =
    input.started_at !== undefined
      ? input.started_at
      : input.status === 'pending' ? null : new Date()
  const finishedAt = input.finished_at ?? null
  const rows = await sql<ScheduledTaskRun[]>`
    INSERT INTO scheduled_task_runs (
      task_id, user_id, session_id, status, error,
      scheduled_for, target_kind, target_id, triggered_by_run_id,
      started_at, finished_at, output_snippet
    ) VALUES (
      ${input.task_id}, ${input.user_id}, ${input.session_id ?? null},
      ${input.status}, ${input.error ?? null},
      ${input.scheduled_for}, ${input.target_kind}, ${input.target_id ?? null},
      ${input.triggered_by_run_id ?? null},
      ${startedAt}, ${finishedAt}, ${input.output_snippet ?? null}
    )
    RETURNING *
  `
  return rows[0]
}

export async function updateRunStatus(
  runId: string,
  fields: Partial<{
    status: RunStatus
    error: string | null
    cost_usd: number | null
    duration_ms: number | null
    output_snippet: string | null
    finished_at: Date | null
    started_at: Date | null
  }>,
): Promise<ScheduledTaskRun | null> {
  const sets: any[] = []
  if (fields.status !== undefined) sets.push(sql`status = ${fields.status}`)
  if (fields.error !== undefined) sets.push(sql`error = ${fields.error}`)
  if (fields.cost_usd !== undefined) sets.push(sql`cost_usd = ${fields.cost_usd}`)
  if (fields.duration_ms !== undefined) sets.push(sql`duration_ms = ${fields.duration_ms}`)
  if (fields.output_snippet !== undefined) sets.push(sql`output_snippet = ${fields.output_snippet}`)
  if (fields.finished_at !== undefined) {
    sets.push(sql`finished_at = ${fields.finished_at}`)
    sets.push(sql`completed_at = ${fields.finished_at}`)
  }
  if (fields.started_at !== undefined) sets.push(sql`started_at = ${fields.started_at}`)
  if (sets.length === 0) return null

  let q = sql`UPDATE scheduled_task_runs SET `
  for (let i = 0; i < sets.length; i++) {
    q = i === 0 ? sql`${q}${sets[i]}` : sql`${q}, ${sets[i]}`
  }
  const rows = await sql<ScheduledTaskRun[]>`${q} WHERE id = ${runId} RETURNING *`
  return rows[0] ?? null
}

export async function listRunsForTaskV2(
  taskId: string,
  userId: string,
  opts: { limit?: number; before?: Date } = {},
): Promise<ScheduledTaskRun[]> {
  const limit = opts.limit ?? 50
  if (opts.before) {
    return sql<ScheduledTaskRun[]>`
      SELECT * FROM scheduled_task_runs
      WHERE task_id = ${taskId} AND user_id = ${userId}
        AND scheduled_for < ${opts.before}
      ORDER BY scheduled_for DESC NULLS LAST, started_at DESC
      LIMIT ${limit}
    `
  }
  return sql<ScheduledTaskRun[]>`
    SELECT * FROM scheduled_task_runs
    WHERE task_id = ${taskId} AND user_id = ${userId}
    ORDER BY scheduled_for DESC NULLS LAST, started_at DESC
    LIMIT ${limit}
  `
}

export async function getRun(runId: string, userId: string): Promise<ScheduledTaskRun | null> {
  const rows = await sql<ScheduledTaskRun[]>`
    SELECT * FROM scheduled_task_runs WHERE id = ${runId} AND user_id = ${userId} LIMIT 1
  `
  return rows[0] ?? null
}

/**
 * Sum today's run cost for a user. "Today" is computed in the user's local
 * timezone passed as IANA name (e.g. 'America/Los_Angeles'). Falls back to UTC
 * if the tz is invalid.
 */
export async function sumTodayCostForUser(userId: string, timezone: string): Promise<number> {
  const tz = timezone || 'UTC'
  const rows = await sql<{ sum: string | null }[]>`
    SELECT COALESCE(SUM(cost_usd), 0)::text AS sum
    FROM scheduled_task_runs
    WHERE user_id = ${userId}
      AND scheduled_for >= date_trunc('day', now() AT TIME ZONE ${tz}) AT TIME ZONE ${tz}
      AND status IN ('success', 'failed', 'in_flight', 'running')
  `
  return Number(rows[0]?.sum ?? 0)
}

export async function insertChainedRun(
  parentRunId: string,
  childTaskId: string,
  userId: string,
  targetKind: TargetKind,
): Promise<ScheduledTaskRun> {
  return insertRunV2({
    task_id: childTaskId,
    user_id: userId,
    status: 'pending',
    scheduled_for: new Date(),
    target_kind: targetKind,
    triggered_by_run_id: parentRunId,
  })
}

export async function listActionsForTask(taskId: string): Promise<PostRunAction[]> {
  const rows = await sql<{ post_run_actions: any }[]>`
    SELECT post_run_actions FROM scheduled_tasks WHERE id = ${taskId} LIMIT 1
  `
  if (!rows[0]) return []
  const v = rows[0].post_run_actions
  return typeof v === 'string' ? JSON.parse(v) : (v ?? [])
}

/**
 * Returns the user's active API key hash, used as the HMAC secret for webhook
 * signing in post-run actions. Hash (not the raw key) — webhook recipients
 * sign with the same hash on their side. Returns null if the user has no
 * active key (caller should log + skip).
 */
export async function getSigningKeyForUser(userId: string): Promise<string | null> {
  const rows = await sql<{ key_hash: string }[]>`
    SELECT key_hash FROM api_keys
    WHERE user_id = ${userId} AND revoked_at IS NULL
    ORDER BY created_at DESC LIMIT 1
  `
  return rows[0]?.key_hash ?? null
}
