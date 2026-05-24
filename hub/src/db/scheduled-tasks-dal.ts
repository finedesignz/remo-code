import { sql } from './postgres.ts'

export type OnCompleteAction =
  | { type: 'none' }
  | { type: 'chain'; chain_task_id: string }
  | { type: 'notify'; notify_email?: string }

export interface ScheduledTask {
  id: string
  user_id: string
  session_id: string
  name: string
  cron_expression: string
  prompt: string
  enabled: boolean
  last_run_at: string | null
  next_run_at: string | null
  on_complete: OnCompleteAction
  created_at: string
  updated_at: string
}

export interface ScheduledTaskRun {
  id: string
  task_id: string
  user_id: string
  session_id: string | null
  started_at: string
  completed_at: string | null
  status: 'running' | 'success' | 'failed' | 'skipped'
  error: string | null
}

export async function listTasksForUser(userId: string): Promise<ScheduledTask[]> {
  const rows = await sql<ScheduledTask[]>`
    SELECT * FROM scheduled_tasks WHERE user_id = ${userId} ORDER BY created_at DESC
  `
  return rows.map(normalize)
}

export async function listAllEnabledTasks(): Promise<ScheduledTask[]> {
  const rows = await sql<ScheduledTask[]>`
    SELECT * FROM scheduled_tasks WHERE enabled = true
  `
  return rows.map(normalize)
}

export async function getTask(id: string, userId: string): Promise<ScheduledTask | null> {
  const rows = await sql<ScheduledTask[]>`
    SELECT * FROM scheduled_tasks WHERE id = ${id} AND user_id = ${userId} LIMIT 1
  `
  return rows[0] ? normalize(rows[0]) : null
}

export async function getTaskById(id: string): Promise<ScheduledTask | null> {
  const rows = await sql<ScheduledTask[]>`
    SELECT * FROM scheduled_tasks WHERE id = ${id} LIMIT 1
  `
  return rows[0] ? normalize(rows[0]) : null
}

export async function createTask(input: {
  user_id: string
  session_id: string
  name: string
  cron_expression: string
  prompt: string
  enabled?: boolean
  on_complete?: OnCompleteAction
}): Promise<ScheduledTask> {
  const onComplete = input.on_complete ?? { type: 'none' }
  const rows = await sql<ScheduledTask[]>`
    INSERT INTO scheduled_tasks (user_id, session_id, name, cron_expression, prompt, enabled, on_complete)
    VALUES (${input.user_id}, ${input.session_id}, ${input.name}, ${input.cron_expression},
            ${input.prompt}, ${input.enabled ?? true}, ${sql.json(onComplete as any)})
    RETURNING *
  `
  return normalize(rows[0])
}

export async function updateTask(
  id: string,
  userId: string,
  fields: Partial<{
    name: string
    cron_expression: string
    prompt: string
    enabled: boolean
    session_id: string
    on_complete: OnCompleteAction
  }>,
): Promise<ScheduledTask | null> {
  const sets: any[] = []
  if (fields.name !== undefined) sets.push(sql`name = ${fields.name}`)
  if (fields.cron_expression !== undefined) sets.push(sql`cron_expression = ${fields.cron_expression}`)
  if (fields.prompt !== undefined) sets.push(sql`prompt = ${fields.prompt}`)
  if (fields.enabled !== undefined) sets.push(sql`enabled = ${fields.enabled}`)
  if (fields.session_id !== undefined) sets.push(sql`session_id = ${fields.session_id}`)
  if (fields.on_complete !== undefined) sets.push(sql`on_complete = ${sql.json(fields.on_complete as any)}`)
  if (sets.length === 0) return getTask(id, userId)
  sets.push(sql`updated_at = now()`)

  // Build dynamic SET clause
  let q = sql`UPDATE scheduled_tasks SET `
  for (let i = 0; i < sets.length; i++) {
    q = i === 0 ? sql`${q}${sets[i]}` : sql`${q}, ${sets[i]}`
  }
  const rows = await sql<ScheduledTask[]>`${q} WHERE id = ${id} AND user_id = ${userId} RETURNING *`
  return rows[0] ? normalize(rows[0]) : null
}

export async function setTaskFireTimes(id: string, last: Date | null, next: Date | null) {
  await sql`
    UPDATE scheduled_tasks
    SET last_run_at = ${last}, next_run_at = ${next}, updated_at = now()
    WHERE id = ${id}
  `
}

export async function deleteTask(id: string, userId: string): Promise<boolean> {
  const rows = await sql`DELETE FROM scheduled_tasks WHERE id = ${id} AND user_id = ${userId} RETURNING id`
  return rows.length > 0
}

export async function insertRun(input: {
  task_id: string
  user_id: string
  session_id: string | null
  status?: 'running' | 'success' | 'failed' | 'skipped'
  error?: string | null
}): Promise<ScheduledTaskRun> {
  const rows = await sql<ScheduledTaskRun[]>`
    INSERT INTO scheduled_task_runs (task_id, user_id, session_id, status, error,
      completed_at)
    VALUES (${input.task_id}, ${input.user_id}, ${input.session_id},
            ${input.status ?? 'running'}, ${input.error ?? null},
            ${input.status && input.status !== 'running' ? sql`now()` : null})
    RETURNING *
  `
  return rows[0]
}

export async function finalizeRun(
  runId: string,
  status: 'success' | 'failed' | 'skipped',
  error?: string | null,
): Promise<ScheduledTaskRun | null> {
  const rows = await sql<ScheduledTaskRun[]>`
    UPDATE scheduled_task_runs
    SET status = ${status}, error = ${error ?? null}, completed_at = now()
    WHERE id = ${runId} AND status = 'running'
    RETURNING *
  `
  return rows[0] ?? null
}

export async function listRunsForTask(
  taskId: string,
  userId: string,
  limit = 50,
): Promise<ScheduledTaskRun[]> {
  return sql<ScheduledTaskRun[]>`
    SELECT * FROM scheduled_task_runs
    WHERE task_id = ${taskId} AND user_id = ${userId}
    ORDER BY started_at DESC LIMIT ${limit}
  `
}

export async function markOrphanedRunsInterrupted() {
  await sql`
    UPDATE scheduled_task_runs SET status = 'failed', error = 'hub_restart', completed_at = now()
    WHERE status = 'running'
  `
}

function normalize(row: any): ScheduledTask {
  return {
    ...row,
    on_complete:
      typeof row.on_complete === 'string' ? JSON.parse(row.on_complete) : row.on_complete,
  }
}
