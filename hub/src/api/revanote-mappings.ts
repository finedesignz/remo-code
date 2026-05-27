/**
 * Revanote app-mapping CRUD (Phase 08).
 *
 * Routes (all JWT + license + CSRF gated via the global /api/* catch-all):
 *   GET    /api/revanote/mappings
 *   POST   /api/revanote/mappings          { hostname_pattern, repo_path, ... }
 *   PATCH  /api/revanote/mappings/:id      { ...partial }
 *   DELETE /api/revanote/mappings/:id
 *   GET    /api/revanote/mappings/resolve?host=example.com   (debug: best-match for a host)
 */
import { Hono } from 'hono'
import { z } from 'zod'
import { authMiddleware } from '../auth/middleware.ts'
import {
  listRevanoteMappings,
  createRevanoteMapping,
  updateRevanoteMapping,
  deleteRevanoteMapping,
  resolveRevanoteMappingForHost,
} from '../db/revanote-dal.ts'

export const revanoteMappings = new Hono()

revanoteMappings.use('/*', authMiddleware)

const CreateSchema = z.object({
  hostname_pattern: z.string().min(1).max(256),
  repo_path: z.string().min(1).max(1024),
  supervisor_id: z.string().min(1).max(64).optional().nullable(),
  deploy_strategy: z.enum(['pr', 'direct', 'none']).optional(),
  auto_merge: z.boolean().optional(),
  enabled: z.boolean().optional(),
}).strict()

const UpdateSchema = CreateSchema.partial()

revanoteMappings.get('/', async (c) => {
  const userId = c.get('userId') as string
  const rows = await listRevanoteMappings(userId)
  return c.json({ mappings: rows })
})

revanoteMappings.post('/', async (c) => {
  const userId = c.get('userId') as string
  let body: any
  try { body = await c.req.json() } catch { return c.json({ error: 'bad_json' }, 400) }
  const parsed = CreateSchema.safeParse(body)
  if (!parsed.success) return c.json({ error: 'invalid_body', detail: parsed.error.flatten() }, 400)
  try {
    const row = await createRevanoteMapping({ user_id: userId, ...parsed.data })
    return c.json({ mapping: row }, 201)
  } catch (err: any) {
    return c.json({ error: 'create_failed', detail: err?.message }, 500)
  }
})

revanoteMappings.patch('/:id', async (c) => {
  const userId = c.get('userId') as string
  const id = c.req.param('id')
  let body: any
  try { body = await c.req.json() } catch { return c.json({ error: 'bad_json' }, 400) }
  const parsed = UpdateSchema.safeParse(body)
  if (!parsed.success) return c.json({ error: 'invalid_body', detail: parsed.error.flatten() }, 400)
  const row = await updateRevanoteMapping(id, userId, parsed.data)
  if (!row) return c.json({ error: 'not_found' }, 404)
  return c.json({ mapping: row })
})

revanoteMappings.delete('/:id', async (c) => {
  const userId = c.get('userId') as string
  const id = c.req.param('id')
  const ok = await deleteRevanoteMapping(id, userId)
  if (!ok) return c.json({ error: 'not_found' }, 404)
  return c.json({ ok: true })
})

revanoteMappings.get('/resolve', async (c) => {
  const userId = c.get('userId') as string
  const host = (c.req.query('host') ?? '').trim()
  if (!host) return c.json({ error: 'missing_host' }, 400)
  const row = await resolveRevanoteMappingForHost(userId, host)
  return c.json({ host, mapping: row })
})
