/**
 * Webhook post-run action (W2/T8.6).
 *
 * POST JSON to user-supplied URL with X-Remo-Signature: sha256=<hmac>.
 * Signing key is the user's active API key hash (getSigningKeyForUser).
 * 5s timeout, single retry on network/5xx. Log-only on failure.
 */
import { createHmac } from 'node:crypto'
import type { PostRunAction } from './schema.ts'
import { getSigningKeyForUser } from '../../db/scheduled-tasks-dal.ts'

interface WebhookCtx { userId: string; payload: Record<string, unknown> }

function sign(body: string, key: string): string {
  return 'sha256=' + createHmac('sha256', key).update(body).digest('hex')
}

async function postOnce(url: string, body: string, sig: string, timeoutMs: number) {
  return fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Remo-Signature': sig,
      'User-Agent': 'remo-code-webhook/1',
    },
    body,
    signal: AbortSignal.timeout(timeoutMs),
  })
}

export async function executeWebhook(action: PostRunAction, ctx: WebhookCtx): Promise<void> {
  if (action.type !== 'webhook') return
  const url = action.config.url
  if (!url) return

  const body = JSON.stringify(ctx.payload)
  const key = await getSigningKeyForUser(ctx.userId)
  if (!key) {
    console.warn(`[post-run.webhook] user=${ctx.userId} has no active api key; skipping`)
    return
  }
  const sig = sign(body, key)

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await postOnce(url, body, sig, 5_000)
      if (res.ok) return
      if (res.status < 500 || attempt === 1) {
        console.warn(`[post-run.webhook] ${url} failed status=${res.status}`)
        return
      }
    } catch (err: any) {
      if (attempt === 1) {
        console.warn(`[post-run.webhook] ${url} threw: ${err?.message}`)
        return
      }
    }
  }
}
