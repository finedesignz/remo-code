// Phase 07-C / C.5: re-auth gate for elevated-impact mutating ops.
//
// Returns 401 `re_auth_required` if the current session is older than maxAge
// seconds (default 300 = 5min). Requires a cookie-based session — legacy bearer
// JWTs cannot satisfy re-auth (no creation timestamp).
//
// Apply to: api-keys create/delete, error-projects delete, account email
// change, error-project secret rotate. Plan C calls out the exact list.

import type { Context, Next } from 'hono';
import { verifyAuthSessionCookie } from '../session';

export function requireRecentAuth(maxAgeSeconds: number = 300) {
  return async (c: Context, next: Next) => {
    const ctx = await verifyAuthSessionCookie(c);
    if (!ctx) {
      return c.json({ error: 're_auth_required', reason: 'no_cookie_session' }, 401);
    }
    const ageMs = Date.now() - new Date(ctx.sessionRow.created_at).getTime();
    if (ageMs > maxAgeSeconds * 1000) {
      return c.json({ error: 're_auth_required', max_age_seconds: maxAgeSeconds }, 401);
    }
    // Re-set context vars in case caller skipped the outer authMiddleware.
    c.set('userId', ctx.userId);
    c.set('userEmail', ctx.user.email);
    c.set('userRole', ctx.user.role);
    return next();
  };
}
