// Phase 07-C / C.5: re-auth gate for elevated-impact mutating ops.
//
// Returns 401 `re_auth_required` if the current session is older than maxAge
// seconds (default 900 = 15min).
//
// Cookie sessions: keyed on `auth_sessions.created_at`.
// Legacy bearer JWTs: keyed on the JWT's `iat` claim (issued-at). Legacy
//   tokens are long-lived (30d), so `iat` reflects original login — a user
//   who needs to step up can log out + log in again to refresh iat.
//
// Apply to: api-keys create/delete, error-projects delete, account email
// change, error-project secret rotate. Plan C calls out the exact list.
//
// Window rationale: under Titanium magic-link auth (Phase 07), a fresh login
// IS the step-up — there is no password to re-enter. The 5-min default from
// the bcrypt era was too tight: a user who logged in, browsed for >5 min,
// then clicked "Rotate" got `re_auth_required` with no recovery path other
// than re-running the magic-link round-trip. 15 min matches typical session
// step-up windows (sudo TTL, banking) while still bounding the post-login
// elevated-write surface.
//
// Legacy-JWT note: BEFORE this fix, requireRecentAuth() rejected ALL legacy
// bearer JWT users with `no_cookie_session` 401 because they have no cookie
// session row. With ALLOW_LEGACY_LOGIN=true + TITANIUM_BYPASS=true (the
// current prod config 2026-05-27), every user is on the legacy path — so
// the gate was a hard block on api-key create/delete, error-project delete,
// and admin mutations. This commit reads the JWT's `iat` and treats it as
// the session creation timestamp so the gate behaves identically for both
// auth flavors during the soak. When ALLOW_LEGACY_LOGIN flips off, this
// branch becomes dead code.

import type { Context, Next } from 'hono';
import jwt from 'jsonwebtoken';
import { verifyAuthSessionCookie } from '../session';
import { config } from '../config';

export function requireRecentAuth(maxAgeSeconds: number = 900) {
  return async (c: Context, next: Next) => {
    // (a) cookie session path — preferred.
    const ctx = await verifyAuthSessionCookie(c);
    if (ctx) {
      const ageMs = Date.now() - new Date(ctx.sessionRow.created_at).getTime();
      if (ageMs > maxAgeSeconds * 1000) {
        return c.json({ error: 're_auth_required', max_age_seconds: maxAgeSeconds }, 401);
      }
      c.set('userId', ctx.userId);
      c.set('userEmail', ctx.user.email);
      c.set('userRole', ctx.user.role);
      return next();
    }

    // (b) legacy bearer JWT path — only when soak flag is on.
    if (config.allowLegacyLogin) {
      const header = c.req.header('Authorization');
      if (header?.startsWith('Bearer ')) {
        const token = header.slice(7);
        try {
          const payload = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] }) as any;
          const iat = typeof payload.iat === 'number' ? payload.iat : null;
          if (iat == null) {
            return c.json({ error: 're_auth_required', reason: 'legacy_token_missing_iat' }, 401);
          }
          const ageMs = Date.now() - iat * 1000;
          if (ageMs > maxAgeSeconds * 1000) {
            return c.json({ error: 're_auth_required', max_age_seconds: maxAgeSeconds, reason: 'legacy_token_stale' }, 401);
          }
          c.set('userId', payload.sub);
          c.set('userEmail', payload.email);
          c.set('userRole', payload.role);
          return next();
        } catch {
          return c.json({ error: 're_auth_required', reason: 'invalid_legacy_token' }, 401);
        }
      }
    }

    return c.json({ error: 're_auth_required', reason: 'no_cookie_session' }, 401);
  };
}
