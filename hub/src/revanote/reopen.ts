// hub/src/revanote/reopen.ts
// Reset an annotation to 'pending' so it can be dispatched again, but only when
// no live turn owns it. Shared by the manual retry route and the inbound webhook.
//
// Incident (2026-10): Revanote re-sends a comment when it gets no callback within
// its 180-minute reclaim window. The webhook upsert kept the hub row's old status
// ('dispatched' from a turn that died, or 'failed'), the send-time claim only takes
// 'pending', so the re-send dispatched nothing and sent no callback, yet the hub
// answered 202. Revanote waited another 180 minutes and repeated until its 5-attempt
// cap made the comment terminal. Twenty-two client comments sat in that loop.

import type { AnnotationRow } from '../db/revanote-dal.ts'

export type ReopenResult =
  | { reopened: true; from: string }
  | {
      reopened: false
      reason: 'archived' | 'resolved' | 'in_flight' | 'cas_lost'
      detail: string
    }

/**
 * Reset `ann` to 'pending' when it is safe to send it again.
 *
 * A 'dispatched' row is ambiguous between "its turn is still live" and "stranded:
 * the process that owned it died before finalizing". It is reset only when no live
 * single/batch owner holds it in memory AND its latest durable run is terminal or
 * past its ceiling (the in-memory maps are empty after a hub restart while the
 * supervisor may still be working the prompt). 'resolved' is reopened only when
 * `allowResolved` (an explicit human retry); a machine re-send never reopens it.
 * The reset is a CAS on the observed status, so a concurrent claim wins.
 */
export async function reopenAnnotationForRedispatch(
  ann: AnnotationRow,
  userId: string,
  skipReason: string,
  opts: { allowResolved: boolean },
): Promise<ReopenResult> {
  if (ann.status === 'archived') {
    return {
      reopened: false,
      reason: 'archived',
      detail: 'The source annotation was retired; this historical record cannot be retried.',
    }
  }
  if (ann.status === 'resolved' && !opts.allowResolved) {
    return { reopened: false, reason: 'resolved', detail: 'annotation already resolved' }
  }

  if (ann.status === 'dispatched') {
    const { isTokenLiveAnywhere, hookMaxMsFromEnv } = await import('../dispatch/pipeline.ts')
    const { isAnnotationLiveInBatch, batchRunMaxMs } = await import('./batch-dispatch.ts')
    // session_id is NULL between the single-path claim and the post-dispatch
    // status update, so liveness is keyed on the token alone.
    if (isTokenLiveAnywhere(ann.id) || isAnnotationLiveInBatch(ann.id)) {
      return { reopened: false, reason: 'in_flight', detail: 'a dispatch for this annotation is still live' }
    }
    // Durable liveness. The ceiling is the real hook lifetime: a single run's
    // finalize hook lives until REMO_DISPATCH_HOOK_MAX_MS, a batch run's until
    // REMO_REVANOTE_BATCH_RUN_MAX_MS.
    const { listAnnotationRuns } = await import('../db/revanote-dal.ts')
    const latest = (await listAnnotationRuns(ann.id, userId))[0]
    if (latest && latest.status === 'in_flight') {
      const batchId = (ann.payload_raw as any)?.batch_id
      const ceiling = typeof batchId === 'string' && batchId !== '' ? batchRunMaxMs() : hookMaxMsFromEnv()
      if (Date.now() - new Date(latest.started_at as any).getTime() < ceiling) {
        return {
          reopened: false,
          reason: 'in_flight',
          detail: 'an in-flight run for this annotation is within its ceiling',
        }
      }
    }
  }

  const { resetAnnotationToPendingIfStatus, cancelInFlightRunsForAnnotation } = await import(
    '../db/revanote-dal.ts'
  )
  if (!(await resetAnnotationToPendingIfStatus(ann.id, ann.status, skipReason))) {
    return {
      reopened: false,
      reason: 'cas_lost',
      detail: 'annotation status changed concurrently; retry refused',
    }
  }
  // The reset superseded the previous dispatch: close its still-open run so it is
  // never mistaken for a live owner (its late finalize also loses the generation
  // CAS on the annotation row).
  if (ann.status === 'dispatched') await cancelInFlightRunsForAnnotation(ann.id, 'superseded_by_retry')
  return { reopened: true, from: ann.status }
}
