/**
 * notifyThrottled — silent-skip notifier for the error-capture pipeline.
 *
 * Sends an email when an error is gated (deduped, rate-limited, daily cap
 * exceeded, dispatch failed, or target session offline) so the user knows
 * a problem reached the intake but never reached Claude. Emails go through
 * emails4agents per global CLAUDE.md rule #7 — NEVER SES/SendGrid/etc.
 *
 * Throttling: each (kind, dedupe_key) combination is suppressed for
 * `ttlSeconds` after the last send. Tracked in `notifications_sent`.
 *
 * Failure mode: log-only. A notification that fails to send MUST NOT
 * propagate up to the intake handler — the request body has already been
 * consumed and persisted; the user will still see the row in their UI.
 *
 * Env:
 *   E4A_API_KEY    — required to actually send
 *   E4A_BASE_URL   — defaults to https://api.emails4agents.com
 *   E4A_INBOX_ID   — required to actually send
 *
 * If env is missing, the throttle row is still written (so we don't spam
 * once env arrives) and the would-have-sent is logged.
 */
import { sql } from '../db/postgres.ts'
import { getUserById } from '../db/dal.ts'
import type { ErrorProject } from '../db/error-capture-dal.ts'

export type NotifyKind =
  | 'dedupe_hit'
  | 'rate_limit'
  | 'daily_cap'
  | 'dispatch_failed'
  | 'session_offline'
  | 'stack_not_detected'

export interface NotifyContext {
  error_type?: string
  error_value?: string
  detail?: string
  /** stack_not_detected only — list of file paths the auto-detector tried. */
  tried?: string[]
  /** stack_not_detected only — the DSN to copy-paste into a manual SDK init. */
  dsn?: string
}

export async function notifyThrottled(
  kind: NotifyKind,
  dedupeKey: string,
  ttlSeconds: number,
  project: ErrorProject,
  ctx: NotifyContext = {},
): Promise<void> {
  // 1. Throttle gate — has this (kind, dedupe_key) been sent inside the TTL?
  try {
    const existing = await sql<{ id: string }[]>`
      SELECT id FROM notifications_sent
      WHERE kind = ${kind}
        AND dedupe_key = ${dedupeKey}
        AND sent_at > now() - (${ttlSeconds} || ' seconds')::interval
      LIMIT 1
    `
    if (existing.length > 0) return
  } catch (err: any) {
    console.error('[error-capture.notify] throttle check failed:', err?.message)
    // fall through — better to risk a duplicate than to drop the alert
  }

  // 2. Resolve recipient
  let to: string | undefined
  try {
    const user = await getUserById(project.user_id)
    to = user?.email ?? undefined
  } catch (err: any) {
    console.error('[error-capture.notify] user lookup failed:', err?.message)
  }

  // 3. Build subject + body
  const { subject, body } = buildEmail(kind, project, ctx)

  // 4. Record the send attempt BEFORE actually sending so a transient
  //    email-provider failure doesn't cause a retry storm on the next
  //    error of the same kind.
  try {
    await sql`
      INSERT INTO notifications_sent (kind, dedupe_key) VALUES (${kind}, ${dedupeKey})
    `
  } catch (err: any) {
    console.error('[error-capture.notify] throttle insert failed:', err?.message)
  }

  // 5. Send via emails4agents (log-only on failure)
  await sendEmail(to, subject, body)
}

function buildEmail(
  kind: NotifyKind,
  project: ErrorProject,
  ctx: NotifyContext,
): { subject: string; body: string } {
  const projectName = project.name
  const typeStr = ctx.error_type ?? 'unknown'
  const valueStr = (ctx.error_value ?? '').slice(0, 200)
  const detail = ctx.detail ?? ''

  switch (kind) {
    case 'dedupe_hit':
      return {
        subject: `[error-capture] ${projectName}: dedupe limit hit on ${typeStr}`,
        body: [
          `An error matched a recently-seen fingerprint and was skipped.`,
          ``,
          `Project: ${projectName}`,
          `Window:  ${project.dedupe_window_seconds}s`,
          `Type:    ${typeStr}`,
          `Value:   ${valueStr}`,
          ``,
          `No further dedupe alerts for this fingerprint until the window expires.`,
        ].join('\n'),
      }
    case 'rate_limit':
      return {
        subject: `[error-capture] ${projectName}: hourly rate limit reached`,
        body: [
          `Errors received in the last hour exceeded the configured limit.`,
          ``,
          `Project: ${projectName}`,
          `Limit:   ${project.rate_limit_per_hour}/hour`,
          `Type:    ${typeStr}`,
          `Value:   ${valueStr}`,
          ``,
          `New errors will be marked rate_limited until the next hour rolls over.`,
        ].join('\n'),
      }
    case 'daily_cap':
      return {
        subject: `[error-capture] ${projectName}: daily dispatch cap reached`,
        body: [
          `The daily dispatch cap for this project has been hit.`,
          ``,
          `Project: ${projectName}`,
          `Cap:     ${project.daily_dispatch_cap}/day`,
          `Type:    ${typeStr}`,
          `Value:   ${valueStr}`,
          ``,
          `New errors will be marked cap_exceeded until local midnight.`,
        ].join('\n'),
      }
    case 'session_offline':
      return {
        subject: `[error-capture] ${projectName}: target session offline; queued for grace`,
        body: [
          `An error was accepted but the target Claude session is offline.`,
          ``,
          `Project: ${projectName}`,
          `Type:    ${typeStr}`,
          `Value:   ${valueStr}`,
          ``,
          `The dispatcher will replay the error if the session reconnects within the grace window.`,
        ].join('\n'),
      }
    case 'dispatch_failed':
      return {
        subject: `[error-capture] ${projectName}: dispatch into Claude session failed`,
        body: [
          `An error passed all gates but the dispatch into the target session failed.`,
          ``,
          `Project: ${projectName}`,
          `Type:    ${typeStr}`,
          `Value:   ${valueStr}`,
          detail ? `Detail:  ${detail}` : '',
          ``,
          `The row is marked dispatch_status='failed'. Investigate the agent socket.`,
        ].filter(Boolean).join('\n'),
      }
    case 'stack_not_detected': {
      const dsn = ctx.dsn ?? '<your DSN — open the project in the Remo UI to copy>'
      const tried = (ctx.tried ?? []).map(p => `  - ${p}`).join('\n') || '  (none reported)'
      return {
        subject: `[error-capture] ${projectName}: SDK install — stack not auto-detected`,
        body: [
          `Remo tried to auto-install a Sentry SDK in the repo you pointed at, but could`,
          `not identify the stack from the candidate files. You can finish the install`,
          `manually by dropping one of the snippets below into your app's entry point.`,
          ``,
          `Project: ${projectName}`,
          `DSN:     ${dsn}`,
          ``,
          `Files probed:`,
          tried,
          ``,
          `--- Node.js (Express / generic) ---`,
          `// top of src/index.ts (or your server entry):`,
          `import * as Sentry from '@sentry/node'`,
          `Sentry.init({ dsn: process.env.SENTRY_DSN ?? '${dsn}' })`,
          ``,
          `npm i @sentry/node`,
          ``,
          `--- Next.js ---`,
          `// sentry.server.config.ts`,
          `import * as Sentry from '@sentry/nextjs'`,
          `Sentry.init({ dsn: process.env.SENTRY_DSN ?? '${dsn}' })`,
          ``,
          `npm i @sentry/nextjs`,
          ``,
          `--- Python (Django / Flask / FastAPI) ---`,
          `# top of manage.py / wsgi.py / main.py:`,
          `import sentry_sdk`,
          `sentry_sdk.init(dsn="${dsn}")`,
          ``,
          `pip install sentry-sdk`,
          ``,
          `Once installed, deploy and trigger an exception — it should appear in the`,
          `Error Capture page within seconds.`,
        ].join('\n'),
      }
    }
  }
}

async function sendEmail(
  to: string | undefined,
  subject: string,
  text: string,
): Promise<void> {
  const apiKey = process.env.E4A_API_KEY
  const baseUrl = process.env.E4A_BASE_URL || 'https://api.emails4agents.com'
  const inboxId = process.env.E4A_INBOX_ID

  if (!to) {
    console.warn('[error-capture.notify] no recipient; would have sent:', subject)
    return
  }
  if (!apiKey || !inboxId) {
    console.warn(`[error-capture.notify] E4A env not configured; would have emailed ${to}: ${subject}`)
    return
  }

  const url = `${baseUrl.replace(/\/+$/, '')}/v1/messages/send`
  const payload = JSON.stringify({ inbox_id: inboxId, to, subject, text })

  // 5s timeout, 1 retry on 5xx/network.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
        body: payload,
        signal: AbortSignal.timeout(5_000),
      })
      if (res.ok) return
      if (res.status < 500) {
        const body = await res.text().catch(() => '')
        console.error(`[error-capture.notify] send failed ${res.status}: ${body.slice(0, 200)}`)
        return
      }
      // 5xx → retry once
      if (attempt === 1) {
        const body = await res.text().catch(() => '')
        console.error(`[error-capture.notify] send failed (retry) ${res.status}: ${body.slice(0, 200)}`)
      }
    } catch (err: any) {
      if (attempt === 1) {
        console.error('[error-capture.notify] send threw:', err?.message)
      }
    }
  }
}
