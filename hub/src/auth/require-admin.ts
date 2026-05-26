// Phase 07-G: admin role gate.
//
// Assumes authMiddleware (cookie or legacy bearer) already ran and populated
// c.var.userRole. Returns 403 if missing/non-admin. No DB lookup — role is
// already in context.

import type { Context, Next } from 'hono';

export function requireAdmin() {
  return async (c: Context, next: Next) => {
    const role = c.get('userRole') as string | undefined;
    if (role !== 'admin') {
      return c.json({ error: 'forbidden', reason: 'admin_required' }, 403);
    }
    return next();
  };
}
