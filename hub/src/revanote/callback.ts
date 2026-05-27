/**
 * Revanote outbound callback (Phase 08).
 *
 * `POST <callback_url>` with `Authorization: Bearer <revanote_webhook_secret>`
 * and a `RevanoteCallbackPayload` body. Retry curve: 1m → 5m → 15m → 1h →
 * dead-letter (~24h cumulative). Jittered ±10%. 4xx → terminal. 5xx +
 * network → retry.
 *
 * `deployed: true` means "pushed to deploy branch", NOT "Coolify build
 * finished + serving traffic". Documented contract in `docs/revanote.md`.
 *
 * Worker design: every 30s `tick` claims due rows via FOR UPDATE SKIP LOCKED
 * (DAL helper), attempts delivery, and updates state. The worker is safe to
 * run on multiple hub instances concurrently.
 */
import {
  enqueueCallbackAttempt,
  updateCallbackAttempt,
  claimDueCallbackAttempts,
  getUserRevanoteWebhookSecret,
  type AnnotationRow,
  type CallbackAttemptRow,
} from '../db/revanote-dal.ts'
import { sql } from '../db/postgres.ts'
import { broadcastRevanoteEvent } from '../ws/registry.ts'

export interface RevanoteCallbackPayload {
  annotation_id: string
  resolved: boolean
  action_taken: string | null
  agent_reply: string | null
  files_changed: string[]
  deployed: boolean
  needs_clarification?: boolean
  clarification_question?: string | null
  error?: string | null
}

// Retry schedule in ms. Last bucket is the dead-letter cap.
const RETRY_DELAYS_MS = [
  1 * 60_000,        // 1m
  5 * 60_000,        // 5m
  15 * 60_000,       // 15m
  60 * 60_000,       // 1h
  4 * 60 * 60_000,   // 4h
  12 * 60 * 60_000,  // 12h (≈ 24h cumulative)
]
const DEAD_AFTER_ATTEMPTS = RETRY_DELAYS_MS.length // attempt_no=6 → dead-letter

function jitter(ms: number): number {
  const j = 1 + (Math.random() * 0.2 - 0.1) // ±10%
  return Math.max(1_000, Math.round(ms * j))
}

function nextRetryFor(attemptNo: number): Date | null {
  if (attemptNo >= DEAD_AFTER_ATTEMPTS) return null
  return new Date(Date.now() + jitter(RETRY_DELAYS_MS[attemptNo]))
}

/**
 * Insert a row scheduled for immediate delivery (next_retry_at = now()).
 * The worker tick picks it up on its next loop. Used by both the
 * run-lifecycle (post-agent-reply) and by pre-dispatch rejections.
 */
export async function scheduleImmediateCallback(
  ann: AnnotationRow,
  payload: RevanoteCallbackPayload,
): Promise<void> {
  await enqueueCallbackAttempt({
    annotation_id: ann.id,
    payload_json: payload,
    next_retry_at: new Date(),
  })
}

async function deliverOne(attempt: CallbackAttemptRow): Promise<{
  delivered: boolean
  status: number | null
  error: string | null
  retryable: boolean
}> {
  // Look up annotation + user secret.
  const rows = await sql<{ user_id: string; callback_url: string }[]>`
    SELECT user_id, callback_url FROM annotations WHERE id = ${attempt.annotation_id}
  `
  if (!rows[0]) {
    return { delivered: false, status: null, error: 'annotation_gone', retryable: false }
  }
  const { user_id: userId, callback_url: callbackUrl } = rows[0]
  const secret = await getUserRevanoteWebhookSecret(userId)
  if (!secret) {
    return { delivered: false, status: null, error: 'secret_missing', retryable: false }
  }

  const controller = new AbortController()
  const t = setTimeout(() => controller.abort(), 10_000)
  try {
    const res = await fetch(callbackUrl, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${secret}`,
        'X-Revanote-Webhook-Source': 'remo-code',
      },
      body: JSON.stringify(attempt.payload_json),
    })
    const status = res.status
    if (status >= 200 && status < 300) {
      return { delivered: true, status, error: null, retryable: false }
    }
    // 4xx → terminal failure. 5xx → retry.
    const retryable = status >= 500
    return { delivered: false, status, error: `http_${status}`, retryable }
  } catch (err: any) {
    return {
      delivered: false,
      status: null,
      error: err?.name === 'AbortError' ? 'timeout' : (err?.message ?? 'fetch_failed'),
      retryable: true,
    }
  } finally {
    clearTimeout(t)
  }
}

async function processOne(attempt: CallbackAttemptRow): Promise<void> {
  const nextAttempt = attempt.attempt_no + 1
  const result = await deliverOne(attempt)

  // Look up user_id once for broadcasts.
  const rows = await sql<{ user_id: string }[]>`
    SELECT user_id FROM annotations WHERE id = ${attempt.annotation_id}
  `
  const userId = rows[0]?.user_id ?? null

  if (result.delivered) {
    await updateCallbackAttempt(attempt.id, {
      attempt_no: nextAttempt,
      http_status: result.status,
      error: null,
      delivered: true,
      next_retry_at: null,
    })
    if (userId) {
      broadcastRevanoteEvent(userId, {
        type: 'revanote_callback_sent',
        annotation_id: attempt.annotation_id,
        attempt_no: nextAttempt,
        http_status: result.status,
        delivered: true,
        next_retry_at: null,
      })
    }
    return
  }

  if (!result.retryable || nextAttempt >= DEAD_AFTER_ATTEMPTS) {
    await updateCallbackAttempt(attempt.id, {
      attempt_no: nextAttempt,
      http_status: result.status,
      error: result.error,
      delivered: false,
      dead: true,
      next_retry_at: null,
    })
    if (userId) {
      broadcastRevanoteEvent(userId, {
        type: 'revanote_callback_sent',
        annotation_id: attempt.annotation_id,
        attempt_no: nextAttempt,
        http_status: result.status,
        delivered: false,
        dead: true,
        next_retry_at: null,
      })
    }
    return
  }

  const next = nextRetryFor(nextAttempt)
  await updateCallbackAttempt(attempt.id, {
    attempt_no: nextAttempt,
    http_status: result.status,
    error: result.error,
    next_retry_at: next,
  })
  if (userId) {
    broadcastRevanoteEvent(userId, {
      type: 'revanote_callback_sent',
      annotation_id: attempt.annotation_id,
      attempt_no: nextAttempt,
      http_status: result.status,
      delivered: false,
      next_retry_at: next ? next.toISOString() : null,
    })
  }
}

async function tick(): Promise<void> {
  let claimed: CallbackAttemptRow[] = []
  try {
    claimed = await claimDueCallbackAttempts(25)
  } catch (err: any) {
    console.warn(`[revanote.callback] claim failed: ${err?.message ?? err}`)
    return
  }
  if (claimed.length === 0) return
  await Promise.allSettled(claimed.map((r) => processOne(r)))
}

const TICK_MS = 30_000
let timer: ReturnType<typeof setInterval> | null = null

export function startRevanoteCallbackWorker(): void {
  if (timer) return
  timer = setInterval(() => {
    void tick().catch((err) => console.warn(`[revanote.callback] tick err: ${err?.message ?? err}`))
  }, TICK_MS)
  // Kick once shortly after boot so any rows already due fire promptly.
  setTimeout(() => { void tick().catch(() => {}) }, 5_000)
}

export function stopRevanoteCallbackWorker(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}

// Test helpers.
export const _internals = { tick, nextRetryFor, RETRY_DELAYS_MS, DEAD_AFTER_ATTEMPTS }
