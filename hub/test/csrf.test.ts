// Phase 07-C: CSRF middleware + verify helpers.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-chars-long-aaaaaaaa';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'session-secret-at-least-32-chars-long-x';
process.env.MAGIC_LINK_SECRET = process.env.MAGIC_LINK_SECRET || 'magic-link-secret-at-least-32-chars-x';
process.env.TITANIUM_KEYGEN_API_URL = process.env.TITANIUM_KEYGEN_API_URL || 'https://keygen.titaniumlabs.us';process.env.TITANIUM_KEYGEN_ACCOUNT_ID = process.env.TITANIUM_KEYGEN_ACCOUNT_ID || 'acct_test_0000000000';process.env.TITANIUM_KEYGEN_PRODUCT_ID = process.env.TITANIUM_KEYGEN_PRODUCT_ID || 'prod_test_remo';

import { describe, test, expect } from 'bun:test';
import { Hono } from 'hono';
import {
  issueCsrfToken,
  verifyCsrfPair,
  isCsrfAllowlisted,
  csrfGuard,
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
} from '../src/csrf';

describe('issueCsrfToken', () => {
  test('produces 32 hex chars', () => {
    const t = issueCsrfToken('remo_abc');
    expect(t).toMatch(/^[0-9a-f]{32}$/);
  });

  test('different calls produce different tokens (nonce-bound)', () => {
    const a = issueCsrfToken('remo_abc');
    const b = issueCsrfToken('remo_abc');
    expect(a).not.toBe(b);
  });
});

describe('verifyCsrfPair', () => {
  test('accepts matching pair', () => {
    expect(verifyCsrfPair('abc', 'abc')).toBe(true);
  });
  test('rejects mismatched pair', () => {
    expect(verifyCsrfPair('abc', 'abd')).toBe(false);
  });
  test('rejects null/empty', () => {
    expect(verifyCsrfPair(null, 'abc')).toBe(false);
    expect(verifyCsrfPair('abc', null)).toBe(false);
    expect(verifyCsrfPair(null, null)).toBe(false);
    expect(verifyCsrfPair('', 'abc')).toBe(false);
  });
  test('rejects length mismatch (constant-time guard)', () => {
    expect(verifyCsrfPair('a', 'ab')).toBe(false);
  });
});

describe('isCsrfAllowlisted', () => {
  test('allows sentry intake', () => {
    expect(isCsrfAllowlisted('/api/sentry/abc/envelope/')).toBe(true);
  });
  test('allows coolify webhook', () => {
    expect(isCsrfAllowlisted('/api/coolify/webhook/user-123')).toBe(true);
  });
  test('allows login + logout', () => {
    expect(isCsrfAllowlisted('/api/auth/login/request-link')).toBe(true);
    expect(isCsrfAllowlisted('/api/auth/login/callback')).toBe(true);
    expect(isCsrfAllowlisted('/api/auth/logout')).toBe(true);
  });
  test('does NOT allow scheduled-tasks (must enforce CSRF)', () => {
    expect(isCsrfAllowlisted('/api/scheduled-tasks')).toBe(false);
    expect(isCsrfAllowlisted('/api/scheduled-tasks/abc-123')).toBe(false);
  });
  test('allows setup + plugin + github callback + health', () => {
    expect(isCsrfAllowlisted('/api/setup')).toBe(true);
    expect(isCsrfAllowlisted('/api/plugin/foo')).toBe(true);
    expect(isCsrfAllowlisted('/api/github/callback')).toBe(true);
    expect(isCsrfAllowlisted('/health')).toBe(true);
  });
});

describe('csrfGuard middleware', () => {
  function buildApp() {
    const app = new Hono();
    app.use('*', csrfGuard());
    app.get('/api/foo', (c) => c.json({ ok: true }));
    app.post('/api/foo', (c) => c.json({ ok: true }));
    app.post('/api/sentry/p/envelope/', (c) => c.json({ ok: true }));
    return app;
  }

  test('GET passes through without CSRF', async () => {
    const res = await buildApp().request('/api/foo');
    expect(res.status).toBe(200);
  });

  test('POST without CSRF header → 403', async () => {
    const res = await buildApp().request('/api/foo', {
      method: 'POST',
      headers: { cookie: `${CSRF_COOKIE_NAME}=abc123` },
    });
    expect(res.status).toBe(403);
  });

  test('POST without CSRF cookie → 403', async () => {
    const res = await buildApp().request('/api/foo', {
      method: 'POST',
      headers: { [CSRF_HEADER_NAME]: 'abc123' },
    });
    expect(res.status).toBe(403);
  });

  test('POST with mismatched CSRF → 403', async () => {
    const res = await buildApp().request('/api/foo', {
      method: 'POST',
      headers: { cookie: `${CSRF_COOKIE_NAME}=abc123`, [CSRF_HEADER_NAME]: 'wrong' },
    });
    expect(res.status).toBe(403);
  });

  test('POST with matching CSRF → 200', async () => {
    const res = await buildApp().request('/api/foo', {
      method: 'POST',
      headers: { cookie: `${CSRF_COOKIE_NAME}=abc123def`, [CSRF_HEADER_NAME]: 'abc123def' },
    });
    expect(res.status).toBe(200);
  });

  test('allowlisted POST passes without CSRF', async () => {
    const res = await buildApp().request('/api/sentry/p/envelope/', { method: 'POST' });
    expect(res.status).toBe(200);
  });

  test('PUT/PATCH/DELETE also enforced', async () => {
    const app = new Hono();
    app.use('*', csrfGuard());
    app.delete('/api/foo', (c) => c.json({ ok: true }));
    const res = await app.request('/api/foo', { method: 'DELETE' });
    expect(res.status).toBe(403);
  });
});
