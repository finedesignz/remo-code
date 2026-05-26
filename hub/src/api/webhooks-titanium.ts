/**
 * Phase 07-D: Optional Titanium → hub webhook for `license.changed`.
 *
 * Public route (mounted OUTSIDE the JWT catch-all). Auth is HMAC-SHA256 over
 * `${X-Titanium-Timestamp}.${rawBody}` against the shared `TITANIUM_WEBHOOK_SECRET`.
 *
 * Pattern lifted from `hub/src/api/coolify-webhook.ts`:
 *   1. Read raw body BEFORE any JSON parse (HMAC needs exact bytes).
 *   2. Reject if signature/timestamp headers missing.
 *   3. Reject if timestamp skew > 5 minutes.
 *   4. Constant-time compare signature against expected.
 *   5. Zod-validate payload, lookup user by `titanium_subject`, persist new
 *      license state, emit auth_events.
 *
 * Per CONTEXT, this receiver is OPTIONAL — Titanium does not currently ship
 * the webhook (per upstream research). When `TITANIUM_WEBHOOK_SECRET` is
 * unset the route returns 503 `webhook_disabled` so external callers can
 * detect the inert state without HMAC noise.
 */
import { Hono } from "hono";
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { config } from "../config";
import {
  getUserByTitaniumSubject,
  updateLicenseStatus,
  recordAuthEvent,
} from "../db/dal";

export const webhooksTitanium = new Hono();

const SKEW_SECONDS = 300;

const LicenseChangedPayload = z.object({
  subject: z.string().min(1),
  license_status: z.string().min(1),
  license_id: z.string().min(1).nullable().optional(),
});

function constantTimeEqualStr(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

webhooksTitanium.post("/license-changed", async (c) => {
  // (0) Inert mode — no secret provisioned yet.
  const secret = config.titaniumWebhookSecret;
  if (!secret) {
    return c.json({ error: "webhook_disabled" }, 503);
  }

  // (1) Raw body — MUST be read before any JSON parse.
  const rawBody = await c.req.text();

  // (2) Required headers.
  const sigHeader = c.req.header("x-titanium-signature");
  const tsHeader = c.req.header("x-titanium-timestamp");
  if (!sigHeader || !tsHeader) {
    return c.json({ error: "missing_signature" }, 401);
  }

  // (3) Skew check.
  const ts = Number(tsHeader);
  if (!Number.isFinite(ts)) {
    return c.json({ error: "bad_timestamp" }, 401);
  }
  const nowSec = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - ts) > SKEW_SECONDS) {
    return c.json({ error: "stale_timestamp" }, 401);
  }

  // (4) HMAC verify with constant-time compare.
  const expected =
    "sha256=" +
    createHmac("sha256", secret).update(`${ts}.${rawBody}`).digest("hex");
  if (!constantTimeEqualStr(sigHeader, expected)) {
    return c.json({ error: "bad_signature" }, 401);
  }

  // (5) Payload validation.
  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(rawBody);
  } catch {
    return c.json({ error: "bad_json" }, 400);
  }
  const result = LicenseChangedPayload.safeParse(parsedBody);
  if (!result.success) {
    return c.json({ error: "bad_payload", issues: result.error.issues }, 400);
  }
  const { subject, license_status, license_id } = result.data;

  // Look up the local user by titanium_subject. If missing → 200 with a noop
  // body so Titanium does not retry. We log it for the audit log.
  const user = await getUserByTitaniumSubject(subject);
  if (!user) {
    try {
      await recordAuthEvent({
        userId: null,
        eventType: "license_check_failed",
        metadata: { reason: "unknown_subject", subject, license_status },
      });
    } catch {}
    return c.json({ ok: true, noop: "unknown_subject" }, 200);
  }

  await updateLicenseStatus(user.id, license_status, license_id ?? null);
  try {
    await recordAuthEvent({
      userId: user.id,
      eventType: "license_check_failed",
      metadata: { reason: "webhook_update", license_status, license_id: license_id ?? null },
    });
  } catch {}

  return c.json({ ok: true }, 200);
});
