/**
 * POST /api/cloud-hook/reply — public webhook for claude.ai cloud-session Stop hooks.
 *
 * Auth: `Authorization: Bearer <api key>` whose scopes EXPLICITLY include
 * `cloud:hook` (hasExplicitScope — a legacy NULL-scopes key does NOT qualify).
 * Mounted BEFORE the /api/* JWT catch-all (MOUNT-ORDER INVARIANT (1), index.ts).
 * See docs/cloud-sessions.md.
 */
import { Hono } from 'hono'
import { z } from 'zod'
import { hashToken } from '../lib/crypto'
import { verifyApiKeyFull } from '../db/dal'
import { hasExplicitScope, SCOPE_CLOUD_HOOK } from '../auth/scopes'
import { isCloudSessionId } from '../db/cloud-sessions-dal.ts'
import { ingestCloudReply } from '../cloud/ingest.ts'

export const CLOUD_REPLY_MAX_CHARS = 200_000
const MAX_BODY_BYTES = 512 * 1024

const tokenCount = z.number().int().nonnegative().max(1_000_000_000).optional()

export const CloudReplyBody = z.object({
  cloud_session_id: z.string().refine(isCloudSessionId, 'invalid cloud_session_id'),
  text: z.string().min(1).max(CLOUD_REPLY_MAX_CHARS),
  model: z.string().max(100).nullish(),
  usage: z
    .object({
      input_tokens: tokenCount,
      output_tokens: tokenCount,
      cache_creation_input_tokens: tokenCount,
      cache_read_input_tokens: tokenCount,
    })
    .nullish(),
})

const cloudHook = new Hono()

cloudHook.post('/reply', async (c) => {
  const auth = c.req.header('Authorization') ?? ''
  const rawKey = auth.startsWith('Bearer ') ? auth.slice(7).trim() : ''
  if (!/^(remokey_|remo_)[A-Za-z0-9_-]+$/.test(rawKey)) return c.json({ error: 'unauthorized' }, 401)

  // FAIL CLOSED: a lookup failure never authenticates.
  let key: Awaited<ReturnType<typeof verifyApiKeyFull>> = null
  try {
    key = await verifyApiKeyFull(await hashToken(rawKey))
  } catch (err: any) {
    console.warn(`[cloud-hook] key lookup failed: ${err?.message ?? err}`)
    return c.json({ error: 'unauthorized' }, 401)
  }
  if (!key) return c.json({ error: 'unauthorized' }, 401)
  if (!hasExplicitScope(key.scopes, SCOPE_CLOUD_HOOK)) {
    return c.json({ error: 'insufficient_scope', required: SCOPE_CLOUD_HOOK }, 403)
  }

  const raw = await c.req.text()
  if (raw.length > MAX_BODY_BYTES) return c.json({ error: 'payload_too_large' }, 413)
  let json: unknown
  try { json = JSON.parse(raw) } catch { return c.json({ error: 'invalid_json' }, 400) }
  const parsed = CloudReplyBody.safeParse(json)
  if (!parsed.success) return c.json({ error: 'invalid_body' }, 400)

  const r = await ingestCloudReply({
    userId: key.user_id,
    cloudSessionId: parsed.data.cloud_session_id,
    text: parsed.data.text,
    model: parsed.data.model ?? null,
    usage: parsed.data.usage ?? null,
  })
  return c.json({ ok: true, session_id: r.sessionId, message_id: r.messageId, linked: r.linked }, 202)
})

export default cloudHook
