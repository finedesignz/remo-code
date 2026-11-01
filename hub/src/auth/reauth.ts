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
// Window rationale: under Titanium hosted-login auth, a fresh login
// IS the step-up — there is no password to re-enter. The 5-min default from
// the old password-era window was too tight: a user who logged in, browsed for >5 min,
// then clicked "Rotate" got `re_auth_required` with no recovery path other
// than re-running the hosted login. 15 min matches typical session
// step-up windows (sudo TTL, banking) while still bounding the post-login
// elevated-write surface.

import type { Context, Next } from 'hono';
import { verifyAuthSessionCookie } from '../session';
import { isSettingsApiKeyRequest } from './settings-api-key';

export function requireRecentAuth(maxAgeSeconds: number = 900) {
  return async (c: Context, next: Next) => {
    // A settings-scoped api key on an allowlisted settings route was already
    // authenticated + scope-checked by authMiddleware. The key itself was minted
    // behind this same step-up, so it stands in for a fresh login here. Any other
    // path (api-keys, admin, …) never gets this pass.
    if (isSettingsApiKeyRequest(c)) return next();

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

    return c.json({ error: 're_auth_required', reason: 'no_cookie_session' }, 401);
  };
}
