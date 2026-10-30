// Fleet login standard: the Titanium hosted login is the ONLY login. These tests
// fail if an in-app credential surface comes back:
//   - the login entry redirects to the portal with the app slug + an allowlisted
//     (REMO_PUBLIC_URL, https) return_url;
//   - no server-side call to the portal's send-magic-link;
//   - no credential / own-magic-link / handoff / setup route;
//   - the logged-out page offers a button to the redirect and no credential field.

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-chars-long-aaaaaaaa';
process.env.SESSION_SECRET = 'session-secret-at-least-32-chars-long-x';
delete process.env.REMO_PUBLIC_URL; // default https://app.remo-code.com

import { describe, test, expect } from 'bun:test';
import { Hono } from 'hono';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const { titaniumAuthRouter } = await import('../src/api/titanium-auth.ts');
const { authRouter } = await import('../src/api/auth.ts');

const APP = 'https://app.remo-code.com';
const ROOT = resolve(import.meta.dir, '..', '..');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

describe('login entry redirects to the Titanium Labs page', () => {
  test('POST /auth/start -> 303 auth.titaniumlabs.us/login with app_id=remo-code and an https REMO_PUBLIC_URL return_url', async () => {
    const a = new Hono();
    a.route('/auth', titaniumAuthRouter);
    const res = await a.request('/auth/start', { method: 'POST', headers: { origin: APP } });
    expect(res.status).toBe(303);
    const loc = new URL(res.headers.get('location')!);
    expect(`${loc.origin}${loc.pathname}`).toBe('https://auth.titaniumlabs.us/login');
    expect(loc.searchParams.get('app_id')).toBe('remo-code');
    const ret = new URL(loc.searchParams.get('return_url')!);
    expect(ret.protocol).toBe('https:');
    expect(`${ret.origin}${ret.pathname}`).toBe(`${APP}/auth/callback`);
    expect(ret.searchParams.get('state')).toBeTruthy();
  });
});

describe('no credential login route exists', () => {
  test('the /api/auth router serves only logout', async () => {
    const a = new Hono();
    a.route('/api/auth', authRouter);
    for (const [method, path] of [
      ['POST', '/login'], ['POST', '/register'], ['POST', '/login/request-link'],
      ['GET', '/login/callback?token=x'], ['POST', '/finalize-mobile'],
    ] as const) {
      const res = await a.request(`/api/auth${path}`, {
        method,
        headers: { 'content-type': 'application/json' },
        body: method === 'POST' ? '{}' : undefined,
      });
      expect(res.status).toBe(404);
    }
  });

  test('POST /auth/email (in-app email form) does not exist', async () => {
    const a = new Hono();
    a.route('/auth', titaniumAuthRouter);
    const res = await a.request('/auth/email', {
      method: 'POST',
      headers: { origin: APP, 'content-type': 'application/json' },
      body: '{"email":"a@b.co"}',
    });
    expect(res.status).toBe(404);
  });

  test('the first-admin setup route and the hashing module are gone', () => {
    expect(existsSync(join(ROOT, 'hub/src/api/setup.ts'))).toBe(false);
    expect(existsSync(join(ROOT, 'hub/src/auth/pass' + 'word.ts'))).toBe(false);
  });

  test('no source calls the portal send-magic-link or reads a legacy login flag / magic-link secret', () => {
    const banned = /send-magic-link|sendTitaniumMagicLink|ALLOW_LEGACY_LOGIN|allowLegacyLogin|LEGACY_MAGIC_LINK_LOGIN|MAGIC_LINK_SECRET|TURNSTILE_BYPASS/;
    const hits = [...walk(join(ROOT, 'hub/src')), ...walk(join(ROOT, 'web/src'))].filter((f) => banned.test(readFileSync(f, 'utf8')));
    expect(hits).toEqual([]);
  });
});

describe('logged-out page', () => {
  const login = readFileSync(join(ROOT, 'web/src/pages/Login.tsx'), 'utf8');
  test('has a visible button to the /auth/start redirect and no credential field', () => {
    expect(login).toContain('titaniumStartAction()');
    expect(login).toContain('Sign in with Titanium Labs');
    expect(login).not.toMatch(/<input/);
  });
});
