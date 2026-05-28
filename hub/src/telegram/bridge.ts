/**
 * Phase 12 Wave 3 — Telegram outbound bridge.
 *
 * Subscribes to `assistant_message:final` events from the hub's internal
 * event bus and forwards the final assistant text to Telegram for every user
 * whose `telegram_default_session_id` matches the event's session.
 *
 * Strict invariants:
 *   - FINAL `assistant_message` only. Streaming `text_delta` / `thinking` /
 *     `tool_use` / `tool_result` never reach the bus and are therefore never
 *     forwarded. (Enforced at the emit site in ws/agent.ts.)
 *   - Feature-gated on `config.telegram.botToken`. With no token,
 *     `startTelegramBridge()` is a no-op — no listener is registered, no
 *     `sendMessage` is ever called.
 *   - Listener errors are swallowed. The emitter helper isolates throws,
 *     and we additionally try/catch every iteration so a Telegram 4xx/5xx
 *     can't break subsequent sends.
 *   - Per-chat serialization. Telegram rate-limits per chat at ~1 msg/sec.
 *     We hold a `Map<chatId, Promise<void>>` and chain each send onto the
 *     previous in-flight send for the same chat. Prevents 429s and out-of-
 *     order delivery without blocking other chats.
 *   - Idempotent boot. `startTelegramBridge()` may be called multiple times
 *     (hot-reload, test setup) — a module-scoped `started` flag guards
 *     against double-subscription.
 *
 * NOT in scope for MVP:
 *   - Global rate limit (30 msg/sec across all chats). Per-chat throttle is
 *     enough for the expected MVP traffic.
 *   - Markdown / formatting. We send plain text — `client.sendMessage`
 *     handles 4096-char split internally. Markdown escaping would require
 *     deciding what to preserve; punt to a future wave.
 */

import { config } from "../config.ts";
import { onAssistantMessageFinal, type AssistantMessageFinalEvent } from "../events/assistant-events.ts";
import { getUsersWithTelegramDefaultSession } from "../db/dal.ts";
import { sendMessage } from "./client.ts";

let started = false;
let unsubscribe: (() => void) | null = null;

// Per-chat serial queue. Key = chat_id (stringified to dodge bigint vs number
// equality surprises). Value = the tail Promise; new sends chain onto it.
const chatQueues = new Map<string, Promise<void>>();

function chatKey(chatId: string | number | bigint): string {
  return String(chatId);
}

/**
 * Append `task` onto the serial queue for `chatId`. Returns a promise that
 * resolves when `task` itself settles. The tail in the map always settles
 * (errors are swallowed) so a failed send never poisons the queue.
 */
function enqueueForChat(chatId: string | number | bigint, task: () => Promise<void>): Promise<void> {
  const key = chatKey(chatId);
  const prev = chatQueues.get(key) ?? Promise.resolve();
  const next = prev.then(task, task); // run regardless of prior outcome
  // Track a tail that always resolves so the map never holds a rejected promise.
  const tail = next.catch(() => undefined);
  chatQueues.set(key, tail);
  // Clean up when this is the last queued entry — avoid an unbounded map.
  tail.then(() => {
    if (chatQueues.get(key) === tail) chatQueues.delete(key);
  });
  return next;
}

async function onFinal(e: AssistantMessageFinalEvent): Promise<void> {
  let users: Array<{ id: string; telegram_chat_id: string | number }>;
  try {
    users = await getUsersWithTelegramDefaultSession(e.sessionId);
  } catch (err: any) {
    console.warn(`[telegram-bridge] DAL lookup failed session=${e.sessionId}: ${err?.message ?? err}`);
    return;
  }
  if (users.length === 0) return;

  for (const u of users) {
    const chatId = u.telegram_chat_id;
    if (chatId === null || chatId === undefined) continue;
    // Fire-and-forget — the queue ensures per-chat serialization. We do NOT
    // await across users; different chats progress in parallel.
    void enqueueForChat(chatId, async () => {
      try {
        await sendMessage(chatId as number | string, e.text);
      } catch (err: any) {
        console.warn(
          `[telegram-bridge] sendMessage failed chat=${chatKey(chatId)} session=${e.sessionId}: ${err?.message ?? err}`,
        );
      }
    });
  }
}

/**
 * Boot the bridge. Idempotent. No-op when `TELEGRAM_BOT_TOKEN` is unset.
 * Call once from `hub/src/index.ts` after DB init.
 */
export function startTelegramBridge(): void {
  if (started) return;
  if (!config.telegram.botToken) {
    // Disabled — do not subscribe. No noise in logs (boot already warned if
    // exactly one of botToken/webhookSecret was set).
    return;
  }
  unsubscribe = onAssistantMessageFinal(onFinal);
  started = true;
  console.log("[telegram-bridge] outbound bridge started");
}

/** Test-only — stop the bridge and clear queues. */
export function _stopTelegramBridgeForTests(): void {
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }
  started = false;
  chatQueues.clear();
}
