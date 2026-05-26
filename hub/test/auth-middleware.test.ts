// Phase 07-C: dual-auth middleware unit tests with mocked session + JWT.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-chars-long-aaaaaaaa';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'session-secret-at-least-32-chars-long-x';
process.env.MAGIC_LINK_SECRET = process.env.MAGIC_LINK_SECRET || 'magic-link-secret-at-least-32-chars-x';
// Pre-set TITANIUM_* envs so a later-loaded titanium-client test in the same
// bun process sees a configured config (config.ts captures env at module-load).
process.env.TITANIUM_KEYGEN_API_URL = process.env.TITANIUM_KEYGEN_API_URL || 'https://keygen.titaniumlabs.us';
process.env.TITANIUM_ACCOUNT_ID = process.env.TITANIUM_ACCOUNT_ID || 'acct_test_0000000000';
process.env.TITANIUM_PRODUCT_ID = process.env.TITANIUM_PRODUCT_ID || 'prod_test_remo';

import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { Hono } from 'hono';

// Mock the session + JWT modules BEFORE importing the middleware.
const verifyAuthSessionCookie = mock(async (_c: any) => null as any);
const verifyJwt = mock((_token: string) => ({ sub: 'u-1', email: 'a@b.com', role: 'admin' }));

// mock.module is process-wide in bun test. Re-export everything from the
// real session module and only override verifyAuthSessionCookie.
const realSession = await import('../src/session');
mock.module('../src/session.ts', () => ({
  ...realSession,
  verifyAuthSessionCookie,
}));
mock.module('../src/auth/jwt.ts', () => ({
  verifyJwt,
  signJwt: () => 'fake-jwt',
}));

const { authMiddleware } = await import('../src/auth/middleware');
const { config } = await import('../src/config');

function buildApp() {
  const app = new Hono();
  app.use('*', authMiddleware);
  app.get('/me', (c) => c.json({ userId: c.get('userId'), method: c.get('authMethod') }));
  return app;
}

beforeEach(() => {
  verifyAuthSessionCookie.mockClear();
  verifyJwt.mockClear();
  verifyAuthSessionCookie.mockImplementation(async () => null);
  verifyJwt.mockImplementation(() => ({ sub: 'u-1', email: 'a@b.com', role: 'admin' }));
  (config as any).allowLegacyLogin = true;
});

describe('authMiddleware dual-auth', () => {
  test('valid cookie session → pass, method=session_cookie', async () => {
    verifyAuthSessionCookie.mockImplementation(async () => ({
      userId: 'u-cookie',
      sessionRow: { created_at: new Date() },
      user: { id: 'u-cookie', email: 'cookie@x.com', role: 'admin' },
    }));
    const res = await buildApp().request('/me');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.userId).toBe('u-cookie');
    expect(body.method).toBe('session_cookie');
  });

  test('no cookie + valid bearer + soak flag on → pass, method=legacy_jwt', async () => {
    const res = await buildApp().request('/me', { headers: { Authorization: 'Bearer xyz' } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.userId).toBe('u-1');
    expect(body.method).toBe('legacy_jwt');
  });

  test('no cookie + valid bearer + soak flag OFF → 401', async () => {
    (config as any).allowLegacyLogin = false;
    const res = await buildApp().request('/me', { headers: { Authorization: 'Bearer xyz' } });
    expect(res.status).toBe(401);
  });

  test('no auth at all → 401', async () => {
    const res = await buildApp().request('/me');
    expect(res.status).toBe(401);
  });

  test('tampered bearer → 401', async () => {
    verifyJwt.mockImplementation(() => { throw new Error('bad'); });
    const res = await buildApp().request('/me', { headers: { Authorization: 'Bearer xyz' } });
    expect(res.status).toBe(401);
  });

  test('cookie wins over bearer when both present', async () => {
    verifyAuthSessionCookie.mockImplementation(async () => ({
      userId: 'u-cookie',
      sessionRow: { created_at: new Date() },
      user: { id: 'u-cookie', email: 'cookie@x.com', role: 'user' },
    }));
    const res = await buildApp().request('/me', { headers: { Authorization: 'Bearer xyz' } });
    const body = await res.json();
    expect(body.userId).toBe('u-cookie');
    expect(body.method).toBe('session_cookie');
    // Bearer verify never even called.
    expect(verifyJwt).not.toHaveBeenCalled();
  });
});
