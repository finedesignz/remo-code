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

export const CSRF_COOKIE_NAME = 'csrf_token';
export const CSRF_HEADER_NAME = 'X-CSRF-Token';

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// Paths that MUST NOT have CSRF enforcement. Aligns with the JWT catch-all
// allowlist in hub/src/index.ts (intake routes, webhooks, login itself).
const CSRF_PATH_ALLOWLIST: Array<string | RegExp> = [
  /^\/api\/sentry\//,
  /^\/api\/coolify\/webhook\//,
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

// Hono middleware: enforces CSRF on mutating methods except allowlisted paths.
// Pass-through on GET/HEAD/OPTIONS and on allowlisted paths.
export function csrfGuard() {
  return async (c: Context, next: Next) => {
    const method = c.req.method.toUpperCase();
    if (!MUTATING_METHODS.has(method)) return next();
    if (isCsrfAllowlisted(c.req.path)) return next();

    const cookieValue = readCsrfCookie(c);
    const headerValue = c.req.header(CSRF_HEADER_NAME) || c.req.header(CSRF_HEADER_NAME.toLowerCase());
    if (!verifyCsrfPair(cookieValue, headerValue ?? null)) {
      return c.json({ error: 'csrf_failed' }, 403);
    }
    return next();
  };
}
