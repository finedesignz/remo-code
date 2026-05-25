/**
 * REST router for error-capture projects (Phase 06 / Wave 4).
 *
 * User-scoped CRUD. The `sentry_key` returned by the DAL is the public
 * credential a client SDK uses in the Sentry-style envelope; we compute a
 * convenient DSN string for the UI's "copy" affordance.
 *
 * Auth: JWT (mounted under the `/api/*` catch-all in `hub/src/index.ts`).
 */
import { Hono } from 'hono'
import { z } from 'zod'
import {
  type ErrorProject,
  createErrorProject,
  listErrorProjectsForUser,
  getErrorProject,
  updateErrorProject,
  deleteErrorProject,
} from '../db/error-capture-dal.ts'
import { getSession } from '../db/dal.ts'

export const errorProjectsRouter = new Hono()

const CreateSchema = z.object({
  name: z.string().min(1).max(200).trim(),
  session_id: z.string().min(1),
  dedupe_window_seconds: z.number().int().min(0).max(86400).optional(),
  rate_limit_per_hour: z.number().int().min(0).max(10000).optional(),
  daily_dispatch_cap: z.number().int().min(0).max(10000).optional(),
  enabled: z.boolean().optional(),
})

const PatchSchema = CreateSchema.partial()

/** Build a DSN like `https://<key>@<host>/<project_id>`. */
function buildDsn(sentryKey: string, projectId: string): string {
  const raw = process.env.REMO_PUBLIC_URL || 'https://app.remo-code.com'
  const host = raw.replace(/^https?:\/\//, '').replace(/\/+$/, '')
  return `https://${sentryKey}@${host}/${projectId}`
}

function withDsn<T extends ErrorProject>(p: T) {
  return { ...p, dsn: buildDsn(p.sentry_key, p.id) }
}

// ── Routes ────────────────────────────────────────────────────────────────────

errorProjectsRouter.get('/', async (c) => {
  const userId = c.get('userId') as string
  const rows = await listErrorProjectsForUser(userId)
  return c.json({ projects: rows.map(withDsn) })
})

errorProjectsRouter.get('/:id', async (c) => {
  const userId = c.get('userId') as string
  const p = await getErrorProject(c.req.param('id'), userId)
  if (!p) return c.json({ error: 'not_found' }, 404)
  return c.json(withDsn(p))
})

errorProjectsRouter.post('/', async (c) => {
  const userId = c.get('userId') as string
  const body = await c.req.json().catch(() => null)
  const parsed = CreateSchema.safeParse(body)
  if (!parsed.success) {
    return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400)
  }
  const data = parsed.data

  // Verify session belongs to this user.
  const session = await getSession(data.session_id, userId)
  if (!session) return c.json({ error: 'session_not_found' }, 400)

  const project = await createErrorProject(userId, {
    name: data.name,
    session_id: data.session_id,
    dedupe_window_seconds: data.dedupe_window_seconds,
    rate_limit_per_hour: data.rate_limit_per_hour,
    daily_dispatch_cap: data.daily_dispatch_cap,
    enabled: data.enabled,
  })
  return c.json(withDsn(project), 201)
})

errorProjectsRouter.patch('/:id', async (c) => {
  const userId = c.get('userId') as string
  const id = c.req.param('id')
  const existing = await getErrorProject(id, userId)
  if (!existing) return c.json({ error: 'not_found' }, 404)

  const body = await c.req.json().catch(() => null)
  const parsed = PatchSchema.safeParse(body)
  if (!parsed.success) {
    return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400)
  }
  const data = parsed.data

  if (data.session_id !== undefined && data.session_id !== existing.session_id) {
    const session = await getSession(data.session_id, userId)
    if (!session) return c.json({ error: 'session_not_found' }, 400)
  }

  const updated = await updateErrorProject(id, userId, data)
  if (!updated) return c.json({ error: 'not_found' }, 404)
  return c.json(withDsn(updated))
})

errorProjectsRouter.delete('/:id', async (c) => {
  const userId = c.get('userId') as string
  const id = c.req.param('id')
  const ok = await deleteErrorProject(id, userId)
  if (!ok) return c.json({ error: 'not_found' }, 404)
  return c.json({ ok: true })
})
