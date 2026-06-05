/**
 * Phase 12 W2 — Tasks tab endpoints.
 *
 *   GET /api/tasks/upcoming  ?limit=&offset=  → next-N enabled tasks ordered by next_fire_at ASC.
 *   GET /api/tasks/activity  ?status=&before=&limit=  → user-wide run feed, started_at DESC.
 *   GET /api/tasks/schedule  ?group_by=repo  → grouped by repo (session.project_dir),
 *                                              with an "unassigned" bucket for fan-out targets.
 *
 * All three are GET-only, license-gated by the global gate, and authed by the
 * global JWT/cookie middleware. No CSRF needed (GET is not in MUTATING_METHODS).
 */
import { Hono } from 'hono'
import { z } from 'zod'
import {
  listUpcomingTasks,
  listUserActivityRuns,
  listTasksGroupedByRepo,
} from '../db/dal'
import { TASK_TEMPLATES } from '../scheduler/task-templates.ts'

export const tasks = new Hono()

// Static, read-only GSD template catalog. User-scoped only for auth (the
// catalog itself is a fixed, code-defined list — see task-templates.ts).
tasks.get('/templates', (c) => {
  return c.json({ templates: TASK_TEMPLATES })
})

const UpcomingQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
})

tasks.get('/upcoming', async (c) => {
  const userId = c.get('userId') as string
  const parsed = UpcomingQuery.safeParse({
    limit: c.req.query('limit'),
    offset: c.req.query('offset'),
  })
  if (!parsed.success) return c.json({ error: 'invalid_query', issues: parsed.error.issues }, 400)
  const rows = await listUpcomingTasks({
    userId,
    limit: parsed.data.limit,
    offset: parsed.data.offset,
  })
  return c.json({ tasks: rows })
})

const ACTIVITY_STATUS = ['in_progress', 'completed', 'failed'] as const
const ActivityQuery = z.object({
  status: z.enum(ACTIVITY_STATUS).optional(),
  before: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
})

tasks.get('/activity', async (c) => {
  const userId = c.get('userId') as string
  const parsed = ActivityQuery.safeParse({
    status: c.req.query('status'),
    before: c.req.query('before'),
    limit: c.req.query('limit'),
    offset: c.req.query('offset'),
  })
  if (!parsed.success) return c.json({ error: 'invalid_query', issues: parsed.error.issues }, 400)
  // Note: we accept `offset` for forward-compat with classic paging UIs, but
  // prefer the keyset (`before`) param. If both are supplied, before wins.
  const runs = await listUserActivityRuns({
    userId,
    status: parsed.data.status,
    before: parsed.data.before ? new Date(parsed.data.before) : undefined,
    limit: parsed.data.limit,
  })
  const next_cursor =
    Array.isArray(runs) && runs.length > 0
      ? (runs[runs.length - 1] as any)?.started_at ?? null
      : null
  return c.json({ runs, next_cursor })
})

const ScheduleQuery = z.object({
  group_by: z.enum(['repo']).optional(),
})

tasks.get('/schedule', async (c) => {
  const userId = c.get('userId') as string
  const parsed = ScheduleQuery.safeParse({ group_by: c.req.query('group_by') })
  if (!parsed.success) return c.json({ error: 'invalid_query', issues: parsed.error.issues }, 400)
  // For now the only grouping mode is `repo` (per spec). Default to it.
  const groups = await listTasksGroupedByRepo(userId)
  return c.json({ groups, group_by: 'repo' })
})
