// Legacy login surfaces are OFF by default and answer a plain 404:
//   ALLOW_LEGACY_LOGIN (default false)   → POST /api/auth/login, /register,
//                                          POST /api/setup/create-admin
//   LEGACY_MAGIC_LINK_LOGIN (default off) → POST /api/auth/login/request-link,
//                                          GET /api/auth/login/callback,
//                                          POST /api/auth/finalize-mobile
// and TITANIUM_BYPASS (a license switch) neither enables password login nor
// disables the Titanium hosted login. Each test fails if its gate is removed.

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-chars-long-aaaaaaaa';
process.env.SESSION_SECRET = 'session-secret-at-least-32-chars-long-x';
process.env.MAGIC_LINK_SECRET = 'magic-link-secret-at-least-32-chars-x';
process.env.TITANIUM_REQUIRE_REDIS = 'false';
delete process.env.ALLOW_LEGACY_LOGIN;
delete process.env.LEGACY_MAGIC_LINK_LOGIN;

import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { Hono } from 'hono';

const realDal = await import('../src/db/dal.ts');
const dalMocks = {
  countUsers: mock(async () => 0),
  createUser: mock(async (email: string, _h: string, role: string) => ({ id: 'u1', email, role })),
  getUserByEmail: mock(async () => null),
  getUserById: mock(async () => null),
  recordAuthEvent: mock(async () => {}),
  consumeAuthHandoffToken: mock(async () => null),
};
mock.module('../src/db/dal.ts', () => ({ ...realDal, ...dalMocks }));

const { config } = await import('../src/config.ts');
const { authRouter } = await import('../src/api/auth.ts');
const { setup } = await import('../src/api/setup.ts');
const { titaniumAuthRouter } = await import('../src/api/titanium-auth.ts');
const { clientConfig } = await import('../src/api/client-config.ts');

function app() {
  const a = new Hono();
  a.route('/api/auth', authRouter);
  a.route('/api/setup', setup);
  a.route('/api/client-config', clientConfig);
  a.route('/auth', titaniumAuthRouter);
  return a;
}
const post = (path: string, body: unknown = {}) =>
  app().request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

const LEGACY_PASSWORD = [
  ['POST', '/api/auth/login', { email: 'a@b.co', password: 'pw123456' }],
  ['POST', '/api/auth/register', { email: 'a@b.co', password: 'pw123456' }],
  ['POST', '/api/setup/create-admin', { email: 'a@b.co', password: 'pw123456' }],
] as const;
const LEGACY_LINK = [
  ['POST', '/api/auth/login/request-link', { email: 'a@b.co' }],
  ['GET', '/api/auth/login/callback?token=x', null],
  ['POST', '/api/auth/finalize-mobile', { token: 'mh_aaaaaaaaaaaa' }],
] as const;

async function hit(method: string, path: string, body: unknown) {
  return method === 'GET' ? app().request(path) : post(path, body);
}

beforeEach(() => {
  (config as any).allowLegacyLogin = false;
  (config as any).legacyMagicLinkLogin = false;
  (config as any).titaniumBypass = false;
  for (const m of Object.values(dalMocks)) m.mockClear();
});

describe('defaults: every legacy login surface is a 404', () => {
  test('config defaults are off', async () => {
    const fresh = await import(`../src/config.ts?legacy-defaults-${Date.now()}`);
    expect(fresh.config.allowLegacyLogin).toBe(false);
    expect(fresh.config.legacyMagicLinkLogin).toBe(false);
  });

  for (const [method, path, body] of [...LEGACY_PASSWORD, ...LEGACY_LINK]) {
    test(`${method} ${path} → 404, no DB work`, async () => {
      const res = await hit(method, path, body);
      expect(res.status).toBe(404);
      expect(dalMocks.createUser).not.toHaveBeenCalled();
      expect(dalMocks.getUserByEmail).not.toHaveBeenCalled();
      expect(dalMocks.consumeAuthHandoffToken).not.toHaveBeenCalled();
    });
  }

  test('setup/status does not offer the password SetupForm; client-config hides both legacy UIs', async () => {
    const st = await (await app().request('/api/setup/status')).json();
    expect(st.needs_setup).toBe(false);
    const cc = await (await app().request('/api/client-config')).json();
    expect(cc.legacy_password_login).toBe(false);
    expect(cc.legacy_magic_link_login).toBe(false);
  });
});

describe('explicit opt-in re-enables them (rollback path)', () => {
  test('ALLOW_LEGACY_LOGIN=true → password routes reachable (not 404)', async () => {
    (config as any).allowLegacyLogin = true;
    for (const [method, path, body] of LEGACY_PASSWORD) {
      const res = await hit(method, path, body);
      expect(res.status, path).not.toBe(404);
    }
    const cc = await (await app().request('/api/client-config')).json();
    expect(cc.legacy_password_login).toBe(true);
  });

  test('LEGACY_MAGIC_LINK_LOGIN=on → own magic-link routes reachable (not 404)', async () => {
    (config as any).legacyMagicLinkLogin = true;
    for (const [method, path, body] of LEGACY_LINK) {
      const res = await hit(method, path, body);
      expect(res.status, path).not.toBe(404);
    }
  });
});

describe('TITANIUM_BYPASS is a license switch only', () => {
  test('bypass does not enable password login', async () => {
    (config as any).titaniumBypass = true;
    for (const [method, path, body] of LEGACY_PASSWORD) {
      expect((await hit(method, path, body)).status).toBe(404);
    }
  });

  test('bypass does not disable the Titanium hosted login', async () => {
    (config as any).titaniumBypass = true;
    const res = await app().request('/auth/start', { method: 'POST', headers: { origin: config.publicUrl } });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toStartWith('https://auth.titaniumlabs.us/login?');
  });
});
