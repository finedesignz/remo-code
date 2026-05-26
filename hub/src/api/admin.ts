// Phase 07-G: admin endpoints. Mounted at /api/admin under requireAdmin().
//
// Endpoints:
//   POST /api/admin/users/:id/revoke-sessions
//     - Revokes ALL active api_keys + deletes ALL auth_sessions for the user.
//     - Re-auth gated (requireRecentAuth in index.ts).
//     - Audits session_revoked with counts.

import { Hono } from 'hono';
import { revokeAllUserCredentials, recordAuthEvent } from '../db/dal';

export const adminRouter = new Hono();

function ipOf(c: any): string | null {
  return c.req.header('cf-connecting-ip') || c.req.header('x-real-ip') || c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || null;
}

adminRouter.post('/users/:id/revoke-sessions', async (c) => {
  const targetUserId = c.req.param('id');
  const actorId = c.get('userId') as string;
  if (!targetUserId) return c.json({ error: 'missing_user_id' }, 400);

  const counts = await revokeAllUserCredentials(targetUserId);

  try {
    await recordAuthEvent({
      userId: targetUserId,
      eventType: 'session_revoked',
      ip: ipOf(c),
      userAgent: c.req.header('user-agent') ?? null,
      metadata: { actor_user_id: actorId, ...counts },
    });
  } catch {}

  return c.json({ ok: true, ...counts });
});
