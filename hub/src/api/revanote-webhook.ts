/**
 * Revanote annotation webhook ingress (Phase 08).
 *
 * Public route: `POST /api/revanote/webhook/:user_id/:token`. Mounted
 * OUTSIDE the JWT/license/CSRF catch-alls (`hub/src/index.ts`).
 *
 * Auth pipeline:
 *   1. Constant-time compare URL token against `users.revanote_webhook_secret`.
 *   2. `X-Revuu-Signature: sha256=<hex>` HMAC over the RAW request body using
 *      the same secret. Required when present (revanote always sets it; we
 *      still accept-and-mark when absent in the dev/test mode for revanote
 *      installations that haven't enabled signing yet — controlled by
 *      `users.revanote_require_hmac` if/when we add that. For now, HMAC is
 *      ENFORCED when the header is present and OPTIONAL otherwise.).
 *   3. If `timestamp` is present in the body, enforce 5-min skew.
 *   4. Read raw body BEFORE `JSON.parse` (Hono `c.req.text()`).
 *
 * On accept: persist the annotation row, audit success, kick off the
 * dispatcher fire-and-forget, respond `202 { accepted: true, annotation_id }`.
 *
 * All auth-fails are audited (`auth_failed` / `hmac_failed`) without leaking
 * which check failed (uniform 401 response).
 */
import { Hono } from 'hono'
import { createHmac, timingSafeEqual } from 'node:crypto'
import {
  getUserRevanoteWebhookSecret,
  recordRevanoteWebhookAttempt,
  insertAnnotation,
  resolveRevanoteMappingForHost,
} from '../db/revanote-dal.ts'
import { RevanotePayload } from '../revanote/payload-schema.ts'
import { dispatchAnnotationRow, previewComment } from '../revanote/dispatcher.ts'
import { broadcastRevanoteEvent } from '../ws/registry.ts'
import { sourceIpFromHeaders } from '../lib/cidr.ts'

export const revanoteWebhookRoutes = new Hono()

const SKEW_SECONDS = 300

function constantTimeEqualStr(a: string, b: string): boolean {
  const aBuf = Buffer.from(a)
  const bBuf = Buffer.from(b)
  if (aBuf.length !== bBuf.length) return false
  return timingSafeEqual(aBuf, bBuf)
}

async function logAttempt(
  userId: string,
  sourceIp: string | null,
  eventType: string | null,
  status: Parameters<typeof recordRevanoteWebhookAttempt>[0]['status'],
  reason: string | null,
  rawBodyPreview: string | null,
): Promise<void> {
  try {
    await recordRevanoteWebhookAttempt({
      user_id: userId, source_ip: sourceIp, event_type: eventType,
      status, reason, raw_body_preview: rawBodyPreview,
    })
  } catch (err: any) {
    console.warn('[revanote-webhook] audit log failed:', err?.message)
  }
}

function hostOf(pageUrl: string): string {
  try { return new URL(pageUrl).host } catch { return '' }
}

revanoteWebhookRoutes.post('/webhook/:user_id/:token', async (c) => {
  const userId = c.req.param('user_id')
  const token = c.req.param('token')
  const rawBody = await c.req.text()
  const sourceIp = sourceIpFromHeaders({ get: (n: string) => c.req.header(n) ?? null })
  const preview = rawBody.slice(0, 500)

  // (1) URL-token auth.
  const secret = await getUserRevanoteWebhookSecret(userId).catch(() => null)
  const expected = secret ?? '00000000-0000-0000-0000-000000000000'
  const tokenOk = constantTimeEqualStr(token, expected)
  if (!secret || !tokenOk) {
    await logAttempt(
      userId, sourceIp, null, 'auth_failed',
      secret ? 'token_mismatch' : 'webhook_not_configured', preview,
    )
    return c.json({ error: 'unauthorized' }, 401)
  }

  // (2) Optional HMAC layer — enforced when the header is present.
  const sigHeader = c.req.header('x-revuu-signature') ?? c.req.header('x-revanote-signature')
  if (sigHeader) {
    const expectedSig =
      'sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex')
    if (!constantTimeEqualStr(sigHeader, expectedSig)) {
      await logAttempt(userId, sourceIp, null, 'hmac_failed', 'bad_signature', preview)
      return c.json({ error: 'unauthorized' }, 401)
    }
  }

  // (3) Validate payload.
  let parsedBody: unknown
  try { parsedBody = JSON.parse(rawBody) }
  catch {
    await logAttempt(userId, sourceIp, null, 'bad_payload', 'invalid_json', preview)
    return c.json({ error: 'bad_json' }, 400)
  }

  const result = RevanotePayload.safeParse(parsedBody)
  if (!result.success) {
    await logAttempt(
      userId, sourceIp, null, 'bad_payload', 'schema_validation_failed', preview,
    )
    return c.json({ error: 'bad_payload', issues: result.error.issues }, 400)
  }
  const payload = result.data

  // (4) Timestamp skew (best-effort — only when the field is present).
  if (typeof payload.timestamp === 'number' && Number.isFinite(payload.timestamp)) {
    const nowSec = Math.floor(Date.now() / 1000)
    if (Math.abs(nowSec - payload.timestamp) > SKEW_SECONDS) {
      await logAttempt(userId, sourceIp, null, 'auth_failed', 'stale_timestamp', preview)
      return c.json({ error: 'stale_timestamp' }, 401)
    }
  }

  // (5) Persist annotation (idempotent via UNIQUE on (user_id, annotation_id_external)).
  const replies = Array.isArray(payload.replies) ? payload.replies : []
  let ann
  try {
    ann = await insertAnnotation({
      user_id: userId,
      annotation_id_external: payload.annotation_id,
      page_url: payload.page_url,
      annotation_url: payload.annotation_url ?? null,
      screenshot_url: payload.screenshot_url ?? null,
      x: payload.x ?? null,
      y: payload.y ?? null,
      element_selector: payload.element_selector ?? null,
      comment: payload.comment,
      replies_json: replies,
      callback_url: payload.callback_url,
      mapping_id: null, // resolved during dispatch
      source_ip: sourceIp,
      payload_raw: payload,
    })
  } catch (err: any) {
    await logAttempt(userId, sourceIp, null, 'bad_payload', `insert_failed: ${err?.message}`, preview)
    return c.json({ error: 'persist_failed' }, 500)
  }

  // (6) Best-effort mapping pre-resolve (so the audit + broadcast carries it).
  try {
    const m = await resolveRevanoteMappingForHost(userId, hostOf(payload.page_url))
    if (m) {
      const { updateAnnotationStatus } = await import('../db/revanote-dal.ts')
      await updateAnnotationStatus(ann.id, ann.status, { mapping_id: m.id })
      ;(ann as any).mapping_id = m.id
    }
  } catch {}

  await logAttempt(
    userId, sourceIp, 'annotation', 'success',
    `annotation_id=${ann.id}`, preview,
  )

  // (7) Broadcast lifecycle event + kick dispatcher.
  broadcastRevanoteEvent(userId, {
    type: 'revanote_received',
    annotation_id: ann.id,
    annotation_id_external: ann.annotation_id_external,
    page_url: ann.page_url,
    comment_preview: payload.comment_preview ?? previewComment(payload.comment),
    received_at: ann.received_at,
  })

  void dispatchAnnotationRow(ann).catch((err: any) =>
    console.warn(`[revanote-webhook] dispatch failed: ${err?.message ?? err}`),
  )

  return c.json(
    { accepted: true, annotation_id: ann.id, annotation_id_external: ann.annotation_id_external },
    202,
  )
})
