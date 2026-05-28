// Phase 07-C: CSRF — double-submit cookie pattern.
//
// On login, server sets TWO cookies:
//   - __Host-remo_sid     (HttpOnly, server-only) — the session
//   - csrf_token          (NOT HttpOnly, JS-readable) — the CSRF nonce
//
// On every mutating REST call (POST/PUT/PATCH/DELETE), the browser must echo
// the CSRF cookie value in `X-CSRF-Token`. Server constant-time compares.
//
// Token derivation: HMAC-SHA256(SESSION_SECRET, sessionToken + ":" + random16),
// truncated to 32 hex chars. SessionSecret presence is enforced at module load.
// We bind the CSRF token to the session token so a leaked CSRF without a
// matching session cookie buys an attacker nothing.

import type { Context, Next } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { config } from './config';
import { readSessionCookie, verifyAuthSessionToken } from './session';

export const CSRF_COOKIE_NAME = 'csrf_token';
export const CSRF_HEADER_NAME = 'X-CSRF-Token';

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// Paths that MUST NOT have CSRF enforcement. Aligns with the JWT catch-all
// allowlist in hub/src/index.ts (intake routes, webhooks, login itself).
const CSRF_PATH_ALLOWLIST: Array<string | RegExp> = [
  /^\/api\/sentry\//,
  /^\/api\/coolify\/webhook\//,
  /^\/api\/revanote\/webhook\//,
  /^\/api\/telegram\/webhook\//,
  /^\/api\/auth\/login\//, // login itself gated by magic-link
  /^\/api\/auth\/logout$/, // logout reads cookie, kills it — no CSRF needed
  /^\/api\/github\/callback$/, // GitHub redirect
  /^\/api\/setup\b/, // first-user setup (pre-auth)
  /^\/api\/plugin\//, // api-key authed
  /^\/health$/,
];

export function isCsrfAllowlisted(path: string): boolean {
  for (const m of CSRF_PATH_ALLOWLIST) {
    if (typeof m === 'string') { if (path === m) return true; }
    else if (m.test(path)) return true;
  }
  return false;
}

export function issueCsrfToken(sessionToken: string): string {
  const secret = config.sessionSecret || 'session-secret-not-configured-fallback';
  const nonce = randomBytes(16).toString('hex');
  const hmac = createHmac('sha256', secret).update(`${sessionToken}:${nonce}`).digest('hex');
  return hmac.slice(0, 32);
}

export function setCsrfCookie(c: Context, token: string): void {
  setCookie(c, CSRF_COOKIE_NAME, token, {
    httpOnly: false, // JS reads it; that's the point
    secure: true,
    sameSite: 'Lax',
    path: '/',
    // Same lifetime ceiling as the session.
    maxAge: 7 * 24 * 60 * 60,
  });
}

export function clearCsrfCookie(c: Context): void {
  deleteCookie(c, CSRF_COOKIE_NAME, { path: '/', secure: true });
}

export function readCsrfCookie(c: Context): string | null {
  return getCookie(c, CSRF_COOKIE_NAME) ?? null;
}

function constantTimeEqualHex(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
  } catch {
    return false;
  }
}

// Direct verify — used by WS handler where there's no Hono context yet.
export function verifyCsrfPair(cookieValue: string | null, headerValue: string | null): boolean {
  if (!cookieValue || !headerValue) return false;
  return constantTimeEqualHex(cookieValue, headerValue);
}

// Bearer-auth bypass: matches `Authorization: Bearer <non-empty>` (case-insensitive
// scheme, any whitespace, any non-empty token). Empty/missing/non-Bearer schemes
// fall through to normal CSRF enforcement.
const BEARER_RE = /^Bearer\s+\S+/i;

// Hono middleware: enforces CSRF on mutating methods except allowlisted paths.
// Pass-through on GET/HEAD/OPTIONS and on allowlisted paths.
//
// Threat model for the Bearer bypass (legacy JWT auth path):
//   CSRF attacks exploit the browser's ambient-credential behavior — a victim
//   visits evil.com, evil.com triggers a cross-origin POST to app.remo-code.com,
//   and the BROWSER attaches the victim's cookies automatically. The attacker
//   never needs to read the cookie value; they just ride it.
//
//   The double-submit cookie pattern defends against this by requiring the
//   attacker to ALSO present the CSRF nonce in a header — which the browser
//   does NOT attach automatically; only same-origin JS that can read the
//   csrf_token cookie can echo it.
//
//   `Authorization: Bearer <token>` headers are NOT in the browser's
//   ambient-credential set. Browsers never attach them automatically — JS
//   must explicitly set the header on each request. Cross-origin JS on
//   evil.com cannot read the bearer token from app.remo-code.com's
//   localStorage (same-origin policy), so it cannot forge a Bearer-authed
//   request even if the user is logged in.
//
//   Therefore: a request that carries a Bearer token is, by construction,
//   not a CSRF-eligible request. The bypass is safe AND necessary — legacy
//   JWT-auth users never receive a csrf_token cookie (only the new
//   session-cookie auth issues one), so without this bypass every mutating
//   call from a legacy-auth client fails closed with 403.
//
//   Scope guardrails:
//     - ONLY Bearer scheme. Custom headers (X-Auth, etc.) do NOT qualify —
//       a CSRF attacker can set arbitrary custom headers via fetch() if CORS
//       allows it, so "presence of a custom header" is not a safe proxy.
//     - Empty `Authorization:` header does NOT bypass.
//     - Cookie-auth users continue to use double-submit. We do not loosen
//       enforcement for them.
export function csrfGuard() {
  return async (c: Context, next: Next) => {
    const method = c.req.method.toUpperCase();
    if (!MUTATING_METHODS.has(method)) return next();
    if (isCsrfAllowlisted(c.req.path)) return next();

    // Bearer-auth bypass — see threat model above.
    const authHeader = c.req.header('Authorization') || c.req.header('authorization');
    if (authHeader && BEARER_RE.test(authHeader)) return next();

    const cookieValue = readCsrfCookie(c);
    const headerValue = c.req.header(CSRF_HEADER_NAME) || c.req.header(CSRF_HEADER_NAME.toLowerCase());

    // Self-heal: cookie users can drift into a "valid `__Host-remo_sid` but
    // no `csrf_token` cookie" state when the csrf cookie expires, is cleared
    // by a privacy extension, or was never set (e.g. session created before
    // the double-submit pattern was added, then survived across deploys via
    // sliding-idle touch). Without this branch, the very next mutating call
    // (e.g. POST /api/account/coolify-webhook-secret/rotate) fails 403 and
    // there is NO client-side path to recover short of logout+login.
    //
    // This branch is safe to allow-through because:
    //   1. The session cookie itself is `SameSite=Lax` — browsers do NOT
    //      attach it on cross-site POST/PUT/PATCH/DELETE, so the CSRF
    //      attacker can't even reach this code path with a valid session.
    //   2. We verify the session token against the DAL row (idle/expiry/
    //      user-exists checks all pass) before issuing — a forged/stale
    //      session cookie never gets self-healed.
    //   3. We re-issue a fresh `csrf_token` cookie in the same response so
    //      subsequent requests use the normal double-submit path again.
    if (!cookieValue) {
      const sessionToken = readSessionCookie(c);
      if (sessionToken) {
        try {
          const sessionCtx = await verifyAuthSessionToken(sessionToken);
          if (sessionCtx) {
            const fresh = issueCsrfToken(sessionToken);
            setCsrfCookie(c, fresh);
            return next();
          }
        } catch {
          // DB unavailable or transient — fall through to normal 403.
          // Self-heal is a best-effort recovery; never let it mask a real
          // CSRF rejection or crash on infra issues.
        }
      }
    }

    if (!verifyCsrfPair(cookieValue, headerValue ?? null)) {
      return c.json({ error: 'csrf_failed' }, 403);
    }
    return next();
  };
}
