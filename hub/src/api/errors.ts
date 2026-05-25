/**
 * REST router for captured errors (Phase 06 / Wave 4 — read side).
 *
 * Paged list scoped by project ownership + single-error fetch. Writes
 * happen via the public Sentry-style intake (W3); this is the UI read
 * path that the ErrorDetailDrawer consumes.
 */
import { Hono } from 'hono'
import { z } from 'zod'
import { sql } from '../db/postgres.ts'
import {
  type ErrorRow,
  listErrorsForProject,
  getErrorProject,
} from '../db/error-capture-dal.ts'

export const errorsRouter = new Hono()

const ListQuery = z.object({
  project_id: z.string().min(1),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  before: z.string().datetime().optional(),
})

errorsRouter.get('/', async (c) => {
  const userId = c.get('userId') as string
  const parsed = ListQuery.safeParse({
    project_id: c.req.query('project_id'),
    limit: c.req.query('limit'),
    before: c.req.query('before'),
  })
  if (!parsed.success) {
    return c.json({ error: 'invalid_query', issues: parsed.error.issues }, 400)
  }
  const project = await getErrorProject(parsed.data.project_id, userId)
  if (!project) return c.json({ error: 'not_found' }, 404)

  const errors = await listErrorsForProject(parsed.data.project_id, userId, {
    limit: parsed.data.limit,
    before: parsed.data.before ? new Date(parsed.data.before) : undefined,
  })
  return c.json({ errors })
})

errorsRouter.get('/:id', async (c) => {
  const userId = c.get('userId') as string
  // No dedicated DAL helper for single-error-by-user; inline the join.
  const rows = await sql<ErrorRow[]>`
    SELECT e.* FROM errors e
    JOIN error_projects p ON p.id = e.project_id
    WHERE e.id = ${c.req.param('id')} AND p.user_id = ${userId}
    LIMIT 1
  `
  if (rows.length === 0) return c.json({ error: 'not_found' }, 404)
  return c.json(rows[0])
})
