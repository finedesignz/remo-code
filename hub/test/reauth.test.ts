// Phase 07-C / C.5: re-auth gate.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-chars-long-aaaaaaaa';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'session-secret-at-least-32-chars-long-x';
process.env.MAGIC_LINK_SECRET = process.env.MAGIC_LINK_SECRET || 'magic-link-secret-at-least-32-chars-x';
process.env.TITANIUM_KEYGEN_API_URL = process.env.TITANIUM_KEYGEN_API_URL || 'https://keygen.titaniumlabs.us';process.env.TITANIUM_KEYGEN_ACCOUNT_ID = process.env.TITANIUM_KEYGEN_ACCOUNT_ID || 'acct_test_0000000000';process.env.TITANIUM_KEYGEN_PRODUCT_ID = process.env.TITANIUM_KEYGEN_PRODUCT_ID || 'prod_test_remo';

import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { Hono } from 'hono';

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

  test('fresh session (<5min) → pass-through', async () => {
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

  test('stale session (>5min) → 401', async () => {
    verifyAuthSessionCookie.mockImplementation(async () => ({
      userId: 'u-1',
      sessionRow: { created_at: new Date(Date.now() - 10 * 60_000) }, // 10 min
      user: { id: 'u-1', email: 'a@b.com', role: 'admin' },
    }));
    const res = await buildApp().request('/sensitive', { method: 'POST' });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe('re_auth_required');
    expect(body.max_age_seconds).toBe(300);
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
