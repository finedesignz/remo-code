// Phase 07-C / C.5: re-auth gate.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-chars-long-aaaaaaaa';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'session-secret-at-least-32-chars-long-x';
process.env.MAGIC_LINK_SECRET = process.env.MAGIC_LINK_SECRET || 'magic-link-secret-at-least-32-chars-x';
process.env.TITANIUM_KEYGEN_API_URL = process.env.TITANIUM_KEYGEN_API_URL || 'https://keygen.titaniumlabs.us';process.env.TITANIUM_KEYGEN_ACCOUNT_ID = process.env.TITANIUM_KEYGEN_ACCOUNT_ID || 'acct_test_0000000000';process.env.TITANIUM_KEYGEN_PRODUCT_ID = process.env.TITANIUM_KEYGEN_PRODUCT_ID || 'prod_test_remo';
process.env.ALLOW_LEGACY_LOGIN = process.env.ALLOW_LEGACY_LOGIN || 'true';

import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { Hono } from 'hono';
import jwt from 'jsonwebtoken';

const verifyAuthSessionCookie = mock(async (_c: any) => null as any);
const realSession = await import('../src/session');
mock.module('../src/session.ts', () => ({
  ...realSession,
  verifyAuthSessionCookie,
}));

const { requireRecentAuth } = await import('../src/auth/reauth');

function buildApp(maxAgeSec?: number) {
  const app = new Hono();
  app.use('*', requireRecentAuth(maxAgeSec));
  app.post('/sensitive', (c) => c.json({ ok: true, userId: c.get('userId') }));
  return app;
}

beforeEach(() => {
  verifyAuthSessionCookie.mockClear();
});

describe('requireRecentAuth', () => {
  test('no session → 401 re_auth_required', async () => {
    verifyAuthSessionCookie.mockImplementation(async () => null);
    const res = await buildApp().request('/sensitive', { method: 'POST' });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe('re_auth_required');
  });

  test('fresh session (<15min) → pass-through', async () => {
    verifyAuthSessionCookie.mockImplementation(async () => ({
      userId: 'u-1',
      sessionRow: { created_at: new Date(Date.now() - 60_000) }, // 1 min old
      user: { id: 'u-1', email: 'a@b.com', role: 'admin' },
    }));
    const res = await buildApp().request('/sensitive', { method: 'POST' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.userId).toBe('u-1');
  });

  test('session within new 15min window (was failing under old 5min) → pass-through', async () => {
    // Regression: under Titanium magic-link, a user who logs in, browses for
    // 10 min, then clicks Rotate must succeed. Old 5min default broke this.
    verifyAuthSessionCookie.mockImplementation(async () => ({
      userId: 'u-1',
      sessionRow: { created_at: new Date(Date.now() - 10 * 60_000) }, // 10 min
      user: { id: 'u-1', email: 'a@b.com', role: 'admin' },
    }));
    const res = await buildApp().request('/sensitive', { method: 'POST' });
    expect(res.status).toBe(200);
  });

  test('stale session (>15min) → 401', async () => {
    verifyAuthSessionCookie.mockImplementation(async () => ({
      userId: 'u-1',
      sessionRow: { created_at: new Date(Date.now() - 20 * 60_000) }, // 20 min
      user: { id: 'u-1', email: 'a@b.com', role: 'admin' },
    }));
    const res = await buildApp().request('/sensitive', { method: 'POST' });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe('re_auth_required');
    expect(body.max_age_seconds).toBe(900);
  });

  // ── Legacy bearer JWT path (ALLOW_LEGACY_LOGIN=true soak) ──────────────
  // Regression: prior to this fix, requireRecentAuth hard-failed every legacy
  // bearer JWT user with `no_cookie_session` 401 because they have no cookie
  // session row. With ALLOW_LEGACY_LOGIN + TITANIUM_BYPASS both =true in prod
  // (2026-05-27), this hard-blocked api-key create/delete + admin mutations.

  test('legacy JWT with fresh iat → pass-through', async () => {
    verifyAuthSessionCookie.mockImplementation(async () => null);
    const token = jwt.sign(
      { sub: 'u-legacy', email: 'l@b.com', role: 'admin' },
      process.env.JWT_SECRET!,
      { expiresIn: '30d' },
    );
    const res = await buildApp().request('/sensitive', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.userId).toBe('u-legacy');
  });

  test('legacy JWT with stale iat (>15min) → 401 re_auth_required', async () => {
    verifyAuthSessionCookie.mockImplementation(async () => null);
    const staleIat = Math.floor(Date.now() / 1000) - 20 * 60; // 20 min ago
    // jsonwebtoken's `expiresIn` + explicit `iat` requires the option to honor
    // the payload-provided iat. Pass it raw without expiresIn so iat is preserved.
    const token = jwt.sign(
      { sub: 'u-legacy', email: 'l@b.com', role: 'admin', iat: staleIat, exp: staleIat + 30 * 24 * 3600 },
      process.env.JWT_SECRET!,
    );
    const res = await buildApp().request('/sensitive', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe('re_auth_required');
    expect(body.max_age_seconds).toBe(900);
  });

  test('legacy JWT with invalid signature → 401 invalid_legacy_token', async () => {
    verifyAuthSessionCookie.mockImplementation(async () => null);
    const res = await buildApp().request('/sensitive', {
      method: 'POST',
      headers: { Authorization: 'Bearer not.a.jwt' },
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe('re_auth_required');
    expect(body.reason).toBe('invalid_legacy_token');
  });

  test('custom maxAge honored', async () => {
    verifyAuthSessionCookie.mockImplementation(async () => ({
      userId: 'u-1',
      sessionRow: { created_at: new Date(Date.now() - 90_000) }, // 90s old
      user: { id: 'u-1', email: 'a@b.com', role: 'admin' },
    }));
    // 60s limit → 90s is too old
    const res1 = await buildApp(60).request('/sensitive', { method: 'POST' });
    expect(res1.status).toBe(401);
    // 120s limit → 90s is fine
    const res2 = await buildApp(120).request('/sensitive', { method: 'POST' });
    expect(res2.status).toBe(200);
  });
});
