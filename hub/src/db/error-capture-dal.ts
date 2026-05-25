/**
 * Error-capture DAL (06-error-capture).
 *
 * Backs the Sentry-style intake at /api/sentry/:project_id/envelope/. All
 * queries are user-scoped where applicable. Mirrors the V2 conventions used
 * by `scheduled-tasks-dal.ts`: `sql` template tag from `./postgres.ts`,
 * explicit return shapes, partial-update helpers built from a `sets[]` list.
 */
import { randomBytes } from 'node:crypto'
import { sql } from './postgres.ts'

// ── Types ────────────────────────────────────────────────────────────────────

export type DispatchStatus =
  | 'pending'
  | 'dispatched'
  | 'skipped'
  | 'failed'
  | 'deduped'
  | 'rate_limited'
  | 'cap_exceeded'

export type ErrorRunStatus =
  | 'pending'
  | 'in_flight'
  | 'success'
  | 'failed'
  | 'skipped'
  | 'cancelled'

export interface ErrorProject {
  id: string
  user_id: string
  name: string
  sentry_key: string
  session_id: string
  dedupe_window_seconds: number
  rate_limit_per_hour: number
  daily_dispatch_cap: number
  enabled: boolean
  created_at: string
  updated_at: string
}

export interface ErrorRow {
  id: string
  project_id: string
  fingerprint: string
  error_type: string
  error_value: string
  stacktrace_json: any
  release: string | null
  received_at: string
  dispatch_status: DispatchStatus
  dispatched_at: string | null
  skip_reason: string | null
}

export interface ErrorRun {
  id: string
  error_id: string
  project_id: string
  session_id: string
  status: ErrorRunStatus
  started_at: string | null
  finished_at: string | null
  output_snippet: string | null
  error: string | null
  created_at: string
}

// ── error_projects ───────────────────────────────────────────────────────────

function newSentryKey(): string {
  return randomBytes(16).toString('hex')
}

export async function createErrorProject(
  userId: string,
  fields: {
    name: string
    session_id: string
    dedupe_window_seconds?: number
    rate_limit_per_hour?: number
    daily_dispatch_cap?: number
    enabled?: boolean
  },
): Promise<ErrorProject> {
  const rows = await sql<ErrorProject[]>`
    INSERT INTO error_projects (
      user_id, name, sentry_key, session_id,
      dedupe_window_seconds, rate_limit_per_hour, daily_dispatch_cap, enabled
    ) VALUES (
      ${userId}, ${fields.name}, ${newSentryKey()}, ${fields.session_id},
      ${fields.dedupe_window_seconds ?? 60},
      ${fields.rate_limit_per_hour ?? 20},
      ${fields.daily_dispatch_cap ?? 50},
      ${fields.enabled ?? true}
    )
    RETURNING *
  `
  return rows[0]
}

export async function listErrorProjectsForUser(userId: string): Promise<ErrorProject[]> {
  return sql<ErrorProject[]>`
    SELECT * FROM error_projects WHERE user_id = ${userId} ORDER BY created_at DESC
  `
}

export async function getErrorProject(id: string, userId: string): Promise<ErrorProject | null> {
  const rows = await sql<ErrorProject[]>`
    SELECT * FROM error_projects WHERE id = ${id} AND user_id = ${userId} LIMIT 1
  `
  return rows[0] ?? null
}

/**
 * Used by the public intake to authenticate the request: caller passes the
 * sentry_key out of the X-Sentry-Auth header, we resolve the owning project.
 * NOT user-scoped — the sentry_key IS the credential.
 */
export async function getErrorProjectBySentryKey(sentryKey: string): Promise<ErrorProject | null> {
  const rows = await sql<ErrorProject[]>`
    SELECT * FROM error_projects WHERE sentry_key = ${sentryKey} LIMIT 1
  `
  return rows[0] ?? null
}

export async function updateErrorProject(
  id: string,
  userId: string,
  fields: Partial<{
    name: string
    session_id: string
    dedupe_window_seconds: number
    rate_limit_per_hour: number
    daily_dispatch_cap: number
    enabled: boolean
  }>,
): Promise<ErrorProject | null> {
  const sets: any[] = []
  if (fields.name !== undefined) sets.push(sql`name = ${fields.name}`)
  if (fields.session_id !== undefined) sets.push(sql`session_id = ${fields.session_id}`)
  if (fields.dedupe_window_seconds !== undefined)
    sets.push(sql`dedupe_window_seconds = ${fields.dedupe_window_seconds}`)
  if (fields.rate_limit_per_hour !== undefined)
    sets.push(sql`rate_limit_per_hour = ${fields.rate_limit_per_hour}`)
  if (fields.daily_dispatch_cap !== undefined)
    sets.push(sql`daily_dispatch_cap = ${fields.daily_dispatch_cap}`)
  if (fields.enabled !== undefined) sets.push(sql`enabled = ${fields.enabled}`)
  if (sets.length === 0) return getErrorProject(id, userId)
  sets.push(sql`updated_at = now()`)

  let q = sql`UPDATE error_projects SET `
  for (let i = 0; i < sets.length; i++) {
    q = i === 0 ? sql`${q}${sets[i]}` : sql`${q}, ${sets[i]}`
  }
  const rows = await sql<ErrorProject[]>`${q} WHERE id = ${id} AND user_id = ${userId} RETURNING *`
  return rows[0] ?? null
}

export async function deleteErrorProject(id: string, userId: string): Promise<boolean> {
  const rows = await sql`
    DELETE FROM error_projects WHERE id = ${id} AND user_id = ${userId} RETURNING id
  `
  return rows.length > 0
}

// ── errors ───────────────────────────────────────────────────────────────────

export async function insertError(
  projectId: string,
  fields: {
    fingerprint: string
    error_type: string
    error_value: string
    stacktrace_json?: any
    release?: string | null
    dispatch_status?: DispatchStatus
    skip_reason?: string | null
  },
): Promise<ErrorRow> {
  const rows = await sql<ErrorRow[]>`
    INSERT INTO errors (
      project_id, fingerprint, error_type, error_value,
      stacktrace_json, release, dispatch_status, skip_reason
    ) VALUES (
      ${projectId}, ${fields.fingerprint}, ${fields.error_type}, ${fields.error_value},
      ${sql.json((fields.stacktrace_json ?? []) as any)}, ${fields.release ?? null},
      ${fields.dispatch_status ?? 'pending'}, ${fields.skip_reason ?? null}
    )
    RETURNING *
  `
  return rows[0]
}

/**
 * Returns the most recent error for (project, fingerprint) within the dedupe
 * window. Used by the intake gate: if non-null, the new error is a duplicate
 * and should be marked `deduped` instead of dispatched.
 */
export async function findRecentErrorByFingerprint(
  projectId: string,
  fingerprint: string,
  windowSeconds: number,
): Promise<ErrorRow | null> {
  const rows = await sql<ErrorRow[]>`
    SELECT * FROM errors
    WHERE project_id = ${projectId}
      AND fingerprint = ${fingerprint}
      AND received_at > now() - (${windowSeconds} || ' seconds')::interval
    ORDER BY received_at DESC LIMIT 1
  `
  return rows[0] ?? null
}

export async function countErrorsInLastHour(projectId: string): Promise<number> {
  const rows = await sql<{ count: number }[]>`
    SELECT COUNT(*)::int AS count FROM errors
    WHERE project_id = ${projectId}
      AND received_at > now() - interval '1 hour'
  `
  return rows[0]?.count ?? 0
}

/**
 * Count rows that actually consumed dispatch budget today (status='dispatched')
 * in the user's local timezone. Mirrors the scheduler's day-window pattern.
 */
export async function countDispatchesToday(projectId: string, tz: string): Promise<number> {
  const zone = tz || 'UTC'
  const rows = await sql<{ count: number }[]>`
    SELECT COUNT(*)::int AS count FROM errors
    WHERE project_id = ${projectId}
      AND dispatch_status = 'dispatched'
      AND dispatched_at >= date_trunc('day', now() AT TIME ZONE ${zone}) AT TIME ZONE ${zone}
  `
  return rows[0]?.count ?? 0
}

export async function updateErrorDispatchStatus(
  errorId: string,
  status: DispatchStatus,
  skipReason?: string,
): Promise<void> {
  const dispatchedAt = status === 'dispatched' ? sql`now()` : null
  await sql`
    UPDATE errors
    SET dispatch_status = ${status},
        dispatched_at = COALESCE(${dispatchedAt}, dispatched_at),
        skip_reason = ${skipReason ?? null}
    WHERE id = ${errorId}
  `
}

export async function listErrorsForProject(
  projectId: string,
  userId: string,
  opts: { limit?: number; before?: Date } = {},
): Promise<ErrorRow[]> {
  const limit = opts.limit ?? 50
  if (opts.before) {
    return sql<ErrorRow[]>`
      SELECT e.* FROM errors e
      JOIN error_projects p ON p.id = e.project_id
      WHERE e.project_id = ${projectId} AND p.user_id = ${userId}
        AND e.received_at < ${opts.before}
      ORDER BY e.received_at DESC LIMIT ${limit}
    `
  }
  return sql<ErrorRow[]>`
    SELECT e.* FROM errors e
    JOIN error_projects p ON p.id = e.project_id
    WHERE e.project_id = ${projectId} AND p.user_id = ${userId}
    ORDER BY e.received_at DESC LIMIT ${limit}
  `
}

// ── error_runs ───────────────────────────────────────────────────────────────

export async function insertErrorRun(
  errorId: string,
  projectId: string,
  sessionId: string,
): Promise<ErrorRun> {
  const rows = await sql<ErrorRun[]>`
    INSERT INTO error_runs (error_id, project_id, session_id, status)
    VALUES (${errorId}, ${projectId}, ${sessionId}, 'pending')
    RETURNING *
  `
  return rows[0]
}

export async function updateErrorRunStatus(
  runId: string,
  fields: Partial<{
    status: ErrorRunStatus
    started_at: Date | null
    finished_at: Date | null
    output_snippet: string | null
    error: string | null
  }>,
): Promise<ErrorRun | null> {
  const sets: any[] = []
  if (fields.status !== undefined) sets.push(sql`status = ${fields.status}`)
  if (fields.started_at !== undefined) sets.push(sql`started_at = ${fields.started_at}`)
  if (fields.finished_at !== undefined) sets.push(sql`finished_at = ${fields.finished_at}`)
  if (fields.output_snippet !== undefined) sets.push(sql`output_snippet = ${fields.output_snippet}`)
  if (fields.error !== undefined) sets.push(sql`error = ${fields.error}`)
  if (sets.length === 0) return null

  let q = sql`UPDATE error_runs SET `
  for (let i = 0; i < sets.length; i++) {
    q = i === 0 ? sql`${q}${sets[i]}` : sql`${q}, ${sets[i]}`
  }
  const rows = await sql<ErrorRun[]>`${q} WHERE id = ${runId} RETURNING *`
  return rows[0] ?? null
}

export async function getErrorRun(runId: string, userId: string): Promise<ErrorRun | null> {
  const rows = await sql<ErrorRun[]>`
    SELECT r.* FROM error_runs r
    JOIN error_projects p ON p.id = r.project_id
    WHERE r.id = ${runId} AND p.user_id = ${userId} LIMIT 1
  `
  return rows[0] ?? null
}
