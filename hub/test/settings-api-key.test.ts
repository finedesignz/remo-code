// Settings via API key: explicit settings:read / settings:write scopes, route allowlist only.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-chars-long-aaaaaaaa';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'session-secret-at-least-32-chars-long-x';
process.env.MAGIC_LINK_SECRET = process.env.MAGIC_LINK_SECRET || 'magic-link-secret-at-least-32-chars-x';
process.env.TITANIUM_KEYGEN_API_URL = process.env.TITANIUM_KEYGEN_API_URL || 'https://keygen.titaniumlabs.us';
process.env.TITANIUM_KEYGEN_ACCOUNT_ID = process.env.TITANIUM_KEYGEN_ACCOUNT_ID || 'acct_test_0000000000';
process.env.TITANIUM_KEYGEN_PRODUCT_ID = process.env.TITANIUM_KEYGEN_PRODUCT_ID || 'prod_test_remo';

import { describe, test, expect, mock, beforeEach, afterAll } from 'bun:test';
import { Hono } from 'hono';

let keyScopes: string[] | null = ['settings:write'];
let keyFound = true;
let lookupThrows = false;

const realSession = await import('../src/session');
mock.module('../src/session.ts', () => ({
  ...realSession,
  verifyAuthSessionCookie: async () => null,
}));
mock.module('../src/db/ask-dal.ts', () => ({
  verifyApiKeyForExt: async () => {
    if (lookupThrows) throw new Error('db down');
    return keyFound ? { id: 'k1', user_id: 'u-key', scopes: keyScopes } : null;
  },
}));

const { authMiddleware } = await import('../src/auth/middleware');
const { requireRecentAuth } = await import('../src/auth/reauth');
const { matchSettingsRoute } = await import('../src/auth/settings-api-key');

afterAll(() => { mock.restore(); });

function buildApp() {
  const app = new Hono();
  app.use('/api/*', authMiddleware);
  // Mirrors the step-up gates in hub/src/index.ts.
  app.use('/api/users/me/profile', requireRecentAuth());
  app.use('/api/supervisors/:id/roots', requireRecentAuth());
  app.use('/api/api-keys', requireRecentAuth());
  const ok = (c: any) => c.json({ userId: c.get('userId'), method: c.get('authMethod') });
  app.get('/api/profile', ok);
  app.patch('/api/profile', ok);
  app.patch('/api/users/me/profile', ok);
  app.put('/api/account/claude-thresholds', ok);
  app.patch('/api/supervisors/:id/roots', ok);
  app.patch('/api/sessions/:id/auto-nudge', ok);
  app.post('/api/api-keys', ok);
  app.get('/api/api-keys', ok);
  app.get('/api/account/coolify-webhook-secret', ok);
  app.patch('/api/users/me/prompts', ok);
  app.patch('/api/sessions/:id/skip-permissions', ok);
  app.get('/api/sessions', ok);
  return app;
}

const bearer = (method: string, body?: unknown) => ({
  method,
  headers: { Authorization: 'Bearer remokey_abc123', 'content-type': 'application/json' },
  body: body ? JSON.stringify(body) : undefined,
});

beforeEach(() => {
  keyScopes = ['settings:write'];
  keyFound = true;
  lookupThrows = false;
});

describe('settings:write key', () => {
  test('changes settings on allowlisted routes', async () => {
    const app = buildApp();
    for (const [m, p] of [
      ['GET', '/api/profile'],
      ['PATCH', '/api/profile'],
      ['PUT', '/api/account/claude-thresholds'],
      ['PATCH', '/api/sessions/s1/auto-nudge'],
    ] as const) {
      const res = await app.request(p, bearer(m, {}));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ userId: 'u-key', method: 'api_key_settings' });
    }
  });

  test('passes the step-up gate on allowlisted settings writes', async () => {
    const app = buildApp();
    expect((await app.request('/api/users/me/profile', bearer('PATCH', {}))).status).toBe(200);
    expect((await app.request('/api/supervisors/sup-1/roots', bearer('PATCH', {}))).status).toBe(200);
  });

  test('can NEVER reach /api/api-keys (an api key must not mint an api key)', async () => {
    const app = buildApp();
    for (const m of ['GET', 'POST']) {
      const res = await app.request('/api/api-keys', bearer(m, {}));
      expect(res.status).toBe(403);
      expect(((await res.json()) as any).error).toBe('api_key_not_allowed');
    }
  });

  test('non-settings routes are 403', async () => {
    const app = buildApp();
    for (const [m, p] of [
      ['GET', '/api/account/coolify-webhook-secret'],
      ['PATCH', '/api/users/me/prompts'],
      ['PATCH', '/api/sessions/s1/skip-permissions'],
      ['GET', '/api/sessions'],
    ] as const) {
      expect((await app.request(p, bearer(m, {}))).status).toBe(403);
    }
  });
});

describe('scope enforcement', () => {
  test('settings:read reads but cannot write', async () => {
    keyScopes = ['settings:read'];
    const app = buildApp();
    expect((await app.request('/api/profile', bearer('GET'))).status).toBe(200);
    const res = await app.request('/api/profile', bearer('PATCH', {}));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'insufficient_scope', required: 'settings:write' });
  });

  test('legacy NULL-scopes key gets NO settings access (explicit-only)', async () => {
    keyScopes = null;
    const app = buildApp();
    expect((await app.request('/api/profile', bearer('GET'))).status).toBe(403);
    expect((await app.request('/api/profile', bearer('PATCH', {}))).status).toBe(403);
  });

  test('ext-only key gets no settings access', async () => {
    keyScopes = ['ext:read', 'ext:ask'];
    const res = await buildApp().request('/api/profile', bearer('GET'));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'insufficient_scope', required: 'settings:read' });
  });

  test('unknown/revoked key is 401', async () => {
    keyFound = false;
    expect((await buildApp().request('/api/profile', bearer('GET'))).status).toBe(401);
  });

  test('lookup failure fails closed (401)', async () => {
    lookupThrows = true;
    expect((await buildApp().request('/api/profile', bearer('GET'))).status).toBe(401);
  });

  test('a non-settings api-key request never passes requireRecentAuth', async () => {
    const res = await buildApp().request('/api/api-keys', bearer('POST', {}));
    expect(res.status).toBe(403);
  });
});

describe('matchSettingsRoute', () => {
  test('anchored: no prefix / suffix smuggling', () => {
    expect(matchSettingsRoute('GET', '/api/profile')).not.toBeNull();
    expect(matchSettingsRoute('GET', '/api/profile/')).not.toBeNull();
    expect(matchSettingsRoute('GET', '/api/profile/cost-today')).toBeNull();
    expect(matchSettingsRoute('PATCH', '/api/supervisors/a/b/roots')).toBeNull();
    expect(matchSettingsRoute('DELETE', '/api/profile')).toBeNull();
    expect(matchSettingsRoute('GET', '/x/api/profile')).toBeNull();
  });
});
