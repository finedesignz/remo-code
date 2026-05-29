/**
 * recordError — Wave 2 gating module for the Sentry-style intake.
 *
 * Called by `hub/src/api/sentry-intake.ts` after the envelope has been
 * decoded and the first exception extracted. Applies the three pre-dispatch
 * gates in fixed order, persists an `errors` row, and (in W3) hands off
 * to the session dispatcher. For W2, accepted errors stay at
 * `dispatch_status='pending'` and the dispatcher is the no-op the W3
 * worker will pick up.
 *
 * Gate order (locked):
 *   1. insert pending row, capture error_id
 *   2. dedupe        → status='deduped',      notify 'dedupe_hit'
 *   3. rate-limit    → status='rate_limited', notify 'rate_limit'
 *   4. daily cap     → status='cap_exceeded', notify 'daily_cap'
 *   5. accept → stays 'pending' for W3 dispatcher
 *
 * Silent-skip emails go through `./notify.ts` (emails4agents, throttled
 * by `notifications_sent`).
 */
import type { ErrorProject } from '../db/error-capture-dal.ts'
import {
  insertError,
  findRecentErrorByFingerprint,
  countErrorsInLastHour,
  countDispatchesToday,
  updateErrorDispatchStatus,
} from '../db/error-capture-dal.ts'
import { getUserTimezone } from '../db/dal.ts'
import { notifyThrottled } from './notify.ts'
import { dispatchPendingError } from './dispatcher.ts'
import { broadcastErrorEvent } from '../ws/registry.ts'

export interface RecordErrorFields {
  fingerprint: string
  error_type: string
  error_value: string
  stacktrace_json?: unknown
  release?: string | null
}

export interface RecordErrorResult {
  error_id: string
  dispatch_status:
    | 'pending'
    | 'deduped'
    | 'rate_limited'
    | 'cap_exceeded'
    | 'skipped'
  skip_reason?: string
}

export interface RecordErrorOpts {
  /**
   * B2 (obs): when false, the dispatcher is NEVER invoked. All three gates
   * (dedupe, rate-limit, daily cap) still run and the row still persists.
   * On accept, the row lands at `dispatch_status='skipped'` with
   * `skip_reason='no_dispatch'`. Used by hub self-capture to avoid feeding
   * hub-internal exceptions back into a Claude session.
   */
  dispatch?: boolean
}

export async function recordError(
  project: ErrorProject,
  fields: RecordErrorFields,
  opts: RecordErrorOpts = {},
): Promise<RecordErrorResult> {
  const dispatchEnabled = opts.dispatch !== false
  // 1. Insert pending. We always have a row to point notifications at, and
  //    the row also participates in dedupe/rate-limit counts.
  const row = await insertError(project.id, {
    fingerprint: fields.fingerprint,
    error_type: fields.error_type,
    error_value: fields.error_value,
    stacktrace_json: fields.stacktrace_json ?? [],
    release: fields.release ?? null,
    dispatch_status: 'pending',
  })

  // Emit error_received so the UI can flash a "new error" indicator before
  // the gates resolve. Fires even on rows we'll immediately gate-skip.
  broadcastErrorEvent(project.user_id, {
    type: 'error_received',
    error_id: row.id,
    project_id: project.id,
    fingerprint: fields.fingerprint,
    received_at: row.received_at,
  })

  // 2. Dedupe — match any earlier row in the window (excluding the one we just
  //    inserted).
  const recent = await findRecentErrorByFingerprint(
    project.id,
    fields.fingerprint,
    project.dedupe_window_seconds,
  )
  if (recent && recent.id !== row.id) {
    const reason = `dedupe_window_${project.dedupe_window_seconds}s`
    await updateErrorDispatchStatus(row.id, 'deduped', reason)
    await notifyThrottled(
      'dedupe_hit',
      `${project.id}:${fields.fingerprint}`,
      project.dedupe_window_seconds,
      project,
      { error_type: fields.error_type, error_value: fields.error_value },
    )
    broadcastErrorEvent(project.user_id, {
      type: 'error_skipped', error_id: row.id, project_id: project.id,
      dispatch_status: 'deduped', skip_reason: reason,
    })
    return { error_id: row.id, dispatch_status: 'deduped', skip_reason: reason }
  }

  // 3. Rate limit — hourly count includes this row, so the gate fires when
  //    count *exceeds* the configured limit.
  const lastHour = await countErrorsInLastHour(project.id)
  if (lastHour > project.rate_limit_per_hour) {
    const reason = `rate_limit_${project.rate_limit_per_hour}_per_hour`
    await updateErrorDispatchStatus(row.id, 'rate_limited', reason)
    await notifyThrottled(
      'rate_limit',
      `${project.id}`,
      3600,
      project,
      { error_type: fields.error_type, error_value: fields.error_value },
    )
    broadcastErrorEvent(project.user_id, {
      type: 'error_skipped', error_id: row.id, project_id: project.id,
      dispatch_status: 'rate_limited', skip_reason: reason,
    })
    return { error_id: row.id, dispatch_status: 'rate_limited', skip_reason: reason }
  }

  // 4. Daily cap — only `dispatched` rows consume budget, so this gate
  //    measures *successful dispatches today* against the cap.
  const tz = await getUserTimezone(project.user_id)
  const dispatchedToday = await countDispatchesToday(project.id, tz)
  if (dispatchedToday >= project.daily_dispatch_cap) {
    const reason = `daily_cap_${project.daily_dispatch_cap}`
    await updateErrorDispatchStatus(row.id, 'cap_exceeded', reason)
    await notifyThrottled(
      'daily_cap',
      `${project.id}:${todayKey(tz)}`,
      24 * 3600,
      project,
      { error_type: fields.error_type, error_value: fields.error_value },
    )
    broadcastErrorEvent(project.user_id, {
      type: 'error_skipped', error_id: row.id, project_id: project.id,
      dispatch_status: 'cap_exceeded', skip_reason: reason,
    })
    return { error_id: row.id, dispatch_status: 'cap_exceeded', skip_reason: reason }
  }

  // 5. Accepted.
  if (!dispatchEnabled) {
    // B2 (obs): hub self-capture — gates passed but dispatcher is OFF.
    // Mark row 'skipped' so it doesn't sit at 'pending' forever.
    const reason = 'no_dispatch'
    await updateErrorDispatchStatus(row.id, 'skipped', reason)
    return { error_id: row.id, dispatch_status: 'skipped', skip_reason: reason }
  }
  // Row stays 'pending'; W3 dispatcher fires it into the configured session.
  // Fire-and-forget — we never block the intake POST.
  void dispatchPendingError(row.id).catch((err) => {
    console.error(`[error-capture] dispatch failed error=${row.id}: ${err?.message ?? err}`)
  })
  return { error_id: row.id, dispatch_status: 'pending' }
}

function todayKey(tz: string): string {
  try {
    // YYYY-MM-DD in the user's timezone — used so the daily-cap email
    // throttle resets at local midnight, not UTC.
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz || 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
    return fmt.format(new Date())
  } catch {
    return new Date().toISOString().slice(0, 10)
  }
}
