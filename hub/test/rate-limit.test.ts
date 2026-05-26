// Phase 07-G: rate-limit middleware (default + multi).
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-chars-long-aaaaaaaa';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'session-secret-at-least-32-chars-long-x';
process.env.MAGIC_LINK_SECRET = process.env.MAGIC_LINK_SECRET || 'magic-link-secret-at-least-32-chars-x';

import { describe, test, expect, beforeEach } from 'bun:test';
import { Hono } from 'hono';
import {
  rateLimit,
  rateLimitMulti,
  __setRateLimitBackendForTesting,
  type RateLimitBackend,
} from '../src/middleware/rate-limit';

// Controllable in-memory backend (resets between tests).
class TestBackend implements RateLimitBackend {
  windows = new Map<string, { count: number; resetAt: number }>();
  now = () => Date.now();
  async incr(key: string, windowMs: number): Promise<number> {
    const t = this.now();
    const e = this.windows.get(key);
    if (!e || t > e.resetAt) {
      this.windows.set(key, { count: 1, resetAt: t + windowMs });
      return 1;
    }
    e.count += 1;
    return e.count;
  }
}

let backend: TestBackend;
beforeEach(() => {
  backend = new TestBackend();
  __setRateLimitBackendForTesting(backend);
});

describe('rateLimit (single bucket)', () => {
  function build(max: number, windowMs: number) {
    const app = new Hono();
    app.use('*', rateLimit({ windowMs, max, keyFn: () => 'fixed' }));
    app.get('/r', (c) => c.json({ ok: true }));
    return app;
  }

  test('allows up to max, then 429 with Retry-After', async () => {
    const app = build(3, 60_000);
    for (let i = 0; i < 3; i++) {
      const ok = await app.request('/r');
      expect(ok.status).toBe(200);
    }
    const limited = await app.request('/r');
    expect(limited.status).toBe(429);
    expect(limited.headers.get('Retry-After')).toBe('60');
  });

  test('window reset allows again', async () => {
    const app = build(2, 100);
    await app.request('/r');
    await app.request('/r');
    expect((await app.request('/r')).status).toBe(429);
    // Manually advance: clear backend window.
    backend.windows.clear();
    expect((await app.request('/r')).status).toBe(200);
  });

  test('different keys are independent', async () => {
    const app = new Hono();
    let i = 0;
    app.use('*', rateLimit({ windowMs: 60_000, max: 1, keyFn: () => `k${i++}` }));
    app.get('/r', (c) => c.json({ ok: true }));
    expect((await app.request('/r')).status).toBe(200);
    expect((await app.request('/r')).status).toBe(200); // diff key
  });
});

describe('rateLimitMulti', () => {
  function build(opts: any) {
    const app = new Hono();
    app.use('*', rateLimitMulti(opts));
    app.get('/r', (c) => c.json({ ok: true, limited: c.get('rateLimited') }));
    return app;
  }

  test('two buckets, IP bucket trips first', async () => {
    const app = build({
      buckets: [
        { bucket: 'ip', windowMs: 60_000, max: 2, keyFn: () => 'ip1' },
        { bucket: 'email', windowMs: 3_600_000, max: 10, keyFn: () => 'e@x' },
      ],
    });
    await app.request('/r');
    await app.request('/r');
    const r = await app.request('/r');
    expect(r.status).toBe(429);
    expect(r.headers.get('Retry-After')).toBe('60');
  });

  test('silent mode: 200 + rateLimited flag, onLimit fires', async () => {
    let fired = 0;
    const app = build({
      silent: true,
      onLimit: () => { fired += 1; },
      buckets: [
        { bucket: 'ip', windowMs: 60_000, max: 1, keyFn: () => 'ip1' },
      ],
    });
    expect((await app.request('/r')).status).toBe(200);
    const r = await app.request('/r');
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.limited).toBe(true);
    expect(fired).toBe(1);
  });

  test('null keyFn skips that bucket', async () => {
    const app = build({
      buckets: [
        { bucket: 'email', windowMs: 60_000, max: 1, keyFn: () => null },
      ],
    });
    // Many requests with no email — never tripped.
    for (let i = 0; i < 5; i++) {
      expect((await app.request('/r')).status).toBe(200);
    }
  });
});
