/**
 * REST router for error-runs (Phase 06 / Wave 4).
 *
 * Mirrors `scheduled-task-runs.ts` shape but for the error-capture dispatch
 * runs. All queries pivot through the project's user_id to enforce scope.
 */
import { Hono } from 'hono'
import { z } from 'zod'
import { sql } from '../db/postgres.ts'
import {
  type ErrorRun,
  getErrorRun,
} from '../db/error-capture-dal.ts'

export const errorRunsRouter = new Hono()

const ListQuery = z.object({
  error_id: z.string().min(1),
  limit: z.coerce.number().int().min(1).max(200).optional(),
})

errorRunsRouter.get('/', async (c) => {
  const userId = c.get('userId') as string
  const parsed = ListQuery.safeParse({
    error_id: c.req.query('error_id'),
    limit: c.req.query('limit'),
  })
  if (!parsed.success) {
    return c.json({ error: 'invalid_query', issues: parsed.error.issues }, 400)
  }
  const limit = parsed.data.limit ?? 50
  const runs = await sql<ErrorRun[]>`
    SELECT r.* FROM error_runs r
    JOIN error_projects p ON p.id = r.project_id
    WHERE r.error_id = ${parsed.data.error_id} AND p.user_id = ${userId}
    ORDER BY r.created_at DESC LIMIT ${limit}
  `
  return c.json({ runs })
})

errorRunsRouter.get('/:id', async (c) => {
  const userId = c.get('userId') as string
  const run = await getErrorRun(c.req.param('id'), userId)
  if (!run) return c.json({ error: 'not_found' }, 404)
  return c.json(run)
})
