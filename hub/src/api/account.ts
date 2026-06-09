import { Hono } from 'hono';
import { z } from 'zod';
import { authMiddleware } from '../auth/middleware.ts';
import {
  getUserCoolifyWebhookStatus,
  rotateUserCoolifyWebhookSecret,
  getUserCoolifyWebhookSecret,
  getUserCoolifyWebhookAllowedIps,
  setUserCoolifyWebhookAllowedIps,
  getUserCoolifyAutoTriageEnabled,
  setUserCoolifyAutoTriageEnabled,
  listCoolifyWebhookAttempts,
  getUserClaudeThresholds,
  setUserClaudeThresholds,
  getUserNotifyChannels,
  updateUserNotifyChannels,
} from '../db/dal.ts';
import {
  getUserRevanoteWebhookSecret,
  getUserRevanoteWebhookStatus,
  rotateUserRevanoteWebhookSecret,
  setUserRevanoteBudgetPct,
  listRevanoteWebhookAttempts,
} from '../db/revanote-dal.ts';
import { getUsage } from '../usage/store.ts';
import { evaluateThreshold } from '../usage/threshold.ts';

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
    const autoTriageEnabled = await getUserCoolifyAutoTriageEnabled(userId);
    return c.json({
      configured: status.configured,
      webhook_url: webhookUrlFor(userId, secret),
      auth_mode: 'url_token',
      legacy_in_use: status.legacy_in_use,
      legacy_hit_at: status.legacy_hit_at,
      auto_triage_enabled: autoTriageEnabled,
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

// ── Claude usage thresholds ──────────────────────────────────────────────────
// GET /api/account/claude-thresholds → { session_pct, week_pct }
accountRouter.get('/claude-thresholds', async (c) => {
  const userId = c.get('userId') as string;
  try {
    const t = await getUserClaudeThresholds(userId);
    return c.json({
      session_pct: t.claude_session_threshold_pct,
      week_pct: t.claude_week_threshold_pct,
    });
  } catch (err: any) {
    console.error('[account] claude-thresholds GET failed:', err?.code, err?.message);
    return c.json({ error: 'internal_error', code: err?.code ?? null }, 500);
  }
});

const ThresholdSchema = z.object({
  session_pct: z.number().int().min(1).max(100).nullable(),
  week_pct: z.number().int().min(1).max(100).nullable(),
}).strict();

// PUT /api/account/claude-thresholds  body: { session_pct, week_pct }
accountRouter.put('/claude-thresholds', async (c) => {
  const userId = c.get('userId') as string;
  let body: any;
  try { body = await c.req.json(); } catch { return c.json({ error: 'bad_json' }, 400); }
  const parsed = ThresholdSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'invalid_body', detail: parsed.error.flatten() }, 400);
  }
  try {
    const saved = await setUserClaudeThresholds(userId, {
      claude_session_threshold_pct: parsed.data.session_pct,
      claude_week_threshold_pct: parsed.data.week_pct,
    });
    return c.json({
      session_pct: saved.claude_session_threshold_pct,
      week_pct: saved.claude_week_threshold_pct,
    });
  } catch (err: any) {
    console.error('[account] claude-thresholds PUT failed:', err?.code, err?.message);
    return c.json({ error: 'internal_error', code: err?.code ?? null }, 500);
  }
});

// GET /api/account/usage → { usage, thresholds, paused, reason, ... }
// Used by Layout.tsx on first paint before the WS event arrives.
accountRouter.get('/usage', async (c) => {
  const userId = c.get('userId') as string;
  try {
    const t = await getUserClaudeThresholds(userId);
    const snap = getUsage(userId);
    const decision = evaluateThreshold(snap, t);
    return c.json({
      usage: snap?.usage ?? null,
      updated_at: snap?.updated_at ?? null,
      thresholds: {
        session_pct: t.claude_session_threshold_pct,
        week_pct: t.claude_week_threshold_pct,
      },
      paused: !decision.allowed,
      reason: decision.reason ?? null,
      utilization_pct: decision.utilization_pct ?? null,
      threshold_pct: decision.threshold_pct ?? null,
      resets_at: decision.resets_at ?? null,
    });
  } catch (err: any) {
    console.error('[account] usage GET failed:', err?.code, err?.message);
    return c.json({ error: 'internal_error', code: err?.code ?? null }, 500);
  }
});

// ── Phase 08: Revanote webhook secret + budget + attempts ────────────────────

function revanoteWebhookUrlFor(userId: string, token: string | null): string {
  const base = publicBase();
  if (!token) return `${base}/api/revanote/webhook/${userId}`;
  return `${base}/api/revanote/webhook/${userId}/${token}`;
}

accountRouter.get('/revanote-webhook-secret', async (c) => {
  const userId = c.get('userId') as string;
  try {
    const status = await getUserRevanoteWebhookStatus(userId);
    const secret = status.configured ? await getUserRevanoteWebhookSecret(userId) : null;
    return c.json({
      configured: status.configured,
      webhook_url: revanoteWebhookUrlFor(userId, secret),
      auth_mode: 'url_token+hmac',
      budget_pct: status.budget_pct,
    });
  } catch (err: any) {
    console.error('[account] revanote-webhook-secret GET failed:', err?.code, err?.message);
    return c.json({ error: 'internal_error', code: err?.code ?? null }, 500);
  }
});

accountRouter.post('/revanote-webhook-secret/rotate', async (c) => {
  const userId = c.get('userId') as string;
  try {
    const secret = await rotateUserRevanoteWebhookSecret(userId);
    return c.json({
      user_id: userId,
      token: secret,
      webhook_secret: secret,
      webhook_url: revanoteWebhookUrlFor(userId, secret),
      auth_mode: 'url_token+hmac',
      note:
        'Paste webhook_url + webhook_secret into Revanote. The secret doubles as the URL-path token AND the X-Revuu-Signature HMAC key, AND the Bearer credential on outbound callbacks.',
    });
  } catch (err: any) {
    console.error('[account] revanote-webhook-secret rotate failed:', err?.code, err?.message);
    return c.json({ error: 'internal_error', code: err?.code ?? null }, 500);
  }
});

accountRouter.get('/revanote-webhook-attempts', async (c) => {
  const userId = c.get('userId') as string;
  const limitRaw = c.req.query('limit');
  const limit = limitRaw ? Math.min(100, Math.max(1, Number(limitRaw) || 10)) : 10;
  try {
    const attempts = await listRevanoteWebhookAttempts(userId, limit);
    return c.json({ attempts });
  } catch (err: any) {
    console.error('[account] revanote-webhook-attempts GET failed:', err?.code, err?.message);
    return c.json({ error: 'internal_error', code: err?.code ?? null }, 500);
  }
});

const RevanoteBudgetSchema = z.object({
  budget_pct: z.number().int().min(1).max(100).nullable(),
}).strict();

accountRouter.put('/revanote-budget-pct', async (c) => {
  const userId = c.get('userId') as string;
  let body: any;
  try { body = await c.req.json(); } catch { return c.json({ error: 'bad_json' }, 400); }
  const parsed = RevanoteBudgetSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_body', detail: parsed.error.flatten() }, 400);
  try {
    const saved = await setUserRevanoteBudgetPct(userId, parsed.data.budget_pct);
    return c.json({ budget_pct: saved });
  } catch (err: any) {
    console.error('[account] revanote-budget-pct PUT failed:', err?.code, err?.message);
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

// PATCH /api/account/coolify-auto-triage  { enabled: boolean }
// fix/coolify-triage-guard: master on/off switch for failed-deploy auto-triage.
// CSRF: covered by the global csrfGuard on mutating /api/* (double-submit cookie).
accountRouter.patch('/coolify-auto-triage', async (c) => {
  const userId = c.get('userId') as string;
  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'bad_json' }, 400);
  }
  if (typeof body?.enabled !== 'boolean') {
    return c.json({ error: 'bad_request', detail: 'enabled must be a boolean' }, 400);
  }
  try {
    const saved = await setUserCoolifyAutoTriageEnabled(userId, body.enabled);
    return c.json({ auto_triage_enabled: saved });
  } catch (err: any) {
    console.error('[account] coolify-auto-triage PATCH failed:', err?.code, err?.message);
    return c.json({ error: 'internal_error', code: err?.code ?? null }, 500);
  }
});

// ── Milestone TMAC §7.1: per-channel orchestrator-notify opt-in ──────────────
// GET  /api/account/notify-channels → { notify_channels: {telegram,inapp,email,push} }
// PATCH same path, body = partial {telegram?,inapp?,email?,push?} booleans.
// Default all-on (schema default); a missing key reads as opted-IN — only an
// explicit `false` mutes a channel in hub/src/orchestrator/notify.ts.
const NotifyChannelsPatch = z
  .object({
    telegram: z.boolean().optional(),
    inapp: z.boolean().optional(),
    email: z.boolean().optional(),
    push: z.boolean().optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: 'at least one channel must be set' });

accountRouter.get('/notify-channels', async (c) => {
  const userId = c.get('userId') as string;
  try {
    const prefs = await getUserNotifyChannels(userId);
    return c.json({ notify_channels: prefs });
  } catch (err: any) {
    console.error('[account] notify-channels GET failed:', err?.code, err?.message);
    return c.json({ error: 'internal_error', code: err?.code ?? null }, 500);
  }
});

accountRouter.patch('/notify-channels', async (c) => {
  const userId = c.get('userId') as string;
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'bad_json' }, 400);
  }
  const parsed = NotifyChannelsPatch.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'bad_request', detail: parsed.error.issues[0]?.message ?? 'invalid' }, 400);
  }
  try {
    const saved = await updateUserNotifyChannels(userId, parsed.data);
    return c.json({ notify_channels: saved });
  } catch (err: any) {
    console.error('[account] notify-channels PATCH failed:', err?.code, err?.message);
    return c.json({ error: 'internal_error', code: err?.code ?? null }, 500);
  }
});
