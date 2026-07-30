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
 * multi-replica trap the mcp-factory pilot flagged).
 */
import { mintAgentautofixIdentityToken } from './identity.ts'
import { config } from '../config.ts'
import { log } from '../observability/logger'

const MAX_REPORTS_PER_DAY = 200 // well under the 2000/day app-wide cap; this is ONE class of error
const THROTTLE_MS = 60 * 60 * 1000 // one report per fingerprint per hour

const lastSentAt = new Map<string, number>()
let dayWindowStart = Date.now()
let dayCount = 0

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
 */
export async function reportSelfErrorToAgentautofix(fields: SelfErrorForward): Promise<void> {
  if (!config.agentautofix.configured) return

  resetDayWindowIfStale()
  if (dayCount >= MAX_REPORTS_PER_DAY) return

  const last = lastSentAt.get(fields.fingerprint)
  const now = Date.now()
  if (last && now - last < THROTTLE_MS) return

  try {
    // Server-minted identity token — the hub process is its own "user" here,
    // so `sub` is a stable synthetic id, not a real end-user.
    const token = mintAgentautofixIdentityToken({ sub: 'hub-self-capture', role: 'system' })

    const comment = scrub(
      `Hub self-capture [${fields.source}]: ${fields.errorType}: ${fields.errorValue}` +
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
        element_meta: { kind: 'log_error', source: fields.source },
      }),
    })

    // Terminal per contract — 400/401/403 must stamp the throttle so a
    // rejected fingerprint doesn't re-POST every hour forever. Only 429
    // means "retry later"; we simply let the next hourly tick try again.
    if (res.status !== 429) {
      lastSentAt.set(fields.fingerprint, now)
      dayCount += 1
    }
    if (!res.ok && res.status !== 429) {
      log.warn('[agentautofix] report rejected', { status: res.status })
    }
  } catch (err) {
    log.warn('[agentautofix] report failed', { error: (err as Error)?.message ?? String(err) })
  }
}
