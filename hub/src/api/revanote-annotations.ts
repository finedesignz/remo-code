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

  // R2-2: a reset-to-pending + forceSingle re-dispatch must only ever run
  // against a row the pipeline does NOT currently own. 'pending' / 'failed' /
  // 'failed_offline' / 'resolved' are always safe — the pipeline always
  // releases ownership (markFailed/markSkipped/finalize) before setting any of
  // those. A 'dispatched' row is different: it's ambiguous between "the first
  // turn is still genuinely live" and "stranded — the process that owned it
  // died/restarted before finalizing". Only the second is safe to reset; the
  // first must be refused, not silently re-pended into a second, concurrent
  // send for the same annotation while the live turn is still running.
  if (ann.status === 'dispatched') {
    const { isTokenLiveAnywhere } = await import('../dispatch/pipeline.ts')
    const { isAnnotationLiveInBatch } = await import('../revanote/batch-dispatch.ts')
    // session_id is NULL between the single-path claim and the post-dispatch
    // status update, so liveness is keyed on the token alone.
    const singleLive = isTokenLiveAnywhere(ann.id)
    const batchLive = isAnnotationLiveInBatch(ann.id)
    if (singleLive || batchLive) {
      return c.json(
        { error: 'annotation_in_flight', detail: 'a dispatch for this annotation is still live' },
        409,
      )
    }
  }

  // Reset to pending so the dispatcher will accept the row.
  // CAS on the status we observed: if a concurrent claim/finalize moved the
  // row since, the reset is refused (409) rather than forcing a second send.
  const { resetAnnotationToPendingIfStatus } = await import('../db/revanote-dal.ts')
  const reset = await resetAnnotationToPendingIfStatus(id, ann.status, 'manual_retry')
  if (!reset) {
    return c.json(
      { error: 'annotation_in_flight', detail: 'annotation status changed concurrently; retry refused' },
      409,
    )
  }
  const { dispatchPendingAnnotation } = await import('../revanote/dispatcher.ts')
  // forceSingle: a human explicitly retrying ONE comment dispatches it right
  // away, even when it carries a batch_id — it never waits on the batch
  // debounce window (see hub/src/revanote/batch-dispatch.ts).
  const result = await dispatchPendingAnnotation(id, { forceSingle: true })
  return c.json({ result })
})
