/**
 * REST router for scheduled task runs (W3/T14).
 *
 * Read-side history + cancel. All queries are user-scoped via the V2 DAL.
 * Live progress for in-flight runs streams over `/ws/client` — this router
 * is the snapshot fallback.
 */
import { Hono } from 'hono'
import { z } from 'zod'
import {
  getRun,
  listRunsForTaskV2,
  getTask,
} from '../db/scheduled-tasks-dal.ts'
import * as dispatcher from '../scheduler/dispatcher.ts'

export const scheduledTaskRuns = new Hono()

const ListQuery = z.object({
  task_id: z.string().min(1),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  before: z.string().datetime().optional(),
})

// GET /api/scheduled-task-runs?task_id=...&limit=&before=
scheduledTaskRuns.get('/', async (c) => {
  const userId = c.get('userId') as string
  const parsed = ListQuery.safeParse({
    task_id: c.req.query('task_id'),
    limit: c.req.query('limit'),
    before: c.req.query('before'),
  })
  if (!parsed.success) {
    return c.json({ error: 'invalid_query', issues: parsed.error.issues }, 400)
  }
  // Confirm the task belongs to this user before exposing its runs.
  const task = await getTask(parsed.data.task_id, userId)
  if (!task) return c.json({ error: 'not_found' }, 404)

  const runs = await listRunsForTaskV2(parsed.data.task_id, userId, {
    limit: parsed.data.limit,
    before: parsed.data.before ? new Date(parsed.data.before) : undefined,
  })
  return c.json({ runs })
})

// GET /api/scheduled-task-runs/:run_id
scheduledTaskRuns.get('/:run_id', async (c) => {
  const userId = c.get('userId') as string
  const run = await getRun(c.req.param('run_id'), userId)
  if (!run) return c.json({ error: 'not_found' }, 404)
  return c.json(run)
})

// POST /api/scheduled-task-runs/:run_id/cancel
scheduledTaskRuns.post('/:run_id/cancel', async (c) => {
  const userId = c.get('userId') as string
  const runId = c.req.param('run_id')
  // Verify ownership before issuing cancel (dispatcher.cancelRun also
  // checks, but we want to return 404 for someone else's run).
  const run = await getRun(runId, userId)
  if (!run) return c.json({ error: 'not_found' }, 404)
  const ok = await dispatcher.cancelRun(runId, userId)
  if (!ok) return c.json({ error: 'cancel_failed' }, 409)
  const after = await getRun(runId, userId)
  return c.json({ ok: true, run: after }, 202)
})
