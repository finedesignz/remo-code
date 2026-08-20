/**
 * AgentAutofix error forwarder (directive B) — hub-self-error only.
 *
 * remo-code already has its own mature error-capture → dispatch-to-Claude-
 * session self-heal pipeline (hub/src/error-capture/*). Wiring AgentAutofix
 * into that same intake would double-report every user-facing defect the
 * existing pipeline already turns into a fix. The one gap that pipeline
 * deliberately leaves open is `hub/src/observability/self-capture.ts`:
 * hub-internal exceptions (`uncaughtException`, `unhandledRejection`, Hono
 * `onError`) are recorded with `{ dispatch: false }` specifically so they
 * never loop back into a live Claude session. That is exactly the class of
 * error this forwarder targets — it is additive, not a duplicate of the
 * in-house pipeline.
 *
 * The AgentAutofix server does NO dedup (see docs/error-log-integration.md
 * non-negotiables) — every control below is client-side: a per-fingerprint
 * hourly throttle and a real per-day counter, both in-memory (single
 * process; the hub runs as one Coolify service, so this is not the
 * multi-replica trap the mcp-factory pilot flagged). ADDITIVELY, a 45s
 * aggregation window coalesces a burst of same-fingerprint occurrences into
 * one report (with an occurrence count) instead of firing synchronously per
 * occurrence — the hourly throttle still applies on top, unchanged.
 *
 * A noise filter drops known-benign classes before anything is scheduled —
 * see `isNoise()` for the server-side-specific rationale for each entry.
 */
import { mintAgentautofixIdentityToken } from './identity.ts'
import { config } from '../config.ts'
import { log } from '../observability/logger'

const MAX_REPORTS_PER_DAY = 200 // well under the 2000/day app-wide cap; this is ONE class of error
const THROTTLE_MS = 60 * 60 * 1000 // one report per fingerprint per hour
const AGGREGATION_WINDOW_MS = 45 * 1000 // coalesce a burst of the same fingerprint into one report

const lastSentAt = new Map<string, number>()
let dayWindowStart = Date.now()
let dayCount = 0

// Fingerprints with a send currently between "reservation taken" and
// "fetch settled" (success/429-rollback/error-rollback). Lets a blocked
// flush tell an IN-FLIGHT blocker (occurrences must be re-armed, not lost —
// the hour may get rolled back) apart from a SETTLED one (genuine throttle
// hit — safe to drop-with-log, the hour really was consumed).
const inFlightSend = new Set<string>()

interface PendingAggregate {
  fields: SelfErrorForward
  occurrences: number
  timer: ReturnType<typeof setTimeout>
}
const pendingAggregates = new Map<string, PendingAggregate>()

/**
 * Known-benign classes to drop before ever scheduling a report. This
 * forwarder is server-only (Bun/Hono hub process) — deliberately NOT the
 * browser-error noise list (no ResizeObserver/extension-origin heuristics
 * apply server-side):
 *  - AbortError / aborted fetches — a client disconnecting mid-request is
 *    expected traffic shape, not a defect.
 *  - ECONNRESET — the remote peer closed the socket (client nav-away,
 *    supervisor reconnect); not something a code fix addresses. Matched only
 *    when the error VALUE *is* the raw socket error (Node's own message
 *    shape is "read ECONNRESET" / "write ECONNRESET" with no prefix) —
 *    anchored to the start of the string, not a substring search anywhere
 *    in free text. This deliberately does NOT catch a wrapped rethrow like
 *    "Failed to persist session after socket error: read ECONNRESET" —
 *    that's a genuine application-level failure with its own message, and
 *    dropping it would swallow a real defect. We don't have `err.code` on
 *    this interface (only `name`/`message` survive to here), so an anchored
 *    message match is the narrowest signal available without threading a
 *    new field through `classify()`/`captureSelfError` for one noise class.
 *  - Third-party-script errors have no browser-page equivalent server-side
 *    and are intentionally NOT filtered here.
 */
function isNoise(fields: SelfErrorForward): boolean {
  const type = fields.errorType || ''
  const value = fields.errorValue || ''
  if (/\bAbortError\b/i.test(type) || /\baborted\b/i.test(value)) return true
  if (/^(?:read |write )?ECONNRESET\b/i.test(value.trim())) return true
  return false
}

/** Redacts the shapes most likely to carry a live secret in a hub stack trace or message. */
function scrub(text: string): string {
  return text
    .replace(/postgres(?:ql)?:\/\/[^\s"']+/gi, 'postgres://[REDACTED]')
    .replace(/\b(?:sk-ant-oat01|sk-ant-api03|ghs_|ghp_|gho_|pk_live|ss_)[A-Za-z0-9_-]{10,}/g, '[REDACTED_TOKEN]')
    .replace(/\bBearer\s+[A-Za-z0-9._-]{10,}/gi, 'Bearer [REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[REDACTED_JWT]')
}

function resetDayWindowIfStale(): void {
  const now = Date.now()
  if (now - dayWindowStart > 24 * 60 * 60 * 1000) {
    dayWindowStart = now
    dayCount = 0
  }
}

export interface SelfErrorForward {
  fingerprint: string
  errorType: string
  errorValue: string
  stack?: string
  source: string
}

/**
 * Fire-and-forget report of a hub-internal exception to AgentAutofix. Never
 * throws — this must not be able to crash the process it is reporting on.
 *
 * Schedules into a 45s per-fingerprint aggregation window rather than
 * sending synchronously: the first occurrence of a fingerprint arms a
 * timer, later occurrences in the same window just bump the count, and the
 * timer flush is what actually calls the network. The existing hourly
 * per-fingerprint throttle is re-checked at flush time — the window is
 * additive, not a replacement.
 */
export async function reportSelfErrorToAgentautofix(fields: SelfErrorForward): Promise<void> {
  if (!config.agentautofix.configured) return
  if (isNoise(fields)) return

  const existing = pendingAggregates.get(fields.fingerprint)
  if (existing) {
    existing.occurrences += 1
    return
  }

  // Not lost, only possibly double-sent: the bucket delete in the flush
  // timer is synchronous and happens before `sendAggregatedReport` ever
  // awaits anything, so an occurrence arriving after the delete can never be
  // counted into a bucket that's already gone — the `existing` check above
  // simply misses (bucket key is gone), falls through, and arms a brand-new
  // 45s window via `armAggregationWindow`. If that new window's flush lands
  // while the prior send for this fingerprint is still IN FLIGHT,
  // `sendAggregatedReport` re-arms it again instead of discarding it (see
  // `inFlightSend` above) — so it is never silently lost even across
  // multiple overlapping windows.
  armAggregationWindow(fields, 1)
}

/** Arm (or extend) a 45s aggregation window for a fingerprint. */
function armAggregationWindow(fields: SelfErrorForward, occurrences: number): void {
  const existing = pendingAggregates.get(fields.fingerprint)
  if (existing) {
    existing.occurrences += occurrences
    return
  }
  const timer = setTimeout(() => {
    const agg = pendingAggregates.get(fields.fingerprint)
    pendingAggregates.delete(fields.fingerprint)
    if (agg) void sendAggregatedReport(agg.fields, agg.occurrences)
  }, AGGREGATION_WINDOW_MS)
  // Never let the aggregation timer keep the process alive.
  if (typeof (timer as any)?.unref === 'function') (timer as any).unref()

  pendingAggregates.set(fields.fingerprint, { fields, occurrences, timer })
}

/** Visible for tests: flush a pending aggregate immediately, bypassing the timer. */
export function _flushPendingForTest(fingerprint: string): void {
  const agg = pendingAggregates.get(fingerprint)
  if (!agg) return
  clearTimeout(agg.timer)
  pendingAggregates.delete(fingerprint)
  void sendAggregatedReport(agg.fields, agg.occurrences)
}

/** Visible for tests: current daily send counter (dayCount must never go negative). */
export function _getDayCountForTest(): number {
  return dayCount
}

/** Visible for tests: reset all in-memory throttle/aggregation state. */
export function _resetForTest(): void {
  for (const agg of pendingAggregates.values()) clearTimeout(agg.timer)
  pendingAggregates.clear()
  lastSentAt.clear()
  inFlightSend.clear()
  dayWindowStart = Date.now()
  dayCount = 0
}

/**
 * Reserve the hourly throttle slot for a fingerprint SYNCHRONOUSLY, before any
 * network call. This closes the double-send race described above: the old
 * code only wrote `lastSentAt` after `await fetch(...)` resolved, so a second
 * aggregation window flushing while the first send was still in flight (slow
 * or hung fetch) saw an unset/stale stamp and sent a second report for the
 * same fingerprint inside the same throttle hour. Reserving here means the
 * second flush's throttle check sees the reservation immediately, with no
 * await in between — no window for a racing read.
 */
function reserveThrottleSlot(fingerprint: string, now: number): boolean {
  const last = lastSentAt.get(fingerprint)
  if (last && now - last < THROTTLE_MS) return false
  lastSentAt.set(fingerprint, now)
  inFlightSend.add(fingerprint)
  return true
}

async function sendAggregatedReport(fields: SelfErrorForward, occurrences: number): Promise<void> {
  resetDayWindowIfStale()
  if (dayCount >= MAX_REPORTS_PER_DAY) return

  const now = Date.now()

  // A blocker for this fingerprint is still IN FLIGHT (reserved but not yet
  // settled). Do NOT discard these occurrences: the in-flight send may still
  // roll its reservation back (429 / network failure), in which case the
  // hour was never actually consumed and this batch is the only record of
  // it. Re-arm the aggregation window so it retries once the blocker settles
  // — a rolled-back reservation lets the retry through immediately; a
  // successful one throttles it (see the settled-throttle branch below).
  if (inFlightSend.has(fields.fingerprint)) {
    armAggregationWindow(fields, occurrences)
    return
  }

  if (!reserveThrottleSlot(fields.fingerprint, now)) {
    // Genuinely throttled by a SETTLED (successfully sent) reservation —
    // the hour really was consumed. This is a real, policy-driven drop, so
    // it must never be silent: log it with the occurrence count so it's
    // visible instead of vanishing without a trace.
    log.info('[agentautofix] report throttled, dropping occurrences', {
      fingerprint: fields.fingerprint,
      occurrences,
    })
    return
  }
  dayCount += 1

  try {
    // Server-minted identity token — the hub process is its own "user" here,
    // so `sub` is a stable synthetic id, not a real end-user.
    const token = mintAgentautofixIdentityToken({ sub: 'hub-self-capture', role: 'system' })

    const occurrenceSuffix = occurrences > 1 ? ` (x${occurrences} in ${AGGREGATION_WINDOW_MS / 1000}s)` : ''
    const comment = scrub(
      `Hub self-capture [${fields.source}]: ${fields.errorType}: ${fields.errorValue}${occurrenceSuffix}` +
        (fields.stack ? `\n\n${scrub(fields.stack).split('\n').slice(0, 30).join('\n')}` : ''),
    ).slice(0, 3900)

    const res = await fetch(`${config.agentautofix.host}/api/plugin/v1/comments`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-agentautofix-key': config.agentautofix.publicKey,
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        comment,
        x: 0,
        y: 0,
        page_url: `${config.agentautofix.origin}/#/hub-self-capture`,
        element_selector: 'body',
        element_meta: { kind: 'log_error', source: fields.source, occurrences },
      }),
    })

    if (res.status === 429) {
      // Rate-limited by the server, not a rejection of the content — roll
      // back the reservation so a later occurrence gets a genuine retry
      // instead of being silently throttled for a full hour on a slot we
      // never actually used.
      lastSentAt.delete(fields.fingerprint)
      dayCount -= 1
      inFlightSend.delete(fields.fingerprint)
      return
    }
    if (!res.ok) {
      // Terminal per contract — 400/401/403/5xx keep the reservation so a
      // persistently-rejected fingerprint doesn't re-POST every window
      // forever; log for visibility.
      log.warn('[agentautofix] report rejected', { status: res.status })
    }
    // res.ok — reservation stands, this is the one send for this hour.
    inFlightSend.delete(fields.fingerprint)
  } catch (err) {
    // Network-level failure (DNS, connection refused, timeout, etc). A
    // failed send must not permanently poison the fingerprint for a full
    // THROTTLE_MS hour, so roll back the reservation here too — otherwise
    // a real, reportable error would silently vanish into the throttle
    // window with nothing ever actually sent.
    lastSentAt.delete(fields.fingerprint)
    dayCount -= 1
    inFlightSend.delete(fields.fingerprint)
    log.warn('[agentautofix] report failed', { error: (err as Error)?.message ?? String(err) })
  }
}
