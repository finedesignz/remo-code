import { Hono } from 'hono';
import { authMiddleware } from '../auth/middleware.ts';
import {
  getUserCoolifyWebhookStatus,
  rotateUserCoolifyWebhookSecret,
} from '../db/dal.ts';

export const accountRouter = new Hono();
export { accountRouter as account };

accountRouter.use('/*', authMiddleware);

function publicBase(): string {
  return process.env.REMO_PUBLIC_URL || 'https://app.remo-code.com';
}

function webhookUrlFor(userId: string): string {
  return `${publicBase()}/api/coolify/webhook/${userId}`;
}

// GET /api/account/coolify-webhook-secret
// Returns whether the secret is configured + the user's webhook URL.
// NEVER returns the secret value itself.
accountRouter.get('/coolify-webhook-secret', async (c) => {
  const userId = c.get('userId') as string;
  const status = await getUserCoolifyWebhookStatus(userId);
  return c.json({
    configured: status.configured,
    webhook_url: webhookUrlFor(userId),
  });
});

// POST /api/account/coolify-webhook-secret/rotate
// Generates a fresh UUID secret and returns it ONCE.
accountRouter.post('/coolify-webhook-secret/rotate', async (c) => {
  const userId = c.get('userId') as string;
  const secret = await rotateUserCoolifyWebhookSecret(userId);
  return c.json({
    secret,
    webhook_url: webhookUrlFor(userId),
    header_format: 'X-Coolify-Signature: sha256=<hex>',
    timestamp_header: 'X-Coolify-Timestamp',
  });
});
