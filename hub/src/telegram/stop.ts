/**
 * Telegram "Stop a running turn" — shared cancel path + inline-button registry.
 *
 * Two entry points reuse ONE code path (`requestStop`):
 *   - the 🛑 Stop inline button attached to the streaming "⏳ Working…" message
 *     (callback `sx:<sessionId>`), resolved in telegram-webhook.ts;
 *   - the `/stop` command, which targets the user's default/orchestrator session.
 *
 * Stopping a turn forwards the SAME `{ type:'cancel', session_id }` frame the web
 * client sends, onto the session's agent socket via `getChannel`. No new dispatch
 * path, no cost-cap interaction — this only halts an in-flight turn.
 *
 * Authorization fails closed at TWO layers:
 *   1. `requestStop` re-verifies the tapping/commanding user OWNS the session via
 *      `getSession(sessionId, userId)`. A user who doesn't own the session (or a
 *      forged/foreign sessionId on the callback wire) gets `not_authorized`.
 *   2. The button registry (below) only records the users the working message was
 *      fanned to (those whose `telegram_default_session_id` matches), so a tap
 *      from an unrelated chat finds no entry. The webhook resolves the tapping
 *      user server-side (`getUserByTelegramChatId`) — never from callback_data.
 *
 * The sessionId IS carried on the callback wire (it fits Telegram's 64-byte cap:
 * `sx:` + a 36-char UUID = 39 bytes) purely to locate the entry; it is NEVER
 * trusted for authorization — see layer 1.
 *
 * Take-once: the first successful stop removes the (sessionId) entry, so a second
 * tap by any authorized user is a benign no-op ("already stopped").
 */

import { getChannel } from "../ws/registry.ts";
import { getSession } from "../db/dal.ts";

// ── callback_data codec (≤64 bytes) ─────────────────────────────────────────
// "sx:<sessionId>" — stop the in-flight turn for <sessionId>.

const STOP_PREFIX = "sx:";

export function stopCallbackData(sessionId: string): string {
  return STOP_PREFIX + sessionId;
}

export type StopCallback = { sessionId: string };

/** Parse a stop callback_data string, or null if it isn't one. */
export function parseStopCallback(data: string | undefined | null): StopCallback | null {
  if (!data) return null;
  if (data.length > 64) return null; // Telegram hard limit; defensive.
  if (!data.startsWith(STOP_PREFIX)) return null;
  const id = data.slice(STOP_PREFIX.length);
  if (id.length === 0 || id.length > 60) return null;
  return { sessionId: id };
}

// ── Button registry: (sessionId) → authorized stoppers ──────────────────────
// Mirrors approvals.ts shape. A working message can fan to MORE THAN ONE user
// (several users share one default session); each authorized user is recorded so
// whichever taps first resolves it. Pruned on a TTL — a turn never runs forever.

/** A Stop button is actionable for at most this long after its turn started. */
export const STOP_TTL_MS = 60 * 60 * 1000; // 1h — generous upper bound on a turn.

interface StopEntry {
  createdAtMs: number;
  /** userId → that user's chat/message context (for the edit-to-"Stopped"). */
  byUser: Map<string, { chatId: number | string; messageId: number }>;
}

const pending = new Map<string, StopEntry>();

function prune(now: number): void {
  for (const [id, e] of pending) {
    if (now - e.createdAtMs > STOP_TTL_MS) pending.delete(id);
  }
}

/**
 * Record that `userId` may stop `sessionId` via the working message at
 * (chatId, messageId). Idempotent per (sessionId, userId): re-recording updates
 * that user's chat/message context (the working message id changes per turn).
 */
export function rememberStoppable(
  sessionId: string,
  userId: string,
  ctx: { chatId: number | string; messageId: number },
): void {
  prune(Date.now());
  let entry = pending.get(sessionId);
  if (!entry) {
    entry = { createdAtMs: Date.now(), byUser: new Map() };
    pending.set(sessionId, entry);
  }
  entry.byUser.set(userId, ctx);
}

/**
 * Look up + REMOVE the stop entry for a tapping `userId`. Returns that user's
 * chat/message context if authorized, else null (unknown session, stale, already
 * stopped, or the user wasn't fanned this working message). Resolves the whole
 * (sessionId) entry exactly once.
 */
export function takeStoppable(
  sessionId: string,
  userId: string,
): { chatId: number | string; messageId: number } | null {
  const entry = pending.get(sessionId);
  if (!entry) return null;
  const ctx = entry.byUser.get(userId);
  if (!ctx) return null; // not an authorized stopper for this working message
  const stale = Date.now() - entry.createdAtMs > STOP_TTL_MS;
  pending.delete(sessionId); // resolve the entry exactly once
  if (stale) return null;
  return ctx;
}

/** Drop the entry for a session once its turn finalizes (so the button is dead). */
export function forgetStoppable(sessionId: string): void {
  pending.delete(sessionId);
}

/** Test-only — clear the registry. */
export function _resetStoppableForTests(): void {
  pending.clear();
}

// ── Shared cancel path ──────────────────────────────────────────────────────

export type StopOutcome = "stopped" | "not_authorized" | "offline" | "send_failed";

/**
 * Halt the in-flight turn for `sessionId` on behalf of `userId`.
 *
 * Authorization fails closed: the user MUST own the session (`getSession`).
 * Sends the same `{ type:'cancel', session_id }` frame the web client sends.
 *
 * `getSessionImpl` / `getChannelImpl` are injectable for tests.
 */
export async function requestStop(opts: {
  sessionId: string;
  userId: string;
  getSessionImpl?: typeof getSession;
  getChannelImpl?: typeof getChannel;
}): Promise<StopOutcome> {
  const getSessionFn = opts.getSessionImpl ?? getSession;
  const getChannelFn = opts.getChannelImpl ?? getChannel;

  // (1) Ownership — fail closed. A foreign / forged sessionId resolves to no row.
  let owned: unknown;
  try {
    owned = await getSessionFn(opts.sessionId, opts.userId);
  } catch {
    return "not_authorized";
  }
  if (!owned) return "not_authorized";

  // (2) Session must have a live agent channel to receive the cancel.
  const channel = getChannelFn(opts.sessionId);
  if (!channel) return "offline";

  // (3) Forward the cancel frame (identical to the web client's cancel).
  try {
    channel.ws.send(JSON.stringify({ type: "cancel", session_id: opts.sessionId }));
  } catch {
    return "send_failed";
  }
  return "stopped";
}
