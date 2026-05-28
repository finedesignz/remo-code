// Phase 12.1: mobile deep-link handoff flow.
//
// Covers:
//   - GET /api/auth/login/callback?platform=ios|android mints a handoff and
//     302s to remo-code://auth/callback?token=...
//   - POST /api/auth/finalize-mobile consumes the token (single-use)
//   - Double-consume returns 401
//   - Expired token returns 401
//   - Missing/short token returns 400
//   - The session cookie emitted under a Tauri Origin is `remo_sid` with
//     SameSite=None; Secure; Partitioned (not the __Host- variant).
//
// DAL is mocked process-wide. No DB needed.

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-chars-long-aaaaaaaa';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'session-secret-at-least-32-chars-long-x';
process.env.MAGIC_LINK_SECRET = process.env.MAGIC_LINK_SECRET || 'magic-link-secret-at-least-32-chars-x';
process.env.TITANIUM_KEYGEN_API_URL = process.env.TITANIUM_KEYGEN_API_URL || 'https://keygen.titaniumlabs.us';
process.env.TITANIUM_KEYGEN_ACCOUNT_ID = process.env.TITANIUM_KEYGEN_ACCOUNT_ID || 'acct_test_0000000000';
process.env.TITANIUM_KEYGEN_PRODUCT_ID = process.env.TITANIUM_KEYGEN_PRODUCT_ID || 'prod_test_remo';
process.env.TITANIUM_REQUIRE_REDIS = 'false';
process.env.MOBILE_TAURI_ORIGINS_ENABLED = 'true';

import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { Hono } from 'hono';

// In-memory handoff store keyed by sha-256(token) — emulates the
// `auth_handoff_tokens` table with atomic single-use semantics.
import { createHash } from 'node:crypto';
function sha256(s: string): string { return createHash('sha256').update(s).digest('hex'); }

interface HandoffRow { userId: string; expiresAt: number; consumed: boolean; purpose: string }
const handoffStore = new Map<string, HandoffRow>();

const realDal = await import('../src/db/dal.ts');
const realSession = await import('../src/session.ts');

let mintCount = 0;
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
  createAuthHandoffToken: mock(async (userId: string, opts: any = {}) => {
    mintCount += 1;
    const token = `mh_test_${mintCount}_${Math.random().toString(36).slice(2)}`;
    const ttl = opts.ttlSeconds ?? 60;
    handoffStore.set(sha256(token), {
      userId,
      expiresAt: Date.now() + ttl * 1000,
      consumed: false,
      purpose: opts.purpose ?? 'mobile_handoff',
    });
    return { token, expiresAt: new Date(Date.now() + ttl * 1000) };
  }),
  consumeAuthHandoffToken: mock(async (token: string) => {
    if (!token) return null;
    const row = handoffStore.get(sha256(token));
    if (!row) return null;
    if (row.consumed) return null;
    if (row.expiresAt <= Date.now()) return null;
    row.consumed = true;
    return { userId: row.userId, purpose: row.purpose };
  }),
};

mock.module('../src/db/dal.ts', () => ({ ...realDal, ...dalMocks }));

const sessionMocks = {
  createAndSetSession: mock(async (c: any, _opts: any) => {
    // Mirror the real session module's Tauri-variant decision so the response
    // carries an observable Set-Cookie header in tests.
    const origin = c.req.header('origin');
    const isTauri = origin === 'tauri://localhost' || origin === 'https://tauri.localhost';
    const name = isTauri ? 'remo_sid' : '__Host-remo_sid';
    const parts = [
      `${name}=remo_test_session`,
      'Path=/',
      'Max-Age=604800',
      'HttpOnly',
      'Secure',
      `SameSite=${isTauri ? 'None' : 'Lax'}`,
    ];
    if (isTauri) parts.push('Partitioned');
    c.header('Set-Cookie', parts.join('; '), { append: true });
    return {
      token: 'remo_test_session',
      id: 'sha-id',
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    };
  }),
  destroySession: mock(async () => {}),
  readSessionCookie: mock((_c: any) => null as string | null),
  verifyAuthSessionCookie: mock(async () => null as any),
};
mock.module('../src/session.ts', () => ({ ...realSession, ...sessionMocks }));

const { authRouter, __testing } = await import('../src/api/auth');

function buildApp() {
  const app = new Hono();
  app.route('/api/auth', authRouter);
  return app;
}

beforeEach(() => {
  handoffStore.clear();
  mintCount = 0;
  for (const m of [
    dalMocks.getUserById, dalMocks.recordAuthEvent, dalMocks.promoteCandidateSubject,
    dalMocks.deleteAuthSession, dalMocks.createAuthHandoffToken, dalMocks.consumeAuthHandoffToken,
    sessionMocks.createAndSetSession, sessionMocks.destroySession, sessionMocks.readSessionCookie,
    sessionMocks.verifyAuthSessionCookie,
  ]) m.mockClear();
});

async function mintLink(): Promise<string> {
  const { token } = await __testing.signMagicLink({ sub: 'user-1', email: 'a@b.com' });
  return token;
}

describe('GET /api/auth/login/callback?platform=ios', () => {
  test('mints a handoff and 302s to the deep-link', async () => {
    const link = await mintLink();
    const res = await buildApp().request(`/api/auth/login/callback?platform=ios&token=${encodeURIComponent(link)}`);
    expect(res.status).toBe(302);
    const loc = res.headers.get('location') ?? '';
    expect(loc.startsWith('remo-code://auth/callback?token=')).toBe(true);
    expect(dalMocks.createAuthHandoffToken).toHaveBeenCalledTimes(1);
    // Browser cookie path NOT taken.
    expect(sessionMocks.createAndSetSession).not.toHaveBeenCalled();
  });

  test('android platform also 302s to the deep-link', async () => {
    const link = await mintLink();
    const res = await buildApp().request(`/api/auth/login/callback?platform=android&token=${encodeURIComponent(link)}`);
    expect(res.status).toBe(302);
    expect((res.headers.get('location') ?? '').startsWith('remo-code://auth/callback?token=')).toBe(true);
  });

  test('unknown platform value falls back to browser cookie path (302 to /)', async () => {
    const link = await mintLink();
    const res = await buildApp().request(`/api/auth/login/callback?platform=bogus&token=${encodeURIComponent(link)}`);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/');
    expect(dalMocks.createAuthHandoffToken).not.toHaveBeenCalled();
    expect(sessionMocks.createAndSetSession).toHaveBeenCalledTimes(1);
  });
});

describe('POST /api/auth/finalize-mobile', () => {
  async function mintHandoffViaCallback(platform = 'ios'): Promise<string> {
    const link = await mintLink();
    const res = await buildApp().request(`/api/auth/login/callback?platform=${platform}&token=${encodeURIComponent(link)}`);
    const loc = res.headers.get('location') ?? '';
    const url = new URL(loc.replace('remo-code://', 'https://example.local/'));
    return url.searchParams.get('token') ?? '';
  }

  test('happy path — consumes token, returns user, emits Tauri cookie', async () => {
    const handoff = await mintHandoffViaCallback('ios');
    expect(handoff.length).toBeGreaterThan(8);

    const res = await buildApp().request('/api/auth/finalize-mobile', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Origin': 'tauri://localhost',
      },
      body: JSON.stringify({ token: handoff }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.ok).toBe(true);
    expect(body.user.id).toBe('user-1');
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('remo_sid=');
    expect(setCookie).not.toContain('__Host-');
    expect(setCookie).toContain('SameSite=None');
    expect(setCookie).toContain('Partitioned');
    expect(dalMocks.consumeAuthHandoffToken).toHaveBeenCalledTimes(1);
    const evt = dalMocks.recordAuthEvent.mock.calls.find((c: any[]) => c[0]?.eventType === 'mobile_finalize');
    expect(evt).toBeDefined();
  });

  test('double-consume returns 401', async () => {
    const handoff = await mintHandoffViaCallback('ios');
    const first = await buildApp().request('/api/auth/finalize-mobile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Origin': 'tauri://localhost' },
      body: JSON.stringify({ token: handoff }),
    });
    expect(first.status).toBe(200);
    const second = await buildApp().request('/api/auth/finalize-mobile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Origin': 'tauri://localhost' },
      body: JSON.stringify({ token: handoff }),
    });
    expect(second.status).toBe(401);
    const body = await second.json() as any;
    expect(body.error).toBe('invalid_or_expired');
  });

  test('expired token returns 401', async () => {
    // Mint a row with an immediate-past expiry.
    const token = 'mh_expired_xxx';
    handoffStore.set(sha256(token), {
      userId: 'user-1',
      expiresAt: Date.now() - 1000,
      consumed: false,
      purpose: 'mobile_handoff',
    });
    const res = await buildApp().request('/api/auth/finalize-mobile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Origin': 'tauri://localhost' },
      body: JSON.stringify({ token }),
    });
    expect(res.status).toBe(401);
  });

  test('missing/short token returns 400', async () => {
    const res = await buildApp().request('/api/auth/finalize-mobile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Origin': 'tauri://localhost' },
      body: JSON.stringify({ token: '' }),
    });
    expect(res.status).toBe(400);
  });

  test('unknown token returns 401', async () => {
    const res = await buildApp().request('/api/auth/finalize-mobile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Origin': 'tauri://localhost' },
      body: JSON.stringify({ token: 'mh_never_minted_aaaaa' }),
    });
    expect(res.status).toBe(401);
  });
});
