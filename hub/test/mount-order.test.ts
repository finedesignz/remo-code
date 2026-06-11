/**
 * Phase 3 (hub-deepening C6) — Mount-order assertion + ordering-invariant guard.
 *
 * This test boots the REAL Hono `app` exported by `hub/src/index.ts` (no DB, no
 * Bun.serve — the boot side-effects are guarded by `import.meta.main`, which is
 * false on import) and asserts the load-bearing mount/middleware ordering that
 * the consolidated INVARIANT block at the top of `index.ts` documents.
 *
 * IR-8: webhook-before-JWT mount order is load-bearing and INVISIBLE in prod —
 * a reorder that drops a public-webhook route behind the `/api/*` JWT catch-all
 * never throws; the webhook just starts returning 404 (fell through to the
 * SPA/static fallthrough → app.fetch 404) or 401 (caught by authMiddleware).
 * Either way ingress silently breaks. This test makes that failure LOUD with a
 * message that explains the cause and the fix.
 *
 * DB-touching DAL modules are mocked so the few handlers that reach a DAL call
 * (sentry → getErrorProjectBySentryKey, revanote → getUserRevanoteWebhookSecret,
 * coolify → getUserCoolifyWebhookConfig) resolve to "no such secret/project"
 * instead of hanging on a real Postgres connection. Every one of those then
 * returns 401/403 — exactly the "route mounted + auth ran" signal we assert.
 */

// Module-load env (mirrors csrf.test.ts) so config.ts validation passes.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-chars-long-aaaaaaaa';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'session-secret-at-least-32-chars-long-x';
process.env.MAGIC_LINK_SECRET = process.env.MAGIC_LINK_SECRET || 'magic-link-secret-at-least-32-chars-x';
process.env.TITANIUM_KEYGEN_API_URL = process.env.TITANIUM_KEYGEN_API_URL || 'https://keygen.titaniumlabs.us';
process.env.TITANIUM_KEYGEN_ACCOUNT_ID = process.env.TITANIUM_KEYGEN_ACCOUNT_ID || 'acct_test_0000000000';
process.env.TITANIUM_KEYGEN_PRODUCT_ID = process.env.TITANIUM_KEYGEN_PRODUCT_ID || 'prod_test_remo';
// Telegram webhook: leave the secret UNSET so the public webhook returns 503
// (feature-disabled) rather than reaching for a config secret. 503 still proves
// the route is mounted ahead of the JWT catch-all (it is NOT a 404).
delete process.env.TELEGRAM_BOT_TOKEN;
delete process.env.TELEGRAM_WEBHOOK_SECRET;
// Titanium license-changed webhook: leave secret UNSET → inert 503 (still proves
// the route is mounted; never a 404).
delete process.env.TITANIUM_WEBHOOK_SECRET;

import { describe, test, expect, mock } from 'bun:test';

// ── Mock the DB layer so webhook handlers that DO reach a DAL call resolve to
//    "not configured" instead of blocking on a real Postgres connection. The
//    handlers all fail-safe to 401/403 on a missing secret, which is the exact
//    "auth ran" signal this test wants. ────────────────────────────────────────
const realErrCapDal = await import('../src/db/error-capture-dal.ts');
mock.module('../src/db/error-capture-dal.ts', () => ({
  ...realErrCapDal,
  getErrorProjectBySentryKey: async () => null, // → sentry 401 bad_sentry_key
}));
const realRevanoteDal = await import('../src/db/revanote-dal.ts');
mock.module('../src/db/revanote-dal.ts', () => ({
  ...realRevanoteDal,
  getUserRevanoteWebhookSecret: async () => null, // → revanote 401 unauthorized
}));
// Feedback intake: a real key lookup resolves a DISABLED key so the handler
// returns 403 (route mounted + key resolved + handler ran). Without this mock
// the unknown-token path returns 404 from the handler — indistinguishable from
// the catch-all-swallow 404 this test guards against, so we force a deterministic
// "auth ran" signal instead.
const realFeedbackDal = await import('../src/db/feedback-dal.ts');
mock.module('../src/db/feedback-dal.ts', () => ({
  ...realFeedbackDal,
  resolveFeedbackKey: async () => ({
    token_hash: 'x', session_id: 's', user_id: 'u',
    label: null, enabled: false, created_at: new Date(),
  }),
}));

// dal.ts is huge and exports ~101 helpers consumed across the whole app (auth,
// session, csrf, ...). DO NOT replace it wholesale — re-export the REAL module
// and override only the coolify-webhook DAL calls so the coolify auth path
// resolves to "not configured" → 401. (telegram short-circuits at 503 before
// any DAL call; coolify already wraps its config lookup in `.catch()`, so this
// override is belt-and-suspenders to avoid a real connection attempt.)
const realDal = await import('../src/db/dal.ts');
mock.module('../src/db/dal.ts', () => ({
  ...realDal,
  getUserCoolifyWebhookSecret: async () => null,
  getUserCoolifyWebhookConfig: async () => ({ secret: null, allowedIps: [] }),
}));

// Import AFTER the mocks are registered. `import.meta.main` is false here, so
// boot() does NOT run — no Bun.serve, no JWKS warm, no migrations.
//
// NOTE: run this file in ISOLATION (`bun test hub/test/mount-order.test.ts`).
// Bun's `mock.module` is process-global and siblings in the full `bun test
// hub/test/` run leave partial DAL mocks registered without restoring (the
// pre-existing pollution documented in memory: feedback_bun_mock_pollution.md;
// ~15 suite-wide failures predate this file). index.ts transitively imports
// supervisor-dal / scheduled-tasks-dal, so a leaked partial mock can make this
// import throw "Export named X not found" only in the polluted full-suite run.
// There is no CI job that runs the whole suite; the contract file
// scheduler.test.ts and this file are run/asserted on their own.
const { app } = await import('../src/index.ts');

// ── The real public-webhook paths, lifted verbatim from index.ts mounts. A POST
//    to each MUST hit the webhook's own auth, never fall through to the JWT
//    catch-all (→ 404) and never succeed without auth (→ 2xx other than 202). ──
const WEBHOOK_PATHS: Array<{ path: string; note: string }> = [
  { path: '/api/sentry/proj_test/envelope/', note: 'sentry-intake (X-Sentry-Auth credential)' },
  { path: '/api/coolify/webhook/user_test/wrong-token', note: 'coolify URL-token' },
  { path: '/api/coolify/webhook/user_test', note: 'coolify legacy HMAC' },
  { path: '/api/revanote/webhook/user_test/wrong-token', note: 'revanote URL-token + HMAC' },
  { path: '/api/feedback/fb_disabled_token', note: 'feedback intake URL-token (disabled key → 403)' },
  { path: '/api/telegram/webhook/wrong-secret', note: 'telegram URL-secret' },
  { path: '/webhooks/titanium/license-changed', note: 'titanium license-changed HMAC' },
];

// "Route mounted + auth ran" status codes. 404 and 2xx-without-auth (other than
// the explicit 202 accept, which can't happen here because every secret is
// missing/wrong) are the failure signals.
const AUTH_RAN_STATUSES = new Set([400, 401, 403, 503, 202]);

describe('mount-order: public webhooks are reachable BEFORE the JWT catch-all (IR-8)', () => {
  for (const { path, note } of WEBHOOK_PATHS) {
    test(`unauth POST ${path} runs webhook auth (not swallowed by JWT catch-all) — ${note}`, async () => {
      const res = await app.request(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });

      // The load-bearing assertion. A 404 here means the webhook router was
      // mounted AFTER the `/api/*` JWT catch-all (or removed), so the request
      // fell through to app.fetch's 404 → the SPA static fallthrough. Fix:
      // mount the webhook router BEFORE `app.use('/api/*', authMiddleware...)`
      // in hub/src/index.ts and add its subpath to the catch-all skip list.
      expect(
        res.status,
        `webhook ${path} returned 404 → it fell into the JWT catch-all (or is unmounted). ` +
          `Mount it BEFORE the /api/* auth middleware in index.ts (see MOUNT-ORDER INVARIANT (1)).`,
      ).not.toBe(404);

      // It must also not have been accepted without a valid credential. The
      // only 2xx a public webhook may emit unauthenticated is 202 (explicit
      // accept) — which cannot happen here since every secret is wrong/unset.
      expect(
        AUTH_RAN_STATUSES.has(res.status),
        `webhook ${path} returned ${res.status}; expected one of ` +
          `400/401/403/503/202 (route mounted + auth ran). A 2xx other than 202 ` +
          `would mean the webhook accepted an unauthenticated request.`,
      ).toBe(true);
    });
  }
});

describe('mount-order: protected /api/* routes are behind the JWT catch-all', () => {
  test('unauth GET /api/sessions → 401 (authMiddleware active)', async () => {
    const res = await app.request('/api/sessions', { method: 'GET' });
    expect(
      res.status,
      `GET /api/sessions returned ${res.status}; expected 401. The /api/* JWT ` +
        `catch-all must reject unauthenticated reads of protected routes.`,
    ).toBe(401);
  });

  test('unauth GET /api/scheduled-tasks → 401 (authMiddleware active)', async () => {
    const res = await app.request('/api/scheduled-tasks', { method: 'GET' });
    expect(res.status).toBe(401);
  });
});

describe('mount-order: CSRF guard SKIPS the public webhook paths', () => {
  // A no-CSRF-token POST to a webhook must NOT be rejected with the CSRF error
  // (`{error:"csrf_failed"}`, 403). It must reach the webhook's own auth — i.e.
  // the request gets past csrfGuard into the route handler. We assert the
  // response is NOT the CSRF rejection shape. (Coolify/revanote DO emit 403 for
  // ip_not_allowed, but never with error:"csrf_failed" — so we check the body,
  // not just the status.)
  for (const { path, note } of WEBHOOK_PATHS) {
    test(`no-CSRF-token POST ${path} is not blocked by csrfGuard — ${note}`, async () => {
      const res = await app.request(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      // Never a 404 (would mean unmounted / behind catch-all).
      expect(res.status).not.toBe(404);
      // Pull the body and confirm it's not the CSRF rejection. csrf_failed is
      // the ONLY thing csrfGuard emits; its absence proves the webhook path was
      // allowlisted and the request reached the webhook handler.
      let body: any = null;
      try { body = await res.clone().json(); } catch { /* non-JSON (e.g. telegram 401 Response(null)) is fine */ }
      expect(
        body?.error,
        `webhook ${path} was rejected by csrfGuard (error:"csrf_failed"). ` +
          `Add its subpath to CSRF_PATH_ALLOWLIST in hub/src/csrf.ts ` +
          `(see MOUNT-ORDER INVARIANT (3)).`,
      ).not.toBe('csrf_failed');
    });
  }
});
