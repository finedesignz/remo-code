// Bearer chat surface: explicit chat:session scope, ownership, send path, SSE, containment.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-chars-long-aaaaaaaa';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'session-secret-at-least-32-chars-long-x';
process.env.MAGIC_LINK_SECRET = process.env.MAGIC_LINK_SECRET || 'magic-link-secret-at-least-32-chars-x';
process.env.TITANIUM_KEYGEN_API_URL = process.env.TITANIUM_KEYGEN_API_URL || 'https://keygen.titaniumlabs.us';
process.env.TITANIUM_KEYGEN_ACCOUNT_ID = process.env.TITANIUM_KEYGEN_ACCOUNT_ID || 'acct_test_0000000000';
process.env.TITANIUM_KEYGEN_PRODUCT_ID = process.env.TITANIUM_KEYGEN_PRODUCT_ID || 'prod_test_remo';
process.env.TITANIUM_BYPASS = 'true';

import { describe, test, expect, mock, beforeEach, afterAll } from 'bun:test';
import { Hono } from 'hono';

let keyScopes: string[] | null = ['chat:session'];
let keyFound = true;
const SESSIONS: Record<string, any> = {
  s1: { id: 's1', user_id: 'u1', name: 'orch', project_dir: 'C:\\Users\\artic\\GitHub', status: 'online', runner_type: 'stream-json' },
  spty: { id: 'spty', user_id: 'u1', name: 'pty', project_dir: 'C:\\p', status: 'online', runner_type: 'pty-interactive' },
  sother: { id: 'sother', user_id: 'u2', name: 'x', project_dir: 'C:\\o', status: 'online', runner_type: 'stream-json' },
};
const inserted: any[] = [];
let gateBlock: string | null = null;

const realSession = await import('../src/session');
mock.module('../src/session.ts', () => ({ ...realSession, verifyAuthSessionCookie: async () => null }));
mock.module('../src/db/ask-dal.ts', () => ({
  verifyApiKeyForExt: async () => (keyFound ? { id: 'k1', user_id: 'u1', scopes: keyScopes } : null),
}));
const realDal = await import('../src/db/dal');
mock.module('../src/db/dal.ts', () => ({
  ...realDal,
  getSession: async (id: string, userId: string) => (SESSIONS[id]?.user_id === userId ? SESSIONS[id] : null),
  insertMessage: async (sid: string, role: string, content: string) => {
    const m = { id: `m${inserted.length + 1}`, session_id: sid, role, content, status: 'complete', created_at: 't' };
    inserted.push(m);
    return m;
  },
  updateSessionStatus: async () => {},
  verifyApiKeyWithScope: async (_h: string, scope: string) => (keyScopes == null || keyScopes.includes(scope) ? { userId: 'u1', apiKeyId: 'k1' } : { error: 'missing_scope' }),
  getUserLicenseFields: async () => ({ license_status: 'active' }),
}));
mock.module('../src/sessions/enrich.ts', () => ({
  listSessionsForUserEnriched: async (userId: string) => Object.values(SESSIONS).filter((s) => s.user_id === userId),
  enrichSessionsForUser: (_u: string, r: any[]) => r,
}));
mock.module('../src/db/chat-tabs-dal.ts', () => ({
  getMessagesForSessions: async (_u: string, ids: string[]) => ({ [ids[0]]: [{ id: 'h1', session_id: ids[0], role: 'user', content: 'hi', status: 'complete', created_at: 't' }] }),
}));
const realGates = await import('../src/dispatch/gates');
const blockable = (g: any) => ({ ...g, check: async () => (gateBlock === g.name ? { ok: false, reason: `blocked:${g.name}` } : { ok: true }) });
mock.module('../src/dispatch/gates.ts', () => ({
  ...realGates,
  thresholdGate: blockable(realGates.thresholdGate),
  dailyCostCapGate: blockable(realGates.dailyCostCapGate),
  dailyTokenCapGate: blockable(realGates.dailyTokenCapGate),
}));

const { chatApiKeyMiddleware } = await import('../src/auth/chat-api-key');
const { chat } = await import('../src/api/chat');
const { authMiddleware } = await import('../src/auth/middleware');
const { extApiKeyMiddleware } = await import('../src/auth/ext-api-key-middleware');
const { apiKeyMiddleware } = await import('../src/auth/api-key-middleware');
const { registerChannel, unregisterChannel, broadcastToSubscribers } = await import('../src/ws/registry');
const { __resetSendDedupeForTests } = await import('../src/ws/send-dedupe');

afterAll(() => { mock.restore(); });

function buildApp() {
  const app = new Hono();
  app.use('/api/chat/*', chatApiKeyMiddleware);
  app.route('/api/chat', chat);
  app.use('/api/ext/*', extApiKeyMiddleware);
  app.get('/api/ext/sessions', (c) => c.json({ ok: true }));
  app.use('/api/plugin/*', apiKeyMiddleware);
  app.get('/api/plugin/x', (c) => c.json({ ok: true }));
  app.use('/api/*', authMiddleware);
  app.get('/api/sessions', (c) => c.json({ ok: true }));
  app.get('/api/profile', (c) => c.json({ ok: true }));
  app.post('/api/api-keys', (c) => c.json({ ok: true }));
  return app;
}
const H = { Authorization: 'Bearer remokey_abc123', 'content-type': 'application/json' };
const post = (body?: unknown) => ({ method: 'POST', headers: H, body: JSON.stringify(body ?? {}) });
const UUID = '11111111-1111-4111-8111-111111111111';
let sent: any[] = [];
let fakeWs: any;

beforeEach(() => {
  keyScopes = ['chat:session']; keyFound = true; gateBlock = null; inserted.length = 0; sent = [];
  __resetSendDedupeForTests();
  fakeWs = { readyState: 1, send: (s: string) => { sent.push(JSON.parse(s)); return 1; }, close() {} };
  unregisterChannel('s1'); unregisterChannel('spty');
  registerChannel('s1', 'u1', fakeWs as any);
});

describe('scope enforcement', () => {
  test('no key -> 401', async () => {
    expect((await buildApp().request('/api/chat/sessions')).status).toBe(401);
  });
  test('unknown key -> 401', async () => {
    keyFound = false;
    expect((await buildApp().request('/api/chat/sessions', { headers: H })).status).toBe(401);
  });
  for (const scopes of [['ext:read'], ['settings:write'], ['agent'], ['ext:ask', 'ext:work'], null] as const) {
    test(`scopes ${JSON.stringify(scopes)} -> 403 (explicit-only, NULL included)`, async () => {
      keyScopes = scopes as any;
      const r = await buildApp().request('/api/chat/sessions', { headers: H });
      expect(r.status).toBe(403);
      expect(((await r.json()) as any).required).toBe('chat:session');
    });
  }
});

describe('sessions + history + ownership', () => {
  test('lists only own sessions, path match is case/sep insensitive', async () => {
    const r = await buildApp().request('/api/chat/sessions?project_dir=c:/users/artic/GitHub/', { headers: H });
    const j = (await r.json()) as any;
    expect(j.sessions.map((s: any) => s.id)).toEqual(['s1']);
    expect(j.sessions[0].online).toBe(true);
    const all = (await (await buildApp().request('/api/chat/sessions', { headers: H })).json()) as any;
    expect(all.sessions.map((s: any) => s.id)).not.toContain('sother');
  });
  test('other user session -> 404 on every route', async () => {
    const app = buildApp();
    expect((await app.request('/api/chat/sessions/sother/messages', { headers: H })).status).toBe(404);
    for (const p of ['messages', 'cancel', 'permission', 'question']) {
      expect((await app.request(`/api/chat/sessions/sother/${p}`, post({ content: 'x', request_id: 'r', approved: true, answer: 'a' }))).status).toBe(404);
    }
    expect((await app.request('/api/chat/sessions/sother/events', { headers: H })).status).toBe(404);
  });
  test('history returns messages', async () => {
    const j = (await (await buildApp().request('/api/chat/sessions/s1/messages?limit=5', { headers: H })).json()) as any;
    expect(j.messages[0].id).toBe('h1');
  });
});

describe('send path', () => {
  test('persists, forwards user_message to the agent channel, 202 + dedupe', async () => {
    const app = buildApp();
    const r = await app.request('/api/chat/sessions/s1/messages', post({ content: ' hello ', id: UUID }));
    expect(r.status).toBe(202);
    expect(((await r.json()) as any).id).toBe('m1');
    expect(inserted[0].content).toBe('hello');
    expect(sent[0]).toMatchObject({ type: 'user_message', id: 'm1', content: 'hello' });
    const again = await app.request('/api/chat/sessions/s1/messages', post({ content: 'hello', id: UUID }));
    expect(again.status).toBe(202);
    expect(sent.length).toBe(1);
  });
  test('validation: empty content, >5 images', async () => {
    const app = buildApp();
    expect((await app.request('/api/chat/sessions/s1/messages', post({ content: '  ' }))).status).toBe(400);
    const img = { media_type: 'image/png', data: 'AAAA' };
    expect((await app.request('/api/chat/sessions/s1/messages', post({ content: 'x', images: Array(6).fill(img) }))).status).toBe(400);
  });
  test('spend gate refusal -> 429, nothing forwarded', async () => {
    gateBlock = 'daily_token_cap';
    const r = await buildApp().request('/api/chat/sessions/s1/messages', post({ content: 'x' }));
    expect(r.status).toBe(429);
    expect(sent.length).toBe(0);
    expect(inserted.length).toBe(0);
  });
  test('pty-interactive session refused (automation never drives a PTY)', async () => {
    registerChannel('spty', 'u1', fakeWs as any);
    const r = await buildApp().request('/api/chat/sessions/spty/messages', post({ content: 'x' }));
    expect(r.status).toBe(409);
    expect(((await r.json()) as any).reason).toBe('automation_blocked_on_pty:external-chat');
    expect(sent.length).toBe(0);
  });
  test('offline session -> 409 session_offline', async () => {
    unregisterChannel('s1');
    const r = await buildApp().request('/api/chat/sessions/s1/messages', post({ content: 'x' }));
    expect(r.status).toBe(409);
    expect(((await r.json()) as any).reason).toBe('session_offline');
  });
  test('cancel / permission / question reach the agent channel', async () => {
    const app = buildApp();
    expect((await app.request('/api/chat/sessions/s1/cancel', post())).status).toBe(202);
    expect((await app.request('/api/chat/sessions/s1/permission', post({ request_id: 'r1', approved: true }))).status).toBe(202);
    expect((await app.request('/api/chat/sessions/s1/question', post({ request_id: 'r2', answer: 'yes' }))).status).toBe(202);
    expect(sent.map((m) => m.type)).toEqual(['cancel', 'permission_response', 'question_response']);
    expect(sent[1]).toMatchObject({ request_id: 'r1', approved: true });
  });
});

describe('SSE events', () => {
  test('streams broadcast events as data: lines and cleans up on abort', async () => {
    const ac = new AbortController();
    const res = await buildApp().request('/api/chat/sessions/s1/events', { headers: H, signal: ac.signal });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = dec.decode((await reader.read()).value);
    expect(buf).toContain(': connected');
    broadcastToSubscribers('s1', { type: 'text_delta', session_id: 's1', delta: 'yo' });
    broadcastToSubscribers('other', { type: 'text_delta', session_id: 'other', delta: 'no' });
    buf += dec.decode((await reader.read()).value);
    expect(buf).toContain('data: {"type":"text_delta","session_id":"s1","delta":"yo"}');
    expect(buf).not.toContain('"other"');
    ac.abort();
    await reader.cancel().catch(() => {});
    broadcastToSubscribers('s1', { type: 'text_delta', delta: 'late' });
  });
});

describe('containment: the chat key reaches nothing else', () => {
  test('other /api surfaces reject it', async () => {
    const app = buildApp();
    expect((await app.request('/api/ext/sessions', { headers: H })).status).toBe(403);
    expect((await app.request('/api/plugin/x', { headers: H })).status).toBe(403);
    for (const [m, p] of [['GET', '/api/sessions'], ['GET', '/api/profile'], ['POST', '/api/api-keys']] as const) {
      expect((await app.request(p, { method: m, headers: H })).status).toBe(403);
    }
  });
  test('unknown /api/chat path is not served to the key', async () => {
    expect((await buildApp().request('/api/chat/nope', { headers: H })).status).toBe(403);
  });
});
