/**
 * Revanote annotations REST (Phase 08).
 *
 * Routes (JWT + license + CSRF gated):
 *   GET  /api/revanote/annotations?status=&limit=
 *   GET  /api/revanote/annotations/:id
 *   POST /api/revanote/annotations/:id/retry   (force re-dispatch)
 */
import { Hono } from 'hono'
import { authMiddleware } from '../auth/middleware.ts'
import {
  listAnnotations,
  getAnnotationById,
  listAnnotationRuns,
  type AnnotationStatus,
} from '../db/revanote-dal.ts'

export const revanoteAnnotations = new Hono()

revanoteAnnotations.use('/*', authMiddleware)

const VALID_STATUS: Record<string, AnnotationStatus> = {
  pending: 'pending', dispatched: 'dispatched', resolved: 'resolved',
  failed: 'failed', failed_offline: 'failed_offline',
}

revanoteAnnotations.get('/', async (c) => {
  const userId = c.get('userId') as string
  const statusQuery = (c.req.query('status') ?? '').toLowerCase()
  const status: AnnotationStatus | null = VALID_STATUS[statusQuery] ?? null
  const limit = Math.min(200, Math.max(1, Number(c.req.query('limit')) || 50))
  const rows = await listAnnotations(userId, { status, limit })
  return c.json({ annotations: rows })
})

revanoteAnnotations.get('/:id', async (c) => {
  const userId = c.get('userId') as string
  const id = c.req.param('id')
  const ann = await getAnnotationById(id, userId)
  if (!ann) return c.json({ error: 'not_found' }, 404)
  const runs = await listAnnotationRuns(id, userId)
  return c.json({ annotation: ann, runs })
})

revanoteAnnotations.post('/:id/retry', async (c) => {
  const userId = c.get('userId') as string
  const id = c.req.param('id')
  const ann = await getAnnotationById(id, userId)
  if (!ann) return c.json({ error: 'not_found' }, 404)
  // Reset to pending so the dispatcher will accept the row.
  const { updateAnnotationStatus } = await import('../db/revanote-dal.ts')
  await updateAnnotationStatus(id, 'pending', { skip_reason: 'manual_retry' })
  const { dispatchPendingAnnotation } = await import('../revanote/dispatcher.ts')
  const result = await dispatchPendingAnnotation(id)
  return c.json({ result })
})
