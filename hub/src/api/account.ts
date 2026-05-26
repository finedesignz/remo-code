import { Hono } from 'hono';
import { authMiddleware } from '../auth/middleware.ts';
import {
  getUserCoolifyWebhookStatus,
  rotateUserCoolifyWebhookSecret,
  getUserCoolifyWebhookSecret,
  getUserCoolifyWebhookAllowedIps,
  setUserCoolifyWebhookAllowedIps,
  listCoolifyWebhookAttempts,
} from '../db/dal.ts';

export const accountRouter = new Hono();
export { accountRouter as account };

accountRouter.use('/*', authMiddleware);

function publicBase(): string {
  return process.env.REMO_PUBLIC_URL || 'https://app.remo-code.com';
}

/**
 * fix/coolify-webhook-url-token: the canonical webhook URL now embeds the
 * per-user secret as the final path segment. This is the URL the user pastes
 * into Coolify's single-field Notifications → Webhook UI.
 */
function webhookUrlFor(userId: string, token: string | null): string {
  if (!token) {
    return `${publicBase()}/api/coolify/webhook/${userId}`;
  }
  return `${publicBase()}/api/coolify/webhook/${userId}/${token}`;
}

// GET /api/account/coolify-webhook-secret
// Returns whether the secret is configured + the FULL webhook URL (with the
// token embedded in the path). The URL itself is the credential — treat it
// as a secret. We surface it to the owning user only.
accountRouter.get('/coolify-webhook-secret', async (c) => {
  const userId = c.get('userId') as string;
  try {
    const status = await getUserCoolifyWebhookStatus(userId);
    const secret = status.configured ? await getUserCoolifyWebhookSecret(userId) : null;
    return c.json({
      configured: status.configured,
      webhook_url: webhookUrlFor(userId, secret),
      auth_mode: 'url_token',
    });
  } catch (err: any) {
    console.error('[account] coolify-webhook-secret GET failed:', err?.code, err?.message);
    return c.json({ error: 'internal_error', code: err?.code ?? null }, 500);
  }
});

// POST /api/account/coolify-webhook-secret/rotate
// Generates a fresh UUID secret and returns the new URL (token embedded).
accountRouter.post('/coolify-webhook-secret/rotate', async (c) => {
  const userId = c.get('userId') as string;
  try {
    const secret = await rotateUserCoolifyWebhookSecret(userId);
    return c.json({
      secret,
      webhook_url: webhookUrlFor(userId, secret),
      auth_mode: 'url_token',
      note: 'Paste webhook_url into Coolify Notifications → Webhook. The URL itself is the credential — treat it as a secret.',
    });
  } catch (err: any) {
    console.error('[account] coolify-webhook-secret rotate failed:', err?.code, err?.message);
    return c.json({ error: 'internal_error', code: err?.code ?? null }, 500);
  }
});

// GET /api/account/coolify-webhook-attempts?limit=10
// Recent webhook ingest attempts (success + auth-fail + ip-reject) so the
// user can see whether Coolify is actually reaching them. Capped at 100.
accountRouter.get('/coolify-webhook-attempts', async (c) => {
  const userId = c.get('userId') as string;
  const limitRaw = c.req.query('limit');
  const limit = limitRaw ? Math.min(100, Math.max(1, Number(limitRaw) || 10)) : 10;
  try {
    const attempts = await listCoolifyWebhookAttempts(userId, limit);
    return c.json({ attempts });
  } catch (err: any) {
    console.error('[account] coolify-webhook-attempts GET failed:', err?.code, err?.message);
    return c.json({ error: 'internal_error', code: err?.code ?? null }, 500);
  }
});

// GET /api/account/coolify-webhook-allowed-ips
accountRouter.get('/coolify-webhook-allowed-ips', async (c) => {
  const userId = c.get('userId') as string;
  try {
    const allowed_ips = await getUserCoolifyWebhookAllowedIps(userId);
    return c.json({ allowed_ips });
  } catch (err: any) {
    console.error('[account] coolify-webhook-allowed-ips GET failed:', err?.code, err?.message);
    return c.json({ error: 'internal_error', code: err?.code ?? null }, 500);
  }
});

// PUT /api/account/coolify-webhook-allowed-ips  { allowed_ips: string }
accountRouter.put('/coolify-webhook-allowed-ips', async (c) => {
  const userId = c.get('userId') as string;
  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'bad_json' }, 400);
  }
  const raw = typeof body?.allowed_ips === 'string' ? body.allowed_ips : '';
  try {
    const saved = await setUserCoolifyWebhookAllowedIps(userId, raw);
    return c.json({ allowed_ips: saved });
  } catch (err: any) {
    const msg = String(err?.message ?? err);
    if (msg.startsWith('invalid_cidr_entry:')) {
      return c.json({ error: 'invalid_cidr', detail: msg.slice('invalid_cidr_entry:'.length).trim() }, 400);
    }
    console.error('[account] coolify-webhook-allowed-ips PUT failed:', err?.code, err?.message);
    return c.json({ error: 'internal_error', code: err?.code ?? null }, 500);
  }
});
