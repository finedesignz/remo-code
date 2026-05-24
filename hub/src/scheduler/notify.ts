/**
 * Email notifications for scheduled task on_complete actions.
 * Uses emails4agents per global CLAUDE.md mandate.
 *
 * Env:
 *   E4A_API_KEY     — required to send
 *   E4A_BASE_URL    — defaults to https://api.emails4agents.com
 *   E4A_INBOX_ID    — required inbox to send from
 *
 * If env vars are missing, the email is logged and skipped (does not throw).
 */
import { getUserById } from '../db/dal.ts'

export async function sendEmailNotification(input: {
  userId: string
  to?: string
  subject: string
  body: string
}) {
  const apiKey = process.env.E4A_API_KEY
  const baseUrl = process.env.E4A_BASE_URL || 'https://api.emails4agents.com'
  const inboxId = process.env.E4A_INBOX_ID

  let to = input.to
  if (!to) {
    const user = await getUserById(input.userId)
    to = user?.email
  }
  if (!to) {
    console.warn('[notify] no recipient resolved, skipping email')
    return
  }
  if (!apiKey || !inboxId) {
    console.warn(`[notify] E4A env not configured, would have emailed ${to}: ${input.subject}`)
    return
  }

  try {
    const res = await fetch(`${baseUrl}/v1/messages/send`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': apiKey,
      },
      body: JSON.stringify({
        inbox_id: inboxId,
        to,
        subject: input.subject,
        text: input.body,
      }),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      console.error(`[notify] email send failed ${res.status}: ${text.slice(0, 200)}`)
    }
  } catch (err: any) {
    console.error('[notify] email send threw', err?.message)
  }
}
