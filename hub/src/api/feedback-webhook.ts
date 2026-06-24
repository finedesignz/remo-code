/**
 * End-user feedback intake (Option A).
 *
 * Public route: `POST /api/feedback/:token`. Mounted OUTSIDE the JWT / license /
 * CSRF catch-alls (`hub/src/index.ts`) — the URL `:token` IS the credential
 * (opaque `fb_` token, SHA-256-hashed lookup against `feedback_keys`), exactly
 * like the sentry / revanote public webhooks.
 *
 * Flow:
 *   1. Resolve `:token` → feedback key (hash lookup; 404 on miss, 403 disabled).
 *   2. Validate JSON body: comment (required, ≤5000), screenshot? (base64
 *      data-URI, ≤~10MB raw), page_url?, console_errors? (≤20000).
 *   3. Build a repair message inlining the screenshot as an `images` attachment
 *      + the comment / page_url / console_errors as text.
 *   4. Dispatch into the bound session via the SHARED pipeline (cost-cap /
 *      threshold gates + spawn-on-error wake) — fire-and-forget.
 *   5. Respond 202 { ok, status }.
 *
 * ── THREAT MODEL (this is a PUBLIC, unauthenticated-by-design endpoint that
 *    triggers LLM work — read before changing) ──────────────────────────────
 *   The submit token is unguessable (256-bit opaque, hashed at rest), so a
 *   random attacker cannot reach a session. BUT a token is, by design, embedded
 *   in a public web widget — it WILL leak (view-source). The leak is bounded by:
 *
 *   - COST CAP (primary, non-bypassable): every dispatch flows through
 *     `dailyCostCapGate`. Once the owning user's real accumulated token cost for
 *     today hits their cap, ALL feedback dispatches return skipped — a flood
 *     cannot run up an unbounded bill. This is the load-bearing control.
 *   - RATE LIMIT (bound request volume BEFORE the LLM): per-token AND per-IP
 *     windows (`rateLimitMulti`). A flood from one IP, or against one token,
 *     trips 429 long before the cost cap, so most abuse never reaches dispatch.
 *   - SIZE CAPS: comment ≤5000, screenshot ≤~10MB (the existing attachment
 *     ceiling), console_errors ≤20000 — reject oversized payloads with 413/400
 *     so a single request can't be a memory/bandwidth DoS.
 *   - DISABLED KEY: `enabled=false` → 403, so a leaked token is instantly
 *     revocable without deleting it.
 *   - NO UNBOUNDED SPAWN: dispatch's spawn-on-error path has a per-session
 *     in-flight lock + the hub-authoritative concurrency reservation, and the
 *     per-session queue admits exactly one waiter — a flood can't spawn N
 *     sessions or pile up N runs on one session.
 *
 *   Residual risk: a leaked token lets anyone inject a feedback message into the
 *   owner's session (within rate + cost bounds). That is the intended trust
 *   model (the widget is public); rotate the key (mint new, disable old) if a
 *   token is being abused at the message-content level.
 */
import { Hono } from 'hono'
import { resolveFeedbackKey } from '../db/feedback-dal.ts'
import { dispatchFeedback, type FeedbackSubmission } from '../feedback/dispatcher.ts'
import { sourceIpFromHeaders } from '../lib/cidr.ts'
import { randomBytes } from 'crypto'

export const feedbackWebhookRoutes = new Hono()

// ── Hard size caps ───────────────────────────────────────────────────────────
const COMMENT_MAX = 5_000
const CONSOLE_MAX = 20_000
const PAGE_URL_MAX = 2_048
// ~10MB raw decoded image — matches the existing WS attachment ceiling. The
// base64 string is ~4/3 the raw size, so cap the encoded length accordingly.
const SCREENSHOT_RAW_MAX = 10 * 1024 * 1024
const SCREENSHOT_B64_MAX = Math.ceil(SCREENSHOT_RAW_MAX * 4 / 3) + 16
// Whole-request ceiling (screenshot b64 + comment + console_errors + JSON
// overhead) — checked against Content-Length before buffering the body.
const BODY_MAX = SCREENSHOT_B64_MAX + COMMENT_MAX + CONSOLE_MAX + PAGE_URL_MAX + 4_096

// data:<media_type>;base64,<data>
const DATA_URI_RE = /^data:([a-z]+\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/i
const ALLOWED_IMAGE_TYPES = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp',
])

feedbackWebhookRoutes.post('/:token', async (c) => {
  const token = c.req.param('token')

  // 1. Resolve the key. Hash lookup — miss → 404 (route exists, token unknown).
  const key = await resolveFeedbackKey(token)
  if (!key) return c.json({ error: 'not_found' }, 404)
  if (!key.enabled) return c.json({ error: 'key_disabled' }, 403)

  // 2. Size gate BEFORE buffering (LOW-1): reject oversized payloads on the
  //    declared Content-Length so we never read + hold 2-3× a >10MB body. The
  //    per-field caps below still re-check the actual decoded sizes.
  const declaredLen = Number(c.req.header('content-length') ?? '0')
  if (Number.isFinite(declaredLen) && declaredLen > BODY_MAX) {
    return c.json({ error: 'payload_too_large', max_bytes: BODY_MAX }, 413)
  }

  // Parse + validate the body. Standard JSON parse is fine: auth is the URL
  // token, NOT an HMAC over the raw body, so there is no raw-body invariant.
  let body: any
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'bad_json' }, 400)
  }

  const comment = typeof body?.comment === 'string' ? body.comment.trim() : ''
  if (!comment) return c.json({ error: 'comment_required' }, 400)
  if (comment.length > COMMENT_MAX) {
    return c.json({ error: 'comment_too_large', max: COMMENT_MAX }, 413)
  }

  const page_url =
    typeof body?.page_url === 'string' ? body.page_url.slice(0, PAGE_URL_MAX) : null

  let console_errors: string | null = null
  if (typeof body?.console_errors === 'string') {
    if (body.console_errors.length > CONSOLE_MAX) {
      return c.json({ error: 'console_errors_too_large', max: CONSOLE_MAX }, 413)
    }
    console_errors = body.console_errors
  }

  // Screenshot: optional base64 data-URI. Validate shape + media type + size.
  let screenshot: { media_type: string; data: string } | null = null
  if (body?.screenshot != null) {
    if (typeof body.screenshot !== 'string') {
      return c.json({ error: 'screenshot_invalid' }, 400)
    }
    if (body.screenshot.length > SCREENSHOT_B64_MAX) {
      return c.json({ error: 'screenshot_too_large', max_bytes: SCREENSHOT_RAW_MAX }, 413)
    }
    const m = DATA_URI_RE.exec(body.screenshot)
    if (!m) return c.json({ error: 'screenshot_invalid' }, 400)
    const media_type = m[1].toLowerCase()
    if (!ALLOWED_IMAGE_TYPES.has(media_type)) {
      return c.json({ error: 'screenshot_unsupported_type' }, 400)
    }
    screenshot = { media_type, data: m[2] }
  }

  const sub: FeedbackSubmission = {
    submissionId: 'fbk_' + randomBytes(12).toString('base64url'),
    userId: key.user_id,
    sessionId: key.session_id,
    comment,
    screenshot,
    page_url,
    console_errors,
    label: key.label,
  }

  // 3. Dispatch fire-and-forget. Cost-cap / threshold / queue / spawn-on-error
  //    all enforced inside dispatch(); we never block the POST on agent work.
  void dispatchFeedback(sub).catch((err: any) => {
    console.warn(
      `[feedback-webhook] dispatch failed session=${key.session_id} ip=${sourceIpFromHeaders(c.req.raw.headers)}: ${err?.message ?? err}`,
    )
  })

  return c.json({ ok: true, status: 'accepted' }, 202)
})
