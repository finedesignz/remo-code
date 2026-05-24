/**
 * Email post-run action (W2/T8.6).
 *
 * Uses emails4agents per global CLAUDE.md mandate (rule #7) — never
 * SES/SendGrid/Postmark/Mailgun/Resend without explicit user request.
 *
 *   E4A_API_KEY     — required
 *   E4A_BASE_URL    — defaults to https://api.emails4agents.com
 *   E4A_INBOX_ID    — required
 *
 * Failures are log-only — they never fail the parent run.
 */
import type { PostRunAction } from './schema.ts'
import { render } from './template.ts'
import { getUserById } from '../../db/dal.ts'

interface EmailCtx { userId: string; templateVars: Record<string, unknown> }

export async function executeEmail(action: PostRunAction, ctx: EmailCtx): Promise<void> {
  if (action.type !== 'notify_email') return
  const apiKey = process.env.E4A_API_KEY
  const baseUrl = process.env.E4A_BASE_URL || 'https://api.emails4agents.com'
  const inboxId = process.env.E4A_INBOX_ID

  let to = action.config.to
  if (!to) {
    const user = await getUserById(ctx.userId)
    to = user?.email
  }
  if (!to) { console.warn('[post-run.email] no recipient resolved, skipping'); return }
  if (!apiKey || !inboxId) {
    console.warn(`[post-run.email] E4A env not configured; would have emailed ${to}`)
    return
  }

  const subject = render(action.config.subject, ctx.templateVars)
  const html = render(action.config.body, ctx.templateVars, { html: true })
  const text = render(action.config.body, ctx.templateVars)

  try {
    const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/v1/messages/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
      body: JSON.stringify({ inbox_id: inboxId, to, subject, html, text }),
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      console.error(`[post-run.email] send failed ${res.status}: ${body.slice(0, 200)}`)
    }
  } catch (err: any) {
    console.error('[post-run.email] threw', err?.message)
  }
}
