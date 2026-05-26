// Phase 07-G: requireAdmin role gate.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-chars-long-aaaaaaaa';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'session-secret-at-least-32-chars-long-x';
process.env.MAGIC_LINK_SECRET = process.env.MAGIC_LINK_SECRET || 'magic-link-secret-at-least-32-chars-x';

import { describe, test, expect } from 'bun:test';
import { Hono } from 'hono';
import { requireAdmin } from '../src/auth/require-admin';

function build(role: string | undefined) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    if (role) c.set('userRole', role);
    return next();
  });
  app.use('*', requireAdmin());
  app.get('/x', (c) => c.json({ ok: true }));
  return app;
}

describe('requireAdmin', () => {
  test('admin role → 200', async () => {
    expect((await build('admin').request('/x')).status).toBe(200);
  });
  test('user role → 403', async () => {
    const r = await build('user').request('/x');
    expect(r.status).toBe(403);
    const body = await r.json();
    expect(body.error).toBe('forbidden');
    expect(body.reason).toBe('admin_required');
  });
  test('missing role → 403', async () => {
    expect((await build(undefined).request('/x')).status).toBe(403);
  });
});
