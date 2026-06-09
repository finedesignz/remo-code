// hub/src/orchestrator/notify.ts
// Milestone TMAC (autonomous task-type macro prompts) — Phase TMAC-03.
//
// Best-effort fan-out notifier for the macro-driven orchestrator (SPEC §2.5 / §3).
// A single helper fans a signal out to:
//   • Telegram  — the existing bridge (`telegram/client.sendMessage`) to the
//                 user's linked chat, if any.
//   • In-app    — a `routine_notify` event broadcast to the user's web clients
//                 (drives the in-app message + sidebar badge).
//   • Email     — emails4agents (`lib/email.sendEmail`), per global CLAUDE.md rule.
//   • Push      — NO-OP until the mobile client resumes (Phase 12 paused).
//
// CONTRACT: this helper NEVER throws (log-only on any channel failure — mirrors
// error-capture/notify.ts). A notification that fails to send MUST NOT propagate
// into the controller tick.
//
// STAGE GATING (SPEC §3): WHEN a notify fires is decided by the caller from the
// parsed sentinel + lifecycle_stage via `shouldNotify()`. This module owns the
// CHANNEL fan-out; `shouldNotify` owns the stage policy so the controller stays
// declarative.

import type { LifecycleStage } from '../db/orchestrator-rows-dal.ts';
import type { NotifyLevel } from './sentinels.ts';

export type NotifyEvent = 'ship' | 'gate' | 'info';

export interface NotifyDecision {
  /** Fire the fan-out at all? */
  fire: boolean;
  /** Channels to fan out to ('all' = telegram+inapp+email+push). */
  channels: NotifyChannel[];
  /** Does this notify pair with a HALT (production blocking gate)? */
  halt: boolean;
}

export type NotifyChannel = 'telegram' | 'inapp' | 'email' | 'push';
const ALL_CHANNELS: NotifyChannel[] = ['telegram', 'inapp', 'email', 'push'];

/** Per-channel opt-in map (users.notify_channels). Missing key ⇒ opted-IN. */
export type NotifyChannelPrefs = Partial<Record<NotifyChannel, boolean>>;

/**
 * Filter the requested channels by the user's per-channel opt-in prefs
 * (Milestone TMAC §7.1). PURE. Default is all-on: a null/undefined prefs map, or
 * a channel with no explicit entry, is treated as opted-IN — only an explicit
 * `false` mutes a channel. Preserves the pre-§7.1 fan-out behavior exactly when
 * no prefs are set.
 */
export function applyChannelPrefs(
  channels: NotifyChannel[],
  prefs: NotifyChannelPrefs | null | undefined,
): NotifyChannel[] {
  if (!prefs) return channels;
  return channels.filter((c) => prefs[c] !== false);
}

// Accept a few human-friendly aliases for the in-app channel so a prompt that
// emits `channel=in-app` (or `in_app`/`app`) routes ONLY to the in-app sink and
// never falls through to the all-channels default (which would page externally).
const CHANNEL_ALIASES: Record<string, NotifyChannel> = {
  inapp: 'inapp',
  'in-app': 'inapp',
  in_app: 'inapp',
  app: 'inapp',
  telegram: 'telegram',
  email: 'email',
  push: 'push',
};

function channelsFor(spec: string | null): NotifyChannel[] {
  const s = (spec ?? '').trim().toLowerCase();
  if (s === '' || s === 'all') return ALL_CHANNELS;
  const picked = s
    .split(/[,\s]+/)
    .map((c) => CHANNEL_ALIASES[c.trim()])
    .filter((c): c is NotifyChannel => c != null);
  return picked.length > 0 ? picked : ALL_CHANNELS;
}

/**
 * Stage policy (SPEC §3 matrix). Pure — no IO.
 *
 *   event=ship:
 *     development → no push (log in-session only)
 *     beta / production-maintenance → push FYI (info)
 *   event=gate (a blocking mandatory gate surfaced):
 *     development → never page (resolve-or-physically-blocked; log only)
 *     beta → notify on blocking gate (no forced halt here — controller halts)
 *     production-maintenance → HALT + fan-out to all channels
 *   event=info: honor the agent's requested level/channel as-is.
 */
export function shouldNotify(
  event: NotifyEvent,
  stage: LifecycleStage,
  opts: { level?: NotifyLevel; channel?: string | null } = {},
): NotifyDecision {
  const dev = stage === 'development';
  if (event === 'ship') {
    return dev
      ? { fire: false, channels: [], halt: false }
      : { fire: true, channels: channelsFor(opts.channel ?? 'all'), halt: false };
  }
  if (event === 'gate') {
    if (dev) return { fire: false, channels: [], halt: false };
    if (stage === 'beta') {
      return { fire: true, channels: channelsFor(opts.channel ?? 'all'), halt: false };
    }
    // production-maintenance
    return { fire: true, channels: ALL_CHANNELS, halt: true };
  }
  // info — honor the agent's request; dev still suppresses page-y channels.
  const channels = channelsFor(opts.channel ?? 'all');
  return { fire: true, channels: dev ? channels.filter((c) => c === 'inapp') : channels, halt: false };
}

export interface NotifyInput {
  userId: string;
  sessionId: string;
  event: NotifyEvent;
  level: NotifyLevel;
  /** Human-readable one-liner (the sentinel `detail`). */
  detail: string;
  channels: NotifyChannel[];
}

// Injectable seam (tests swap these for spies; defaults are the real adapters).
export interface NotifyDeps {
  getUserById: (id: string) => Promise<{ email?: string | null; telegram_chat_id?: string | number | null; notify_channels?: NotifyChannelPrefs | null } | null>;
  sendTelegram: (chatId: number | string, text: string) => Promise<unknown>;
  broadcastToUser: (userId: string, message: object) => void;
  sendEmail: (input: { to: string; subject: string; html: string; text: string }) => Promise<boolean>;
}

async function realDeps(): Promise<NotifyDeps> {
  const dal = await import('../db/dal.ts');
  const tg = await import('../telegram/client.ts');
  const reg = await import('../ws/registry.ts');
  const mail = await import('../lib/email.ts');
  return {
    getUserById: dal.getUserById as any,
    sendTelegram: (chatId, text) => tg.sendMessage(chatId, text),
    broadcastToUser: reg.broadcastToUser,
    sendEmail: mail.sendEmail,
  };
}

const SUBJECT_PREFIX = '[remo-code orchestrator]';

/**
 * Fan a notification out to the requested channels. NEVER throws — each channel
 * is wrapped; a failure is logged and the others still fire. Returns the set of
 * channels that reported success (best-effort; for observability/tests).
 */
export async function fanOutNotify(
  input: NotifyInput,
  deps?: NotifyDeps,
): Promise<{ delivered: NotifyChannel[] }> {
  const delivered: NotifyChannel[] = [];
  let d: NotifyDeps;
  try {
    d = deps ?? (await realDeps());
  } catch (err: any) {
    console.error('[orchestrator.notify] dep load failed:', err?.message ?? err);
    return { delivered };
  }

  const { userId, sessionId, event, level, detail } = input;
  const text = `${SUBJECT_PREFIX} ${event.toUpperCase()}${level === 'blocking' ? ' (BLOCKING)' : ''}: ${detail}`;

  // Resolve user once (telegram chat id + email + per-channel opt-in). Best-effort.
  let user:
    | { email?: string | null; telegram_chat_id?: string | number | null; notify_channels?: NotifyChannelPrefs | null }
    | null = null;
  try {
    user = await d.getUserById(userId);
  } catch (err: any) {
    console.warn('[orchestrator.notify] getUserById failed:', err?.message ?? err);
  }

  // §7.1: honor the user's per-channel opt-in. Default all-on (a null prefs map,
  // or an unset key, stays opted-IN). If getUserById failed we have no prefs →
  // fall through to the requested channels (preserves prior best-effort behavior).
  const channels = applyChannelPrefs(input.channels, user?.notify_channels ?? null);

  // in-app — always cheap; broadcast a structured event (badge + message).
  if (channels.includes('inapp')) {
    try {
      d.broadcastToUser(userId, {
        type: 'routine_notify',
        session_id: sessionId,
        event,
        level,
        detail,
      });
      delivered.push('inapp');
    } catch (err: any) {
      console.warn('[orchestrator.notify] in-app broadcast failed:', err?.message ?? err);
    }
  }

  // telegram — only if the user has a linked chat.
  if (channels.includes('telegram') && user?.telegram_chat_id != null) {
    try {
      await d.sendTelegram(user.telegram_chat_id, text);
      delivered.push('telegram');
    } catch (err: any) {
      console.warn('[orchestrator.notify] telegram send failed:', err?.message ?? err);
    }
  }

  // email — emails4agents (sendEmail already never-throws + env-gates).
  if (channels.includes('email') && user?.email) {
    try {
      const ok = await d.sendEmail({
        to: user.email,
        subject: `${SUBJECT_PREFIX} ${event}`,
        html: `<p>${escapeHtml(text)}</p>`,
        text,
      });
      if (ok) delivered.push('email');
    } catch (err: any) {
      console.warn('[orchestrator.notify] email send failed:', err?.message ?? err);
    }
  }

  // push — NO-OP until the mobile client resumes (Phase 12 paused).
  if (channels.includes('push')) {
    // intentionally no-op; counted as a channel for matrix symmetry only.
  }

  return { delivered };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
