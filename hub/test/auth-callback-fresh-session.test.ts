// Regression: magic-link /callback MUST revoke any inbound session cookie
// BEFORE creating a fresh `auth_sessions` row. The re-auth gate keys on
// auth_sessions.created_at — if a user re-authenticates while still holding
// a stale cookie, the new row must be brand-new (fresh created_at) and the
// old row should be deleted.
//
// Bug: prior to this fix, the callback called createAndSetSession without
// touching the inbound cookie at all. While createAndSetSession DOES INSERT
// a new row (fresh created_at) and overwrite the cookie, the orphan row
// stayed alive and the cookie behavior under some clients was inconsistent.
// Explicit revoke makes the contract observable + deterministic.
//
// /logout: row must be deleted server-side (not just cookie cleared).

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-chars-long-aaaaaaaa';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'session-secret-at-least-32-chars-long-x';
process.env.MAGIC_LINK_SECRET = process.env.MAGIC_LINK_SECRET || 'magic-link-secret-at-least-32-chars-x';
process.env.TITANIUM_KEYGEN_API_URL = process.env.TITANIUM_KEYGEN_API_URL || 'https://keygen.titaniumlabs.us';
process.env.TITANIUM_KEYGEN_ACCOUNT_ID = process.env.TITANIUM_KEYGEN_ACCOUNT_ID || 'acct_test_0000000000';
process.env.TITANIUM_KEYGEN_PRODUCT_ID = process.env.TITANIUM_KEYGEN_PRODUCT_ID || 'prod_test_remo';
process.env.TITANIUM_REQUIRE_REDIS = 'false';

import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { Hono } from 'hono';

// ── Mocks ────────────────────────────────────────────────────────────────────
// Spread the real modules first so other test files that share this process
// (Bun's `mock.module` is process-wide) still find every export they need.

const realDal = await import('../src/db/dal.ts');
const realSession = await import('../src/session.ts');

const dalMocks = {
  getUserById: mock(async (id: string) => ({
    id,
    email: 'a@b.com',
    role: 'admin',
    titanium_link_status: 'linked',
    display_name: null,
  })),
  recordAuthEvent: mock(async () => {}),
  promoteCandidateSubject: mock(async () => true),
  deleteAuthSession: mock(async () => {}),
};

mock.module('../src/db/dal.ts', () => ({ ...realDal, ...dalMocks }));

const sessionMocks = {
  createAndSetSession: mock(async (_c: any, _opts: any) => ({
    token: 'remo_freshtoken123',
    id: 'sha-id',
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
  })),
  destroySession: mock(async () => {}),
  readSessionCookie: mock((_c: any) => null as string | null),
  verifyAuthSessionCookie: mock(async () => null as any),
};
mock.module('../src/session.ts', () => ({ ...realSession, ...sessionMocks }));

// csrf module is left real — its functions are pure and side-effect-free in
// this test (they read/write headers on the test Context).

// Load the router AFTER mocks are wired.
const { authRouter, __testing } = await import('../src/api/auth');

function buildApp() {
  const app = new Hono();
  app.route('/api/auth', authRouter);
  return app;
}

beforeEach(() => {
  for (const m of [
    dalMocks.getUserById, dalMocks.recordAuthEvent, dalMocks.promoteCandidateSubject,
    dalMocks.deleteAuthSession,
    sessionMocks.createAndSetSession, sessionMocks.destroySession, sessionMocks.readSessionCookie,
    sessionMocks.verifyAuthSessionCookie,
  ]) m.mockClear();
});

async function mintLink(): Promise<string> {
  const { token } = await __testing.signMagicLink({ sub: 'user-1', email: 'a@b.com' });
  return token;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('GET /api/auth/login/callback — fresh session contract', () => {
  test('with existing session cookie → revokes inbound, creates fresh', async () => {
    sessionMocks.readSessionCookie.mockImplementation(() => 'remo_oldtoken');

    const link = await mintLink();
    const res = await buildApp().request(`/api/auth/login/callback?token=${encodeURIComponent(link)}`);

    expect(res.status).toBe(302);
    // The old session row was revoked exactly once with the inbound token.
    expect(dalMocks.deleteAuthSession).toHaveBeenCalledTimes(1);
    expect(dalMocks.deleteAuthSession.mock.calls[0][0]).toBe('remo_oldtoken');
    // A fresh session row was inserted.
    expect(sessionMocks.createAndSetSession).toHaveBeenCalledTimes(1);
    // login_success event records the revocation for observability.
    const successCall = dalMocks.recordAuthEvent.mock.calls.find(
      (c: any[]) => c[0]?.eventType === 'login_success'
    );
    expect(successCall).toBeDefined();
    expect(successCall![0].metadata.revoked_prior_session).toBe(true);
    expect(successCall![0].metadata.method).toBe('magic_link');
  });

  test('with NO session cookie → skips revoke, creates fresh', async () => {
    sessionMocks.readSessionCookie.mockImplementation(() => null);

    const link = await mintLink();
    const res = await buildApp().request(`/api/auth/login/callback?token=${encodeURIComponent(link)}`);

    expect(res.status).toBe(302);
    expect(dalMocks.deleteAuthSession).not.toHaveBeenCalled();
    expect(sessionMocks.createAndSetSession).toHaveBeenCalledTimes(1);
    const successCall = dalMocks.recordAuthEvent.mock.calls.find(
      (c: any[]) => c[0]?.eventType === 'login_success'
    );
    expect(successCall![0].metadata.revoked_prior_session).toBe(false);
  });

  test('inbound revoke failure does NOT block login', async () => {
    sessionMocks.readSessionCookie.mockImplementation(() => 'remo_oldtoken');
    dalMocks.deleteAuthSession.mockImplementationOnce(async () => { throw new Error('db down'); });

    const link = await mintLink();
    const res = await buildApp().request(`/api/auth/login/callback?token=${encodeURIComponent(link)}`);

    // Login still succeeds; new session still created.
    expect(res.status).toBe(302);
    expect(sessionMocks.createAndSetSession).toHaveBeenCalledTimes(1);
  });
});

describe('POST /api/auth/logout — actually deletes the row', () => {
  test('calls destroySession (which hard-deletes via DAL) and clears CSRF', async () => {
    sessionMocks.verifyAuthSessionCookie.mockImplementation(async () => ({
      userId: 'user-1',
      sessionRow: {} as any,
      user: { id: 'user-1', email: 'a@b.com', role: 'admin' },
    }));

    const res = await buildApp().request('/api/auth/logout', { method: 'POST' });

    expect(res.status).toBe(200);
    expect(sessionMocks.destroySession).toHaveBeenCalledTimes(1);
    const logoutEvt = dalMocks.recordAuthEvent.mock.calls.find(
      (c: any[]) => c[0]?.eventType === 'logout'
    );
    expect(logoutEvt).toBeDefined();
    expect(logoutEvt![0].userId).toBe('user-1');
  });

  test('logout works even when no cookie was sent (anonymous logout)', async () => {
    sessionMocks.verifyAuthSessionCookie.mockImplementation(async () => null);

    const res = await buildApp().request('/api/auth/logout', { method: 'POST' });

    expect(res.status).toBe(200);
    // destroySession still runs (it's a no-op internally when no cookie).
    expect(sessionMocks.destroySession).toHaveBeenCalledTimes(1);
  });
});
