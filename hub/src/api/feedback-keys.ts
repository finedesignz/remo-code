/**
 * Authed management router for feedback keys (Option A).
 *
 * Mounted at `/api/feedback-keys` behind the JWT `authMiddleware` (userId from
 * the Hono context). Lets a user mint ONE submit token per app (bound to a
 * session), list their keys (hashes only — never the plaintext), and
 * enable/disable (revoke) a key.
 *
 * The plaintext `fb_` token is returned EXACTLY ONCE from POST — it is the
 * value embedded in the public widget. It is unrecoverable afterwards (only the
 * SHA-256 hash is stored); to rotate, mint a new key and disable the old.
 */
import { Hono } from 'hono'
import { z } from 'zod'
import {
  createFeedbackKey,
  listFeedbackKeys,
  setFeedbackKeyEnabled,
} from '../db/feedback-dal.ts'

export const feedbackKeys = new Hono()

const CreateBody = z.object({
  session_id: z.string().min(1),
  label: z.string().max(120).optional(),
})

// GET / → { keys: [{ token_hash, session_id, label, enabled, created_at }] }
feedbackKeys.get('/', async (c) => {
  const userId = c.get('userId') as string
  const keys = await listFeedbackKeys(userId)
  return c.json({ keys })
})

// POST / → { token, token_hash } — token shown ONCE.
feedbackKeys.post('/', async (c) => {
  const userId = c.get('userId') as string
  let body: any
  try { body = await c.req.json() } catch { return c.json({ error: 'bad_json' }, 400) }
  const parsed = CreateBody.safeParse(body)
  if (!parsed.success) return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400)
  const { session_id, label } = parsed.data
  const { token, token_hash } = await createFeedbackKey(session_id, userId, label ?? null)
  return c.json({ token, token_hash }, 201)
})

// PATCH /:token_hash → { enabled } toggle. 404 if not the user's key.
feedbackKeys.patch('/:token_hash', async (c) => {
  const userId = c.get('userId') as string
  const tokenHash = c.req.param('token_hash')
  let body: any
  try { body = await c.req.json() } catch { return c.json({ error: 'bad_json' }, 400) }
  if (typeof body?.enabled !== 'boolean') return c.json({ error: 'enabled_required' }, 400)
  const ok = await setFeedbackKeyEnabled(userId, tokenHash, body.enabled)
  if (!ok) return c.json({ error: 'not_found' }, 404)
  return c.json({ ok: true, enabled: body.enabled })
})
