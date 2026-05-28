/**
 * emails4agents notification on PR-opened (Phase 6).
 *
 * Fired only when deploy-policy says `notify=true` (major/breaking, github).
 * try/catch — never blocks the callback path. Logs + skips on missing recipient.
 *
 * Global CLAUDE.md rule #7: always emails4agents. Uses `hub/src/lib/email.ts`.
 */
import { sendEmail } from '../lib/email.ts'
import type { RiskClass } from './risk-classifier.ts'

export interface NotifyPrOpts {
  riskClass: RiskClass
  prUrl: string
  diffSummary: string
  annotationUrl?: string | null
  /** From inbound payload (e.g. `payload_raw.org_notify_email`). */
  payloadNotifyEmail?: string | null
}

function resolveRecipient(opts: NotifyPrOpts): string | null {
  if (opts.payloadNotifyEmail && opts.payloadNotifyEmail.includes('@')) return opts.payloadNotifyEmail
  const envAddr = process.env.REVANOTE_PR_NOTIFY_EMAIL
  if (envAddr && envAddr.includes('@')) return envAddr
  return null
}

function first10Lines(text: string): string[] {
  return text.split(/\r?\n/).slice(0, 10)
}

function buildBody(opts: NotifyPrOpts): { text: string; html: string; subject: string } {
  const subject = `Revanote agent PR awaiting review — ${opts.riskClass}`
  const lines = first10Lines(opts.diffSummary)
  const textBody = [
    `A revanote agent PR is awaiting human review.`,
    ``,
    `Risk class: ${opts.riskClass}`,
    `PR URL: ${opts.prUrl}`,
    opts.annotationUrl ? `Annotation: ${opts.annotationUrl}` : null,
    ``,
    `Diff summary (first 10 lines):`,
    ...lines.map((l) => `  ${l}`),
  ].filter((x) => x !== null).join('\n')

  const htmlLines = lines.map((l) => `<li><code>${escapeHtml(l)}</code></li>`).join('')
  const htmlBody = `
<p>A revanote agent PR is awaiting human review.</p>
<ul>
  <li><strong>Risk class:</strong> ${escapeHtml(opts.riskClass)}</li>
  <li><strong>PR:</strong> <a href="${escapeHtml(opts.prUrl)}">${escapeHtml(opts.prUrl)}</a></li>
  ${opts.annotationUrl ? `<li><strong>Annotation:</strong> <a href="${escapeHtml(opts.annotationUrl)}">${escapeHtml(opts.annotationUrl)}</a></li>` : ''}
</ul>
<p><strong>Diff summary (first 10 lines):</strong></p>
<ul>${htmlLines}</ul>
`.trim()

  return { text: textBody, html: htmlBody, subject }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' :
    c === '<' ? '&lt;' :
    c === '>' ? '&gt;' :
    c === '"' ? '&quot;' :
    '&#39;')
}

/**
 * Send the PR-opened notification. Never throws.
 * Returns true if sent, false on missing-recipient or send failure.
 */
export async function notifyPrOpened(opts: NotifyPrOpts): Promise<boolean> {
  try {
    const to = resolveRecipient(opts)
    if (!to) {
      console.warn(`[revanote.notify-pr] no recipient configured (payload + env both unset); skipping. pr=${opts.prUrl}`)
      return false
    }
    const { text, html, subject } = buildBody(opts)
    const sent = await sendEmail({ to, subject, text, html })
    if (!sent) console.warn(`[revanote.notify-pr] sendEmail returned false for ${to}`)
    return sent
  } catch (err: any) {
    console.error(`[revanote.notify-pr] threw: ${err?.message ?? err}`)
    return false
  }
}

export const _internals = { buildBody, resolveRecipient, escapeHtml }
