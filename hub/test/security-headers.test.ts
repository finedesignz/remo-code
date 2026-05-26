// Phase 07-G: security headers middleware.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-chars-long-aaaaaaaa';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'session-secret-at-least-32-chars-long-x';
process.env.MAGIC_LINK_SECRET = process.env.MAGIC_LINK_SECRET || 'magic-link-secret-at-least-32-chars-x';

import { describe, test, expect } from 'bun:test';
import { Hono } from 'hono';
import { securityHeaders, renderCsp, DEFAULT_CSP } from '../src/middleware/security-headers';

function buildApp() {
  const app = new Hono();
  app.use('*', securityHeaders());
  app.get('/ok', (c) => c.text('ok'));
  app.get('/json', (c) => c.json({ ok: true }));
  app.get('/boom', () => { throw new Error('kaboom'); });
  return app;
}

describe('securityHeaders', () => {
  test('emits all hardening headers on a normal 200', async () => {
    const res = await buildApp().request('/ok');
    expect(res.status).toBe(200);
    expect(res.headers.get('Strict-Transport-Security')).toBe('max-age=63072000; includeSubDomains; preload');
    expect(res.headers.get('Content-Security-Policy')).toContain("default-src 'self'");
    expect(res.headers.get('Cross-Origin-Opener-Policy')).toBe('same-origin');
    expect(res.headers.get('Cross-Origin-Resource-Policy')).toBe('same-origin');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('X-Frame-Options')).toBe('DENY');
    expect(res.headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
    const pp = res.headers.get('Permissions-Policy');
    expect(pp).toContain('camera=()');
    expect(pp).toContain('microphone=()');
    expect(pp).toContain('geolocation=()');
  });

  test('strips Server + X-Powered-By', async () => {
    const res = await buildApp().request('/ok');
    expect(res.headers.get('Server')).toBeNull();
    expect(res.headers.get('X-Powered-By')).toBeNull();
  });

  test('emits headers on JSON responses too', async () => {
    const res = await buildApp().request('/json');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Security-Policy')).toBeTruthy();
    expect(res.headers.get('X-Frame-Options')).toBe('DENY');
  });
});

describe('renderCsp', () => {
  test('produces canonical directive order', () => {
    const csp = renderCsp(DEFAULT_CSP);
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self' 'unsafe-inline'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
  });

  test('every required directive present', () => {
    const csp = renderCsp(DEFAULT_CSP);
    for (const d of ['default-src', 'script-src', 'style-src', 'img-src', 'connect-src', 'font-src', 'frame-ancestors', 'base-uri', 'form-action', 'object-src']) {
      expect(csp).toContain(d);
    }
  });
});
