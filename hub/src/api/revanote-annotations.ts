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
  archived: 'archived',
}

revanoteAnnotations.get('/', async (c) => {
  const userId = c.get('userId') as string
  const statusQuery = (c.req.query('status') ?? '').toLowerCase()
  // R2-4: an unrecognized non-empty ?status= used to silently fall through to
  // `null` (unfiltered list) — indistinguishable from "no filter requested".
  // Only an EMPTY query means "no filter"; anything else must be one of the
  // valid statuses or a 400.
  if (statusQuery && !(statusQuery in VALID_STATUS)) {
    return c.json({ error: 'invalid_status', valid: Object.keys(VALID_STATUS) }, 400)
  }
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
  // R2-2: reset-to-pending only when the pipeline does NOT currently own the row
  // (shared with the webhook re-delivery path; see revanote/reopen.ts).
  const { reopenAnnotationForRedispatch } = await import('../revanote/reopen.ts')
  const reopen = await reopenAnnotationForRedispatch(ann, userId, 'manual_retry', { allowResolved: true })
  if (!reopen.reopened) {
    const error = reopen.reason === 'archived' ? 'annotation_archived' : 'annotation_in_flight'
    return c.json({ error, detail: reopen.detail }, 409)
  }
  const { dispatchPendingAnnotation } = await import('../revanote/dispatcher.ts')
  // forceSingle: a human explicitly retrying ONE comment dispatches it right
  // away, even when it carries a batch_id — it never waits on the batch
  // debounce window (see hub/src/revanote/batch-dispatch.ts).
  const result = await dispatchPendingAnnotation(id, { forceSingle: true })
  return c.json({ result })
})
