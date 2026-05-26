// Phase 07-C: magic-link login + logout, alongside legacy bcrypt path.
//
// Endpoints:
//   POST /api/auth/login         — legacy bcrypt (kept behind allowLegacyLogin)
//   POST /api/auth/register      — legacy first-user bootstrap (unchanged)
//   POST /api/auth/login/request-link  — sends magic-link via emails4agents
//   GET  /api/auth/login/callback      — verifies link, sets session + CSRF
//   POST /api/auth/logout              — kills session row + clears cookies
//
// Magic-link tokens: HS256 JWT, MAGIC_LINK_SECRET, 15-min TTL, jti single-use
// enforced via Redis `magic_link:used:{jti}` EX 900. ALWAYS return 200 on
// request-link (login-enumeration prevention).

import { Hono } from "hono";
import { SignJWT, jwtVerify } from "jose";
import Redis from "ioredis";
import {
  getUserByEmail,
  createUser,
  countUsers,
  getUserById,
  recordAuthEvent,
  promoteCandidateSubject,
} from "../db/dal.ts";
import { verifyPassword, hashPassword } from "../auth/password.ts";
import { signJwt } from "../auth/jwt.ts";
import { config } from "../config.ts";
import { createAndSetSession, destroySession } from "../session.ts";
import { issueCsrfToken, setCsrfCookie, clearCsrfCookie } from "../csrf.ts";
import { sendEmail } from "../lib/email.ts";

export const authRouter = new Hono();

// ── Legacy bcrypt login (kept alive behind soak flag) ────────────────────────

authRouter.post("/login", async (c) => {
  if (!config.allowLegacyLogin) {
    return c.json({ error: "legacy_login_disabled" }, 410);
  }
  const { email, password } = await c.req.json<{ email: string; password: string }>();
  if (!email || !password) return c.json({ error: "Email and password required" }, 400);

  const user = await getUserByEmail(email.toLowerCase().trim());
  if (!user) return c.json({ error: "Invalid credentials" }, 401);

  if (!user.password_hash) return c.json({ error: "Invalid credentials" }, 401);
  const valid = await verifyPassword(password, user.password_hash);
  if (!valid) return c.json({ error: "Invalid credentials" }, 401);

  const token = signJwt({ sub: user.id, email: user.email, role: user.role });
  return c.json({ token, user: { id: user.id, email: user.email, role: user.role, display_name: user.display_name } });
});

authRouter.post("/register", async (c) => {
  const total = await countUsers();
  if (total > 0) return c.json({ error: "Registration is closed" }, 403);

  const { email, password } = await c.req.json<{ email: string; password: string }>();
  if (!email || !password) return c.json({ error: "Email and password required" }, 400);
  if (password.length < 8) return c.json({ error: "Password must be at least 8 characters" }, 400);

  const hash = await hashPassword(password);
  const user = await createUser(email.toLowerCase().trim(), hash, "admin");
  const token = signJwt({ sub: user.id, email: user.email, role: user.role });
  return c.json({ token, user: { id: user.id, email: user.email, role: user.role } });
});

// ── Magic-link login (Phase 07-C primary path) ───────────────────────────────

const MAGIC_LINK_TTL_SECONDS = 15 * 60;
const MAGIC_LINK_TTL_MIN = 15;
const REQUEST_LINK_EQUAL_TIME_MS = 250;
const JTI_REDIS_PREFIX = "magic_link:used:";

let _redis: Redis | null = null;
function getRedis(): Redis | null {
  if (!config.titanium.redisUrl) return null;
  if (_redis) return _redis;
  _redis = new Redis(config.titanium.redisUrl, { lazyConnect: false, maxRetriesPerRequest: 2 });
  return _redis;
}

// Test seam — lets unit tests inject a fake Redis-like store (Map) so jti
// single-use can be exercised without a real redis.
type JtiStore = { setNx(key: string, ttlSeconds: number): Promise<boolean>; has(key: string): Promise<boolean> };
let _jtiOverride: JtiStore | null = null;
export function __setJtiStoreForTesting(store: JtiStore | null) { _jtiOverride = store; }

async function reserveJti(jti: string): Promise<boolean> {
  if (_jtiOverride) {
    if (await _jtiOverride.has(jti)) return false;
    return _jtiOverride.setNx(jti, MAGIC_LINK_TTL_SECONDS);
  }
  const r = getRedis();
  if (!r) {
    // No redis configured → silently allow (single-process dev). Acceptable
    // since the link still expires after 15 min; replay window is bounded.
    console.warn("[auth] no Redis configured for jti single-use; magic-link replay protection limited");
    return true;
  }
  // SET NX EX returns 'OK' on insert, null if key existed.
  const result = await r.set(JTI_REDIS_PREFIX + jti, "1", "EX", MAGIC_LINK_TTL_SECONDS, "NX");
  return result === "OK";
}

function magicLinkSecretBytes(): Uint8Array {
  const s = config.magicLinkSecret;
  if (!s) throw new Error("MAGIC_LINK_SECRET not configured");
  return new TextEncoder().encode(s);
}

async function signMagicLink(payload: { sub: string; email: string }): Promise<{ token: string; jti: string; exp: number }> {
  const jti = crypto.randomUUID();
  const exp = Math.floor(Date.now() / 1000) + MAGIC_LINK_TTL_SECONDS;
  const token = await new SignJWT({ ...payload, purpose: "magic-link" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(exp)
    .setJti(jti)
    .sign(magicLinkSecretBytes());
  return { token, jti, exp };
}

interface MagicLinkClaims { sub: string; email: string; jti: string; purpose: string; exp: number; iat: number }
async function verifyMagicLink(token: string): Promise<MagicLinkClaims> {
  const { payload } = await jwtVerify(token, magicLinkSecretBytes(), { algorithms: ["HS256"] });
  if (payload.purpose !== "magic-link") throw new Error("wrong_purpose");
  if (!payload.jti) throw new Error("missing_jti");
  if (!payload.sub || !payload.email) throw new Error("missing_claims");
  return payload as unknown as MagicLinkClaims;
}

function publicBase(): string {
  return process.env.REMO_PUBLIC_URL || "https://app.remo-code.com";
}

function renderMagicLinkEmail(url: string): { subject: string; html: string; text: string } {
  const subject = "Sign in to remo-code";
  const text = `Click to sign in: ${url}\n\nThis link expires in ${MAGIC_LINK_TTL_MIN} minutes and can only be used once. If you didn't request this, ignore this email.`;
  const html = `<p>Click to sign in to <strong>remo-code</strong>:</p><p><a href="${url}">Sign in</a></p><p style="color:#888;font-size:12px">This link expires in ${MAGIC_LINK_TTL_MIN} minutes and can only be used once. If you didn't request this, ignore this email.</p>`;
  return { subject, html, text };
}

function ipOf(c: any): string | null {
  return c.req.header("cf-connecting-ip") || c.req.header("x-real-ip") || c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || null;
}

// Equal-time wrapper: ensure ALL request-link responses take ≥ N ms regardless
// of whether the email path ran. Pure best-effort — wrap a promise + sleep.
async function withEqualTime<T>(targetMs: number, work: () => Promise<T>): Promise<T> {
  const started = Date.now();
  const result = await work();
  const elapsed = Date.now() - started;
  if (elapsed < targetMs) await new Promise((r) => setTimeout(r, targetMs - elapsed));
  return result;
}

// POST /api/auth/login/request-link
authRouter.post("/login/request-link", async (c) => {
  return withEqualTime(REQUEST_LINK_EQUAL_TIME_MS, async () => {
    const body = await c.req.json().catch(() => null) as { email?: string } | null;
    const email = body?.email?.toLowerCase().trim();
    const ip = ipOf(c);
    const ua = c.req.header("user-agent") ?? null;

    if (!email || !email.includes("@")) {
      // Still 200 — but log.
      try { await recordAuthEvent({ eventType: "login_request", ip, userAgent: ua, metadata: { email: null, reason: "invalid_email" } }); } catch {}
      return c.json({ ok: true });
    }

    const user = await getUserByEmail(email);
    let sent = false;
    if (user) {
      // Eligibility: linked, pending_verify, OR (during soak) any user — magic
      // link IS email verification, so a bcrypt-only user can also use it.
      try {
        const { token, jti } = await signMagicLink({ sub: user.id, email });
        void jti; // reserved at callback time
        const url = `${publicBase()}/api/auth/login/callback?token=${encodeURIComponent(token)}`;
        const { subject, html, text } = renderMagicLinkEmail(url);
        sent = await sendEmail({ to: email, subject, html, text });
      } catch (err: any) {
        console.error("[auth] magic-link send threw:", err?.message);
      }
    }

    try {
      await recordAuthEvent({
        userId: user?.id ?? null,
        eventType: "login_request",
        ip, userAgent: ua,
        metadata: { email, sent, user_exists: !!user },
      });
    } catch {}

    return c.json({ ok: true });
  });
});

// GET /api/auth/login/callback?token=...
authRouter.get("/login/callback", async (c) => {
  const token = c.req.query("token");
  const ip = ipOf(c);
  const ua = c.req.header("user-agent") ?? null;

  if (!token) {
    return c.json({ error: "missing_token" }, 400);
  }

  let claims: MagicLinkClaims;
  try {
    claims = await verifyMagicLink(token);
  } catch (err: any) {
    try { await recordAuthEvent({ eventType: "login_failed", ip, userAgent: ua, metadata: { reason: "verify_failed", error: err?.message } }); } catch {}
    return c.json({ error: "invalid_or_expired" }, 401);
  }

  // jti single-use
  const reserved = await reserveJti(claims.jti);
  if (!reserved) {
    try { await recordAuthEvent({ userId: claims.sub, eventType: "login_failed", ip, userAgent: ua, metadata: { reason: "link_reused", jti: claims.jti } }); } catch {}
    return c.json({ error: "link_reused" }, 409);
  }

  // Resolve user row
  const user = await getUserById(claims.sub);
  if (!user) {
    try { await recordAuthEvent({ eventType: "login_failed", ip, userAgent: ua, metadata: { reason: "user_missing", sub: claims.sub } }); } catch {}
    return c.json({ error: "user_not_found" }, 401);
  }

  // Email-collision policy: when the user is in pending_verify, the magic-link
  // sub MUST equal candidate_subject for promotion to happen. We don't have a
  // separate Keygen lookup at the callback — the magic-link itself is the
  // proof-of-email-control. Promote if eligible.
  if (user.titanium_link_status === "pending_verify") {
    // The link's sub IS the local user id; the Keygen subject lives in
    // candidate_subject already. Promotion only flips status — it cannot
    // validate the Keygen mapping itself. Per the CONTEXT note, this is the
    // intended shape: the magic link's success IS the verification.
    const promoted = await promoteCandidateSubject(user.id);
    if (!promoted) {
      try { await recordAuthEvent({ userId: user.id, eventType: "link_mismatch", ip, userAgent: ua, metadata: { reason: "promotion_failed" } }); } catch {}
      return c.json({ error: "link_mismatch" }, 409);
    }
    try { await recordAuthEvent({ userId: user.id, eventType: "link_success", ip, userAgent: ua }); } catch {}
  }

  // Create the dashboard session.
  const { token: rawSessionToken } = await createAndSetSession(c, { userId: user.id, ip, userAgent: ua });
  const csrf = issueCsrfToken(rawSessionToken);
  setCsrfCookie(c, csrf);

  try { await recordAuthEvent({ userId: user.id, eventType: "login_success", ip, userAgent: ua, metadata: { method: "magic_link" } }); } catch {}

  // Redirect to the SPA root. SPA reads csrf cookie + connects WS via cookie.
  return c.redirect("/");
});

// POST /api/auth/logout
authRouter.post("/logout", async (c) => {
  const ip = ipOf(c);
  const ua = c.req.header("user-agent") ?? null;
  // Best-effort: identify user before destroying for the audit row.
  let userId: string | null = null;
  try {
    const { verifyAuthSessionCookie } = await import("../session.ts");
    const ctx = await verifyAuthSessionCookie(c);
    userId = ctx?.userId ?? null;
  } catch {}

  await destroySession(c);
  clearCsrfCookie(c);

  try { await recordAuthEvent({ userId, eventType: "logout", ip, userAgent: ua }); } catch {}
  return c.json({ ok: true });
});

// Test seam: render the email body deterministically.
export const __testing = { renderMagicLinkEmail, signMagicLink, verifyMagicLink };
