// Titanium hosted login (hub/src/api/titanium-auth.ts) — the login-binding
// protections of titanium-licensing README §3.3 / §3.3.1 / §3.3.2 and tauri.md.
//
// Every test here is written so it FAILS if the protection it names is removed:
//   - Origin required on every state-setting POST (/auth/email, /auth/start) and on
//     the minting POSTs (/auth/confirm, /auth/app-finalize); logout refuses only a
//     foreign Origin.
//   - state mismatch / missing state cookie → confirmation page, no session.
//   - confirm POST needs a valid remo_confirm cookie + the matching csrf + same Origin.
//   - appSlug missing / different → refused; non-JSON exchange → refused; empty email
//     → refused; app_slug always sent; PKCE verifier sent (hosted button + app leg).
//   - pending-cookie attributes; logout clears cookies and POSTs to the portal.
//   - purpose / alg pinning of the signed pending tokens.
// The DB is mocked (dal + linker seam); the real session.ts / csrf.ts run, so the
// Set-Cookie headers asserted below are the production ones.

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-chars-long-aaaaaaaa';
process.env.SESSION_SECRET = 'session-secret-at-least-32-chars-long-x';
delete process.env.REMO_PUBLIC_URL; // default https://app.remo-code.com
process.env.TITANIUM_REQUIRE_REDIS = 'false';

import { describe, test, expect, mock, beforeEach, afterAll } from 'bun:test';
import { Hono } from 'hono';
import { SignJWT } from 'jose';

const realDal = await import('../src/db/dal.ts');
const dalMocks = {
  recordAuthEvent: mock(async () => {}),
  deleteAuthSession: mock(async () => {}),
  createAuthSession: mock(async () => ({ token: 'remo_freshtoken', id: 'sha', expiresAt: new Date(Date.now() + 3600_000) })),
};
mock.module('../src/db/dal.ts', () => ({ ...realDal, ...dalMocks }));

const { titaniumAuthRouter, __setLinkerForTesting } = await import('../src/api/titanium-auth.ts');
const tl = await import('../src/auth/titanium-login.ts');
const { signPurposeToken, verifyPurposeToken, deriveKey, SessionSecretError } = await import('../src/auth/purpose-tokens.ts');
const { config } = await import('../src/config.ts');
const { securityHeaders } = await import('../src/middleware/security-headers.ts');

const APP = 'https://app.remo-code.com';
const PORTAL = 'https://license.titaniumlabs.us';

// ── fetch mock (portal) ─────────────────────────────────────────────────────
type Call = { url: string; body: any };
let calls: Call[] = [];
let exchangeReply: () => Response = () => json({ appSlug: 'remo-code', email: ' Owner@Example.com ', accountId: 'acc-1', licenseKey: null });
function json(b: unknown, status = 200) {
  return new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
}
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = String(input);
  const body = init?.body ? JSON.parse(init.body) : null;
  calls.push({ url, body });
  if (url === `${PORTAL}/api/exchange`) return exchangeReply();
  if (url === `${PORTAL}/api/auth/send-magic-link`) return json({ ok: true });
  return new Response('unexpected', { status: 599 });
}) as any;
afterAll(() => { globalThis.fetch = realFetch; });

// ── linker seam ─────────────────────────────────────────────────────────────
let linkCalls: any[] = [];
let linkResult: any = { ok: true, userId: 'user-1', linked: 'account_id' };
__setLinkerForTesting(async (opts: any) => {
  linkCalls.push(opts);
  if (linkResult instanceof Error) throw linkResult;
  return linkResult;
});

function app() {
  const a = new Hono();
  a.route('/auth', titaniumAuthRouter);
  return a;
}

beforeEach(() => {
  calls = [];
  linkCalls = [];
  linkResult = { ok: true, userId: 'user-1', linked: 'account_id' };
  exchangeReply = () => json({ appSlug: 'remo-code', email: ' Owner@Example.com ', accountId: 'acc-1', licenseKey: null });
  for (const m of Object.values(dalMocks)) m.mockClear();
});

const flush = () => new Promise((r) => setTimeout(r, 5));

function setCookies(res: Response): string[] {
  return (res.headers as any).getSetCookie?.() ?? [];
}
function cookieValue(res: Response, name: string): string | null {
  for (const c of setCookies(res)) {
    if (c.startsWith(`${name}=`)) return decodeURIComponent(c.slice(name.length + 1).split(';')[0]);
  }
  return null;
}
function cookieHeader(res: Response, name: string): string | undefined {
  return setCookies(res).find((c) => c.startsWith(`${name}=`));
}
function hasSession(res: Response): boolean {
  return setCookies(res).some((c) => c.startsWith('__Host-remo_sid=') && !/Max-Age=0/i.test(c) && !c.startsWith('__Host-remo_sid=;'));
}

async function startEmail(opts: { origin?: string | null; email?: string; client?: string } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.origin !== null) headers.origin = opts.origin ?? APP;
  return app().request('/auth/email', {
    method: 'POST',
    headers,
    body: JSON.stringify({ email: opts.email ?? 'owner@example.com', ...(opts.client ? { client: opts.client } : {}) }),
  });
}
async function startHosted(origin: string | null = APP) {
  const headers: Record<string, string> = {};
  if (origin !== null) headers.origin = origin;
  return app().request('/auth/start', { method: 'POST', headers });
}

// ─────────────────────────────────────────────────────────────────────────────

describe('login START requires Origin == hub origin (planted-state defense)', () => {
  test('/auth/email: missing Origin → 403, no state cookie, no portal call', async () => {
    const res = await startEmail({ origin: null });
    expect(res.status).toBe(403);
    expect(cookieValue(res, 'remo_login')).toBeNull();
    await flush();
    expect(calls).toHaveLength(0);
  });
  test('/auth/email: foreign Origin → 403, no state cookie', async () => {
    const res = await startEmail({ origin: 'https://evil.example' });
    expect(res.status).toBe(403);
    expect(cookieValue(res, 'remo_login')).toBeNull();
  });
  test('/auth/start: missing or foreign Origin → no state cookie, no redirect to the hosted login', async () => {
    for (const o of [null, 'https://evil.example']) {
      const res = await startHosted(o);
      expect(res.status).toBe(303);
      expect(res.headers.get('location')).toBe('/#/login?error=origin_not_allowed');
      expect(cookieValue(res, 'remo_login')).toBeNull();
    }
  });
});

describe('POST /auth/email (web)', () => {
  test('sets remo_login (HttpOnly, Secure, SameSite=Lax, Path=/auth, 15 min) and mails a link bound to that state', async () => {
    const res = await startEmail();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const h = cookieHeader(res, 'remo_login')!;
    expect(h).toMatch(/HttpOnly/);
    expect(h).toMatch(/Secure/);
    expect(h).toMatch(/SameSite=Lax/);
    expect(h).toMatch(/Path=\/auth(;|$)/);
    expect(h).toMatch(/Max-Age=900/);

    await flush();
    const send = calls.find((c) => c.url === `${PORTAL}/api/auth/send-magic-link`)!;
    expect(send.body.appId).toBe('remo-code');
    expect(send.body.email).toBe('owner@example.com');
    const ret = new URL(send.body.returnUrl);
    expect(ret.origin + ret.pathname).toBe(`${APP}/auth/callback`);
    const pending = await tl.readPendingLogin(cookieValue(res, 'remo_login'));
    expect(ret.searchParams.get('state')).toBe(pending!.state);
    // No PKCE on the web email path (cross-device links must still work via confirm).
    expect(ret.searchParams.get('code_challenge')).toBeNull();
    expect(pending!.client).toBe('web');
  });

  test('same answer for every address; a rate-limited request sends nothing', async () => {
    const a = await startEmail({ email: 'known@example.com' });
    const b = await startEmail({ email: 'nobody-here@example.com' });
    expect(await a.json()).toEqual(await b.json());

    const limited = new Hono();
    limited.use('/auth/email', async (c, next) => { c.set('rateLimited' as never, true as never); await next(); });
    limited.route('/auth', titaniumAuthRouter);
    calls = [];
    const r = await limited.request('/auth/email', { method: 'POST', headers: { origin: APP, 'content-type': 'application/json' }, body: JSON.stringify({ email: 'x@example.com' }) });
    expect(await r.json()).toEqual({ ok: true });
    await flush();
    expect(calls).toHaveLength(0);
  });

  test('invalid email → 400, no cookie', async () => {
    const res = await startEmail({ email: 'not-an-email' });
    expect(res.status).toBe(400);
    expect(cookieValue(res, 'remo_login')).toBeNull();
  });
});

describe('POST /auth/start (hosted login, PKCE)', () => {
  test('303 to the hosted login; return_url carries state + S256 challenge of the verifier in the cookie', async () => {
    const res = await startHosted();
    expect(res.status).toBe(303);
    const loc = new URL(res.headers.get('location')!);
    expect(loc.origin + loc.pathname).toBe('https://auth.titaniumlabs.us/login');
    expect(loc.searchParams.get('app_id')).toBe('remo-code');
    const ret = new URL(loc.searchParams.get('return_url')!);
    const pending = await tl.readPendingLogin(cookieValue(res, 'remo_login'));
    expect(pending!.verifier).toBeTruthy();
    expect(ret.searchParams.get('state')).toBe(pending!.state);
    expect(ret.searchParams.get('code_challenge')).toBe(tl.pkceChallenge(pending!.verifier!));
    expect(ret.searchParams.get('code_challenge_method')).toBe('S256');
  });
});

async function pendingCookie(opts: { pkce?: boolean; client?: 'web' | 'app' } = {}) {
  return tl.newPendingLogin({ pkce: opts.pkce ?? false, client: opts.client ?? 'web' });
}
function callback(qs: string, cookie?: string) {
  return app().request(`/auth/callback?${qs}`, { headers: cookie ? { cookie } : {} });
}

describe('GET /auth/callback', () => {
  test('state matches → exchange with app_slug + code_verifier, link, mint session, clear remo_login', async () => {
    const p = await pendingCookie({ pkce: true });
    const res = await callback(`state=${p.state}&act=act_1`, `remo_login=${p.token}`);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/');
    const ex = calls.find((c) => c.url === `${PORTAL}/api/exchange`)!;
    expect(ex.body).toEqual({ act: 'act_1', app_slug: 'remo-code', code_verifier: p.verifier });
    expect(linkCalls[0]).toMatchObject({ email: 'owner@example.com', accountId: 'acc-1' });
    expect(hasSession(res)).toBe(true);
    expect(cookieHeader(res, 'csrf_token')).toBeDefined();
    expect(cookieHeader(res, 'remo_login')).toMatch(/Max-Age=0/);
  });

  test('state MISMATCH → no session; identity parked in remo_confirm; 303 /auth/confirm; no verifier sent', async () => {
    const p = await pendingCookie({ pkce: true });
    const res = await callback(`state=attacker-state&act=act_2`, `remo_login=${p.token}`);
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/auth/confirm');
    expect(hasSession(res)).toBe(false);
    expect(dalMocks.createAuthSession).not.toHaveBeenCalled();
    expect(linkCalls).toHaveLength(0);
    const ex = calls.find((c) => c.url === `${PORTAL}/api/exchange`)!;
    expect(ex.body).toEqual({ act: 'act_2', app_slug: 'remo-code' });
    const conf = await tl.readPendingConfirm(cookieValue(res, 'remo_confirm'));
    expect(conf!.email).toBe('owner@example.com');
    expect(cookieHeader(res, 'remo_confirm')).toMatch(/Max-Age=300/);
  });

  for (const [name, cookieFor] of [
    ['state MISMATCH', async () => `remo_login=${(await pendingCookie({ pkce: true })).token}`],
    ['no remo_login cookie', async () => undefined],
  ] as const) {
    test(`${name} + code_challenge (hosted PKCE login) → NO exchange; 400 "finish where you started"; nothing minted or cleared`, async () => {
      const cookie = await cookieFor();
      const res = await app().request(
        `/auth/callback?state=other-browser&code_challenge=Q2hhbGxlbmdl&code_challenge_method=S256&act=act_pk`,
        { headers: { cookie: [cookie, '__Host-remo_sid=remo_existing'].filter(Boolean).join('; ') } },
      );
      expect(res.status).toBe(400);
      const body = await res.text();
      expect(body).toContain('Finish signing in in the browser where you started, or start again.');
      expect(body).toContain('href="/#/login"');
      expect(calls).toHaveLength(0); // the act is not spent
      expect(setCookies(res)).toEqual([]); // no confirm cookie, session and pending login untouched
      expect(dalMocks.createAuthSession).not.toHaveBeenCalled();
      expect(dalMocks.deleteAuthSession).not.toHaveBeenCalled();
      expect(linkCalls).toHaveLength(0);
    });
  }

  test('state matches + code_challenge → still exchanged with the verifier (unchanged)', async () => {
    const p = await pendingCookie({ pkce: true });
    const res = await callback(`state=${p.state}&code_challenge=${p.challenge}&code_challenge_method=S256&act=act_ok`, `remo_login=${p.token}`);
    expect(res.headers.get('location')).toBe('/');
    expect(calls.find((c) => c.url === `${PORTAL}/api/exchange`)!.body).toEqual({ act: 'act_ok', app_slug: 'remo-code', code_verifier: p.verifier });
    expect(hasSession(res)).toBe(true);
  });

  test('the remo_confirm cookie never carries the license key (raw value and decoded segments)', async () => {
    const licenseKey = 'key/eyJsaWNlbnNlIjp7ImlkIjoiTElDLVNFQ1JFVC05OSJ9fQ.c2ln';
    exchangeReply = () => json({ appSlug: 'remo-code', email: 'owner@example.com', accountId: 'acc-1', licenseKey });
    const res = await callback(`state=x&act=act_lk`);
    expect(res.headers.get('location')).toBe('/auth/confirm');
    const raw = cookieHeader(res, 'remo_confirm')!;
    const value = cookieValue(res, 'remo_confirm')!;
    const decoded = value.split('.').map((part) => Buffer.from(part, 'base64url').toString('latin1')).join('|');
    for (const secret of [licenseKey, 'LIC-SECRET-99', 'licenseKey']) {
      expect(raw).not.toContain(secret);
      expect(decoded).not.toContain(secret);
    }
  });

  test('no remo_login cookie at all → confirmation page, no session', async () => {
    const res = await callback(`state=whatever&act=act_3`);
    expect(res.headers.get('location')).toBe('/auth/confirm');
    expect(hasSession(res)).toBe(false);
  });

  test('an app-shell pending cookie never satisfies the WEB callback', async () => {
    const p = await pendingCookie({ pkce: true, client: 'app' });
    const res = await callback(`state=${p.state}&act=act_4`, `remo_login=${p.token}`);
    expect(res.headers.get('location')).toBe('/auth/confirm');
    expect(hasSession(res)).toBe(false);
  });

  test('appSlug missing or for another app → refused, no session (fail closed)', async () => {
    for (const reply of [
      { email: 'owner@example.com', accountId: 'a' },
      { email: 'owner@example.com', appSlug: 'other-app' },
    ]) {
      exchangeReply = () => json(reply);
      const p = await pendingCookie();
      const res = await callback(`state=${p.state}&act=act`, `remo_login=${p.token}`);
      expect(res.headers.get('location')).toBe('/#/login?error=wrong_app');
      expect(hasSession(res)).toBe(false);
      expect(linkCalls).toHaveLength(0);
    }
  });

  test('non-JSON / non-2xx / empty-email exchange → refused, no session', async () => {
    const replies = [
      () => new Response('<html>oops</html>', { status: 200, headers: { 'content-type': 'text/html' } }),
      () => json({ error: 'token_not_found' }, 404),
      () => json({ appSlug: 'remo-code', email: '   ' }),
      () => json(['not', 'an', 'object']),
    ];
    for (const r of replies) {
      exchangeReply = r;
      const p = await pendingCookie();
      const res = await callback(`state=${p.state}&act=act`, `remo_login=${p.token}`);
      expect(res.headers.get('location')).toBe('/#/login?error=exchange_failed');
      expect(hasSession(res)).toBe(false);
    }
  });

  test('missing act → error, nothing called', async () => {
    const res = await callback('state=s');
    expect(res.headers.get('location')).toBe('/#/login?error=missing_act');
    expect(calls).toHaveLength(0);
  });

  test('linking refusal (no account / conflict) → error redirect, no session', async () => {
    for (const reason of ['no_account', 'account_conflict', 'account_ambiguous']) {
      linkResult = { ok: false, reason };
      const p = await pendingCookie();
      const res = await callback(`state=${p.state}&act=act`, `remo_login=${p.token}`);
      expect(res.headers.get('location')).toBe(`/#/login?error=${reason}`);
      expect(hasSession(res)).toBe(false);
      expect(dalMocks.createAuthSession).not.toHaveBeenCalled();
    }
  });

  test('a mint failure is the normal error redirect, never an unhandled 500', async () => {
    linkResult = new Error('db down');
    const p = await pendingCookie();
    const res = await callback(`state=${p.state}&act=act`, `remo_login=${p.token}`);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/#/login?error=server_misconfigured');
  });

  test('fresh-session invariant: the inbound session row is revoked only AFTER the new one exists', async () => {
    const order: string[] = [];
    dalMocks.createAuthSession.mockImplementationOnce(async () => {
      order.push('create');
      return { token: 'remo_freshtoken', id: 'sha', expiresAt: new Date(Date.now() + 3600_000) };
    });
    dalMocks.deleteAuthSession.mockImplementationOnce(async () => { order.push('delete'); });
    const p = await pendingCookie();
    const res = await callback(`state=${p.state}&act=act`, `remo_login=${p.token}; __Host-remo_sid=remo_old`);
    expect(hasSession(res)).toBe(true);
    expect(dalMocks.deleteAuthSession).toHaveBeenCalledWith('remo_old');
    expect(order).toEqual(['create', 'delete']);
  });
});

async function confirmPost(opts: { origin?: string | null; cookie?: string; csrf?: string; intent?: string }) {
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' };
  if (opts.origin !== null) headers.origin = opts.origin ?? APP;
  if (opts.cookie) headers.cookie = opts.cookie;
  const body = new URLSearchParams();
  if (opts.csrf !== undefined) body.set('csrf', opts.csrf);
  body.set('intent', opts.intent ?? 'confirm');
  return app().request('/auth/confirm', { method: 'POST', headers, body: body.toString() });
}

describe('/auth/confirm', () => {
  test('GET renders the masked account and the csrf; never the full address', async () => {
    const { token, csrf } = await tl.newPendingConfirm({ email: 'owner@example.com' });
    const res = await app().request('/auth/confirm', { headers: { cookie: `remo_confirm=${token}` } });
    const html = await res.text();
    expect(html).toContain('o***@example.com');
    expect(html).not.toContain('owner@example.com');
    expect(html).toContain(`value="${csrf}"`);
    expect(html).toContain('action="/auth/confirm"');
  });

  test('GET without a valid cookie → back to login', async () => {
    const res = await app().request('/auth/confirm');
    expect(res.headers.get('location')).toBe('/#/login?error=confirm_expired');
  });

  test('POST with cookie + csrf + same Origin → mints', async () => {
    const { token, csrf } = await tl.newPendingConfirm({ email: 'owner@example.com', accountId: 'acc-9' });
    const res = await confirmPost({ cookie: `remo_confirm=${token}`, csrf });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/');
    expect(hasSession(res)).toBe(true);
    expect(linkCalls[0]).toMatchObject({ email: 'owner@example.com', accountId: 'acc-9' });
    expect(cookieHeader(res, 'remo_confirm')).toMatch(/Max-Age=0/);
  });

  test('POST with missing or foreign Origin → refused, no session', async () => {
    const { token, csrf } = await tl.newPendingConfirm({ email: 'owner@example.com' });
    for (const origin of [null, 'https://evil.example']) {
      const res = await confirmPost({ origin, cookie: `remo_confirm=${token}`, csrf });
      expect(res.headers.get('location')).toBe('/#/login?error=confirm_failed');
      expect(hasSession(res)).toBe(false);
    }
  });

  test('POST with a wrong / missing csrf → refused', async () => {
    const { token } = await tl.newPendingConfirm({ email: 'owner@example.com' });
    for (const csrf of ['wrong', undefined]) {
      const res = await confirmPost({ cookie: `remo_confirm=${token}`, csrf });
      expect(res.headers.get('location')).toBe('/#/login?error=confirm_expired');
      expect(hasSession(res)).toBe(false);
    }
  });

  test('POST without the cookie (csrf alone) → refused', async () => {
    const { csrf } = await tl.newPendingConfirm({ email: 'owner@example.com' });
    const res = await confirmPost({ csrf });
    expect(hasSession(res)).toBe(false);
  });

  test('a pending-LOGIN token presented as remo_confirm is refused (purpose binding)', async () => {
    const p = await pendingCookie();
    const res = await confirmPost({ cookie: `remo_confirm=${p.token}`, csrf: p.state });
    expect(hasSession(res)).toBe(false);
  });

  test('cancel → no session, cookie cleared', async () => {
    const { token, csrf } = await tl.newPendingConfirm({ email: 'owner@example.com' });
    const res = await confirmPost({ cookie: `remo_confirm=${token}`, csrf, intent: 'cancel' });
    expect(res.headers.get('location')).toBe('/#/login');
    expect(hasSession(res)).toBe(false);
    expect(linkCalls).toHaveLength(0);
  });
});

function appFinalize(body: unknown, opts: { origin?: string | null; cookie?: string } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.origin !== null) headers.origin = opts.origin ?? APP;
  if (opts.cookie) headers.cookie = opts.cookie;
  return app().request('/auth/app-finalize', { method: 'POST', headers, body: JSON.stringify(body) });
}

describe('Tauri shell leg (remo-code:// deep link, PKCE + app_slug)', () => {
  test('/auth/email {client:"app"} → remo-code://auth/callback return with an S256 challenge', async () => {
    const res = await startEmail({ client: 'app' });
    await flush();
    const send = calls.find((c) => c.url.endsWith('/send-magic-link'))!;
    const ret = new URL(send.body.returnUrl);
    expect(`${ret.protocol}//${ret.host}${ret.pathname}`).toBe('remo-code://auth/callback');
    const pending = await tl.readPendingLogin(cookieValue(res, 'remo_login'));
    expect(pending!.client).toBe('app');
    expect(ret.searchParams.get('code_challenge')).toBe(tl.pkceChallenge(pending!.verifier!));
  });

  test('matching state → exchange with code_verifier + app_slug → session', async () => {
    const p = await pendingCookie({ pkce: true, client: 'app' });
    const res = await appFinalize({ state: p.state, act: 'act_m' }, { cookie: `remo_login=${p.token}` });
    expect(res.status).toBe(200);
    expect(calls.find((c) => c.url.endsWith('/api/exchange'))!.body).toEqual({ act: 'act_m', app_slug: 'remo-code', code_verifier: p.verifier });
    expect(hasSession(res)).toBe(true);
  });

  test('state mismatch / no cookie / web cookie → 401, act never redeemed, no confirm fallback', async () => {
    const appP = await pendingCookie({ pkce: true, client: 'app' });
    const webP = await pendingCookie({ pkce: true, client: 'web' });
    for (const [body, cookie] of [
      [{ state: 'nope', act: 'a' }, `remo_login=${appP.token}`],
      [{ state: appP.state, act: 'a' }, undefined],
      [{ state: webP.state, act: 'a' }, `remo_login=${webP.token}`],
    ] as const) {
      const res = await appFinalize(body, { cookie });
      expect(res.status).toBe(401);
      expect(hasSession(res)).toBe(false);
      expect(cookieValue(res, 'remo_confirm')).toBeNull();
    }
    expect(calls).toHaveLength(0);
  });

  test('missing / foreign / lookalike Origin → 403', async () => {
    const p = await pendingCookie({ pkce: true, client: 'app' });
    for (const origin of [null, '', 'null', 'https://evil.example', 'tauri://localhost.evil.example', 'tauri://evil', 'https://tauri.localhost.evil.example', 'http://localhost', 'https://app.remo-code.com.evil.example']) {
      const res = await appFinalize({ state: p.state, act: 'a' }, { origin, cookie: `remo_login=${p.token}` });
      expect(res.status).toBe(403);
    }
    expect(calls).toHaveLength(0);
  });

  test('the Tauri WebView\'s own origin is admitted on the app leg (exact configured values) → session (Tauri cookie variant)', async () => {
    for (const origin of ['tauri://localhost', 'http://tauri.localhost', 'https://tauri.localhost']) {
      calls = [];
      const p = await pendingCookie({ pkce: true, client: 'app' });
      const res = await appFinalize({ state: p.state, act: 'act_t' }, { origin, cookie: `remo_login=${p.token}` });
      expect(res.status).toBe(200);
      expect(calls.find((c) => c.url.endsWith('/api/exchange'))!.body).toEqual({ act: 'act_t', app_slug: 'remo-code', code_verifier: p.verifier });
      expect(setCookies(res).some((c) => c.startsWith('remo_sid=') && /SameSite=None/.test(c) && /Partitioned/.test(c))).toBe(true);
      expect(res.headers.get('access-control-allow-origin')).toBe(origin);
      expect(res.headers.get('access-control-allow-credentials')).toBe('true');
    }
  });

  test('a Tauri origin still needs the matching state cookie (no state → 401, act not redeemed)', async () => {
    const res = await appFinalize({ state: 'x', act: 'a' }, { origin: 'tauri://localhost' });
    expect(res.status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  test('/auth/email {client:"app"} from the Tauri origin → 200; remo_login is SameSite=None; Secure; Partitioned (cross-site jar)', async () => {
    const res = await startEmail({ client: 'app', origin: 'tauri://localhost' });
    expect(res.status).toBe(200);
    const h = cookieHeader(res, 'remo_login')!;
    expect(h).toMatch(/SameSite=None/);
    expect(h).toMatch(/Secure/);
    expect(h).toMatch(/Partitioned/);
    expect(h).toMatch(/HttpOnly/);
    expect(h).toMatch(/Path=\/auth/);
    expect(res.headers.get('access-control-allow-origin')).toBe('tauri://localhost');
    await flush();
    const send = calls.find((c) => c.url.endsWith('/send-magic-link'))!;
    expect(send.body.returnUrl.startsWith('remo-code://auth/callback?')).toBe(true);
  });

  test('the Tauri origin is NOT a web-leg origin: /auth/email (web), /auth/start, /auth/confirm refuse it', async () => {
    const web = await startEmail({ origin: 'tauri://localhost' });
    expect(web.status).toBe(403);
    expect(cookieHeader(web, 'remo_login')).toBeUndefined();
    const start = await startHosted('tauri://localhost');
    expect(start.headers.get('location')).toBe('/#/login?error=origin_not_allowed');
    expect(cookieHeader(start, 'remo_login')).toBeUndefined();
    const { token, csrf } = await tl.newPendingConfirm({ email: 'owner@example.com' });
    const conf = await confirmPost({ origin: 'tauri://localhost', cookie: `remo_confirm=${token}`, csrf });
    expect(hasSession(conf)).toBe(false);
    expect(dalMocks.createAuthSession).not.toHaveBeenCalled();
    await flush();
    expect(calls).toHaveLength(0);
  });

  test('MOBILE_TAURI_ORIGINS_ENABLED=false → the Tauri origin is refused on the app leg too', async () => {
    const prev = config.mobileTauriOriginsEnabled;
    (config as any).mobileTauriOriginsEnabled = false;
    try {
      const p = await pendingCookie({ pkce: true, client: 'app' });
      const res = await appFinalize({ state: p.state, act: 'a' }, { origin: 'tauri://localhost', cookie: `remo_login=${p.token}` });
      expect(res.status).toBe(403);
      const email = await startEmail({ client: 'app', origin: 'tauri://localhost' });
      expect(email.status).toBe(403);
      expect(calls).toHaveLength(0);
    } finally {
      (config as any).mobileTauriOriginsEnabled = prev;
    }
  });

  test('CORS preflight: allowed only for the exact Tauri origins, never a foreign one, never on web-leg routes', async () => {
    const pre = (path: string, origin: string) =>
      app().request(path, { method: 'OPTIONS', headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' } });
    for (const path of ['/auth/email', '/auth/app-finalize']) {
      const ok = await pre(path, 'tauri://localhost');
      expect(ok.headers.get('access-control-allow-origin')).toBe('tauri://localhost');
      expect(ok.headers.get('access-control-allow-credentials')).toBe('true');
      const bad = await pre(path, 'https://evil.example');
      expect(bad.headers.get('access-control-allow-origin')).toBeNull();
    }
    for (const path of ['/auth/start', '/auth/confirm', '/auth/logout']) {
      const r = await pre(path, 'tauri://localhost');
      expect(r.headers.get('access-control-allow-origin')).toBeNull();
    }
  });

  test('another app\'s act on the deep link → refused', async () => {
    exchangeReply = () => json({ appSlug: 'other', email: 'owner@example.com' });
    const p = await pendingCookie({ pkce: true, client: 'app' });
    const res = await appFinalize({ state: p.state, act: 'a' }, { cookie: `remo_login=${p.token}` });
    expect(res.status).toBe(401);
    expect(hasSession(res)).toBe(false);
  });
});

describe('logout through the portal', () => {
  const PORTAL_LOGOUT = `https://auth.titaniumlabs.us/api/auth/logout?return_url=${encodeURIComponent(`${APP}/#/login?signed_out=1`)}`;

  test('POST /auth/logout (missing Origin ok) clears session + csrf + pending cookies → 303 GET portal logout', async () => {
    const res = await app().request('/auth/logout', { method: 'POST', headers: { cookie: '__Host-remo_sid=remo_x' } });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(PORTAL_LOGOUT);
    const body = await res.text();
    expect(body).not.toMatch(/<script|<form/i);
    expect(dalMocks.deleteAuthSession).toHaveBeenCalledWith('remo_x');
    for (const n of ['__Host-remo_sid', 'csrf_token', 'remo_login', 'remo_confirm']) {
      expect(cookieHeader(res, n), n).toMatch(/Max-Age=0/);
    }
  });

  test('foreign Origin → 403, session untouched', async () => {
    const res = await app().request('/auth/logout', { method: 'POST', headers: { origin: 'https://evil.example', cookie: '__Host-remo_sid=remo_x' } });
    expect(res.status).toBe(403);
    expect(dalMocks.deleteAuthSession).not.toHaveBeenCalled();
  });

  test('the portal logout target is a GET URL on the auth host with an encoded app return_url', () => {
    const url = new URL(PORTAL_LOGOUT);
    expect(url.origin + url.pathname).toBe('https://auth.titaniumlabs.us/api/auth/logout');
    expect([...url.searchParams.keys()]).toEqual(['return_url']);
    expect(url.searchParams.get('return_url')).toBe(`${APP}/#/login?signed_out=1`);
    expect(PORTAL_LOGOUT).toContain('%23%2Flogin%3Fsigned_out%3D1');
  });

  test('legacy GET /auth/signed-out neither touches cookies nor hops to Titanium', async () => {
    const res = await app().request('/auth/signed-out', { headers: { cookie: '__Host-remo_sid=remo_x' } });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`${APP}/#/login`);
    expect(res.headers.get('location')).not.toContain('titaniumlabs');
    expect(res.headers.getSetCookie()).toEqual([]);
    expect(dalMocks.deleteAuthSession).not.toHaveBeenCalled();
    expect(await res.text()).not.toMatch(/<script|<form|\.submit\(/i);
  });

  test('CSP form-action admits exactly the Titanium auth host (needed for the 303s after /auth/start and /auth/logout)', async () => {
    const a = new Hono();
    a.use('*', securityHeaders());
    a.get('/x', (c) => c.text('ok'));
    const csp = (await a.request('/x')).headers.get('content-security-policy')!;
    expect(csp).toContain("form-action 'self' https://auth.titaniumlabs.us;");
  });
});

describe('signed pending tokens: purpose + alg pinning, per-purpose keys', () => {
  test('a pending-login token is not a pending-confirm token and vice versa', async () => {
    const login = await signPurposeToken('pending-login', { state: 's', client: 'web' }, 60);
    const confirm = await signPurposeToken('pending-confirm', { email: 'a@b.co', csrf: 'c' }, 60);
    expect(await verifyPurposeToken('pending-confirm', login)).toBeNull();
    expect(await verifyPurposeToken('pending-login', confirm)).toBeNull();
    expect(await tl.readPendingConfirm(login)).toBeNull();
    expect(await tl.readPendingLogin(confirm)).toBeNull();
  });

  test('right purpose claim but signed with ANOTHER purpose key → refused', async () => {
    const forged = await new SignJWT({ purpose: 'pending-login', state: 's' })
      .setProtectedHeader({ alg: 'HS256' }).setExpirationTime('1m').sign(deriveKey('pending-confirm'));
    expect(await verifyPurposeToken('pending-login', forged)).toBeNull();
  });

  test('right purpose KEY but a missing / different purpose claim → refused', async () => {
    for (const claims of [{ state: 's' }, { purpose: 'session', state: 's' }]) {
      const t = await new SignJWT(claims).setProtectedHeader({ alg: 'HS256' }).setExpirationTime('1m').sign(deriveKey('pending-login'));
      expect(await verifyPurposeToken('pending-login', t)).toBeNull();
    }
  });

  test('signed with the raw SESSION_SECRET (no HKDF) → refused', async () => {
    const raw = await new SignJWT({ purpose: 'pending-login', state: 's' })
      .setProtectedHeader({ alg: 'HS256' }).setExpirationTime('1m')
      .sign(new TextEncoder().encode(process.env.SESSION_SECRET!));
    expect(await verifyPurposeToken('pending-login', raw)).toBeNull();
  });

  test('alg none and HS512 (same key) → refused', async () => {
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const none = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ purpose: 'pending-login', state: 's', exp: Math.floor(Date.now() / 1000) + 60 })}.`;
    expect(await verifyPurposeToken('pending-login', none)).toBeNull();
    const hs512 = await new SignJWT({ purpose: 'pending-login', state: 's' })
      .setProtectedHeader({ alg: 'HS512' }).setExpirationTime('1m').sign(deriveKey('pending-login'));
    expect(await verifyPurposeToken('pending-login', hs512)).toBeNull();
  });

  test('expired → refused; SESSION_SECRET unset or < 32 chars → fails closed', async () => {
    const t = await signPurposeToken('pending-login', { state: 's' }, 1);
    await new Promise((r) => setTimeout(r, 2100));
    expect(await verifyPurposeToken('pending-login', t)).toBeNull();

    const saved = process.env.SESSION_SECRET;
    try {
      process.env.SESSION_SECRET = 'short';
      expect(() => deriveKey('pending-login')).toThrow(SessionSecretError);
      delete process.env.SESSION_SECRET;
      expect(() => deriveKey('pending-login')).toThrow(SessionSecretError);
      // and the start route answers a refusal, not a fallback key
      const res = await startHosted();
      expect(res.headers.get('location')).toBe('/#/login?error=server_misconfigured');
      expect(cookieValue(res, 'remo_login')).toBeNull();
    } finally {
      process.env.SESSION_SECRET = saved;
    }
  });
});

describe('return URLs come from REMO_PUBLIC_URL, never the Host header', () => {
  test('a spoofed Host does not change the callback origin', async () => {
    const res = await app().request('/auth/start', { method: 'POST', headers: { origin: APP, host: 'evil.example' } });
    const ret = new URL(new URL(res.headers.get('location')!).searchParams.get('return_url')!);
    expect(ret.origin).toBe(config.publicUrl);
  });
});

// ── No logout CSRF: a failed login never touches the inbound session ───────
describe('a failed login keeps the existing session (cookie and row)', () => {
  const EXISTING = '__Host-remo_sid=remo_existing';
  function expectSessionUntouched(res: Response) {
    expect(cookieHeader(res, '__Host-remo_sid')).toBeUndefined(); // neither cleared nor replaced
    expect(dalMocks.deleteAuthSession).not.toHaveBeenCalled(); // the DB row survives
  }
  const failures: Array<[string, () => void]> = [
    ['exchange failure', () => { exchangeReply = () => json({ error: 'token_not_found' }, 404); }],
    ['link conflict', () => { linkResult = { ok: false, reason: 'account_conflict' }; }],
    ['unknown identity', () => { linkResult = { ok: false, reason: 'no_account' }; }],
    ['session-create error', () => { dalMocks.createAuthSession.mockImplementationOnce(async () => { throw new Error('db down'); }); }],
  ];

  for (const [name, arrange] of failures) {
    test(`GET /auth/callback (matched state), ${name}`, async () => {
      arrange();
      const p = await pendingCookie({ pkce: true });
      const res = await callback(`state=${p.state}&act=act_f`, `remo_login=${p.token}; ${EXISTING}`);
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toMatch(/^\/#\/login\?error=/);
      expectSessionUntouched(res);
    });

    test(`POST /auth/app-finalize, ${name}`, async () => {
      arrange();
      const p = await pendingCookie({ pkce: true, client: 'app' });
      const res = await appFinalize({ state: p.state, act: 'act_f' }, { cookie: `remo_login=${p.token}; ${EXISTING}` });
      expect(res.status).toBeGreaterThanOrEqual(400);
      expectSessionUntouched(res);
    });
  }

  for (const [name, arrange] of failures.filter(([n]) => n !== 'exchange failure')) {
    test(`POST /auth/confirm, ${name}`, async () => {
      arrange();
      const { token, csrf } = await tl.newPendingConfirm({ email: 'owner@example.com', accountId: 'acc-1' });
      const res = await confirmPost({ cookie: `remo_confirm=${token}; ${EXISTING}`, csrf });
      expect(res.status).toBe(303);
      expect(res.headers.get('location')).toMatch(/^\/#\/login\?error=/);
      expectSessionUntouched(res);
    });
  }
});
