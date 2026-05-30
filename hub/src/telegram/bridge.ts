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
import { onPermissionPending, type PermissionPendingEvent } from "../events/permission-events.ts";
import { onSessionActivity, type SessionActivityEvent } from "../events/session-activity-events.ts";
import { getUsersWithTelegramDefaultSession } from "../db/dal.ts";
import {
  sendMessageMd,
  sendMessageWithKeyboard,
  sendChatAction,
  editMessageTextMd,
  escapeMarkdownV2,
  setMyCommands,
} from "./client.ts";
import { BOT_COMMANDS } from "./commands.ts";
import { rememberPendingPrompt, permissionCallbackData } from "./approvals.ts";
import { rememberStoppable, forgetStoppable, stopCallbackData } from "./stop.ts";
import type { InlineKeyboard } from "./client.ts";

let started = false;
let unsubscribe: (() => void) | null = null;
let unsubscribePermission: (() => void) | null = null;
let unsubscribeActivity: (() => void) | null = null;

// ── Summarized-streaming state ──────────────────────────────────────────────
// One editable "working…" message per (chat, session). tool_use events append
// collapsed one-liners; the final assistant_message edits it to the full text.
const TYPING_REFRESH_MS = 4000; // Telegram typing expires ~5s
const EDIT_THROTTLE_MS = 900; // avoid hammering editMessageText (Telegram rate-limits edits)
const MAX_TOOL_LINES = 12; // cap the collapsed list so the working message stays small

interface WorkingState {
  messageId: number;
  lines: string[];
  typingTimer: ReturnType<typeof setInterval> | null;
  lastEditAt: number;
  pendingEdit: boolean;
}

const workingByKey = new Map<string, WorkingState>();

function workKey(chatId: string | number | bigint, sessionId: string): string {
  return `${String(chatId)}:${sessionId}`;
}

/** Collapse a tool_use into a one-line summary, e.g. "🔧 Edit hub/src/foo.ts". */
function toolLine(toolName: string, detail?: string): string {
  const d = (detail ?? "").trim();
  const short = d.length > 80 ? d.slice(0, 79) + "…" : d;
  return `🔧 ${toolName}${short ? " " + short : ""}`;
}

/** Render the in-progress working message body (escaped MarkdownV2). */
function renderWorking(lines: string[]): string {
  const head = "⏳ *Working…*";
  if (lines.length === 0) return head;
  const body = lines.map((l) => escapeMarkdownV2(l)).join("\n");
  return head + "\n\n" + body;
}

/** Inline keyboard with a single 🛑 Stop button bound to `sessionId`. */
function stopKeyboard(sessionId: string): InlineKeyboard {
  return [[{ text: "🛑 Stop", callback_data: stopCallbackData(sessionId) }]];
}

function stopTyping(st: WorkingState): void {
  if (st.typingTimer) {
    clearInterval(st.typingTimer);
    st.typingTimer = null;
  }
}

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

/**
 * A tool was invoked mid-turn. When summarized streaming is on, lazily create an
 * editable "working…" message per (chat, session) and append a collapsed
 * one-liner. Also (re)start the typing indicator. No-op when the flag is off.
 */
async function onActivity(e: SessionActivityEvent): Promise<void> {
  if (!config.telegram.summarizedStreaming) return;
  if (e.kind !== "tool_use") return;
  let users: Array<{ id: string; telegram_chat_id: string | number }>;
  try {
    users = await getUsersWithTelegramDefaultSession(e.sessionId);
  } catch (err: any) {
    console.warn(`[telegram-bridge] activity DAL lookup failed session=${e.sessionId}: ${err?.message ?? err}`);
    return;
  }
  if (users.length === 0) return;

  const line = toolLine(e.toolName, e.detail);
  const keyboard = stopKeyboard(e.sessionId);
  for (const u of users) {
    const chatId = u.telegram_chat_id;
    if (chatId === null || chatId === undefined) continue;
    const key = workKey(chatId, e.sessionId);
    void enqueueForChat(chatId, async () => {
      let st = workingByKey.get(key);
      try {
        if (!st) {
          // Refresh typing immediately, then on an interval until finalized.
          await sendChatAction(chatId as number | string, "typing");
          const sent = await sendMessageMd(chatId as number | string, renderWorking([line]), keyboard);
          const messageId = sent?.message_id ?? 0;
          if (!messageId) return; // couldn't anchor an editable message; skip streaming for this turn
          // Record (sessionId → this user @ this working message) so a 🛑 tap can
          // be authorized server-side and edit the right message. Take-once.
          rememberStoppable(e.sessionId, u.id, { chatId, messageId });
          const typingTimer = setInterval(() => {
            void sendChatAction(chatId as number | string, "typing");
          }, TYPING_REFRESH_MS);
          st = { messageId, lines: [line], typingTimer, lastEditAt: Date.now(), pendingEdit: false };
          workingByKey.set(key, st);
          return;
        }
        // Append + edit (throttled). Cap the visible list. Keep the Stop button.
        st.lines.push(line);
        if (st.lines.length > MAX_TOOL_LINES) st.lines = st.lines.slice(-MAX_TOOL_LINES);
        const sinceEdit = Date.now() - st.lastEditAt;
        if (sinceEdit >= EDIT_THROTTLE_MS) {
          st.lastEditAt = Date.now();
          await editMessageTextMd(chatId as number | string, st.messageId, renderWorking(st.lines), keyboard);
        }
      } catch (err: any) {
        console.warn(
          `[telegram-bridge] activity edit failed chat=${chatKey(chatId)} session=${e.sessionId}: ${err?.message ?? err}`,
        );
      }
    });
  }
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

  const finalMd = escapeMarkdownV2(e.text);
  for (const u of users) {
    const chatId = u.telegram_chat_id;
    if (chatId === null || chatId === undefined) continue;
    const key = workKey(chatId, e.sessionId);
    // Fire-and-forget — the queue ensures per-chat serialization. We do NOT
    // await across users; different chats progress in parallel.
    void enqueueForChat(chatId, async () => {
      const st = workingByKey.get(key);
      try {
        if (st) {
          // Finalize the editable working message with the full assistant text.
          // The turn is over → drop the Stop entry (and the final edit passes no
          // keyboard, so the 🛑 button disappears).
          stopTyping(st);
          workingByKey.delete(key);
          forgetStoppable(e.sessionId);
          if (e.text.length <= 4096) {
            await editMessageTextMd(chatId as number | string, st.messageId, finalMd);
            return;
          }
          // Too long to fit one edited message — leave the working summary and
          // send the full text as a follow-up (MarkdownV2 → plaintext fallback).
          await sendMessageMd(chatId as number | string, finalMd);
          return;
        }
        // No working message (streaming off, or no tool calls this turn) — send
        // the final text as a fresh MarkdownV2 message.
        await sendMessageMd(chatId as number | string, finalMd);
      } catch (err: any) {
        if (st) stopTyping(st);
        workingByKey.delete(key);
        forgetStoppable(e.sessionId);
        console.warn(
          `[telegram-bridge] final send failed chat=${chatKey(chatId)} session=${e.sessionId}: ${err?.message ?? err}`,
        );
      }
    });
  }
}

/** Best-effort one-line preview of a tool input for the approval prompt. */
function previewToolInput(input: unknown): string {
  if (input == null) return "";
  try {
    const obj = input as Record<string, unknown>;
    const cmd = obj.command ?? obj.file_path ?? obj.path ?? obj.url;
    if (typeof cmd === "string") return cmd.length > 200 ? cmd.slice(0, 199) + "…" : cmd;
    const json = JSON.stringify(input);
    return json.length > 200 ? json.slice(0, 199) + "…" : json;
  } catch {
    return "";
  }
}

/**
 * A runner raised a permission prompt. Surface it inline (Approve/Deny) to every
 * user whose Telegram default session is the emitting session, and record the
 * pending prompt so the webhook callback can resolve it.
 */
async function onPermissionPendingEvent(e: PermissionPendingEvent): Promise<void> {
  let users: Array<{ id: string; telegram_chat_id: string | number }>;
  try {
    users = await getUsersWithTelegramDefaultSession(e.sessionId);
  } catch (err: any) {
    console.warn(`[telegram-bridge] permission DAL lookup failed session=${e.sessionId}: ${err?.message ?? err}`);
    return;
  }
  if (users.length === 0) return;

  const preview = previewToolInput(e.toolInput);
  // MarkdownV2: escape dynamic content, keep our own *bold* / ```code``` markup.
  const text =
    `🔐 Approval needed — *${escapeMarkdownV2(e.toolName)}*` +
    (preview ? "\n\n```\n" + escapeMarkdownV2(preview) + "\n```" : "") +
    `\n\nApprove this action?`;
  const keyboard = [[
    { text: "✅ Approve", callback_data: permissionCallbackData(e.requestId, "approve") },
    { text: "🚫 Deny", callback_data: permissionCallbackData(e.requestId, "deny") },
  ]];

  for (const u of users) {
    const chatId = u.telegram_chat_id;
    if (chatId === null || chatId === undefined) continue;
    void enqueueForChat(chatId, async () => {
      try {
        let sent: { message_id: number } | void;
        try {
          sent = await sendMessageWithKeyboard(chatId as number | string, text, keyboard, {
            parse_mode: "MarkdownV2",
          });
        } catch (mdErr: any) {
          // 400 → markup rejected; resend as plain text so the prompt is never
          // silently dropped (the inline keyboard still works).
          if (mdErr?.status === 400) {
            sent = await sendMessageWithKeyboard(chatId as number | string, text, keyboard);
          } else {
            throw mdErr;
          }
        }
        // Record the pending prompt so the callback can resolve it. Keyed by
        // (sessionId, requestId) with THIS user authorized — a shared default
        // session no longer overwrites a sibling user's binding.
        rememberPendingPrompt(e.sessionId, e.requestId, {
          sessionId: e.sessionId,
          userId: u.id,
          chatId,
          messageId: sent?.message_id ?? 0,
          toolName: e.toolName,
          createdAtMs: Date.now(),
        });
      } catch (err: any) {
        console.warn(
          `[telegram-bridge] permission prompt send failed chat=${chatKey(chatId)} session=${e.sessionId}: ${err?.message ?? err}`,
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
  unsubscribePermission = onPermissionPending(onPermissionPendingEvent);
  unsubscribeActivity = onSessionActivity(onActivity);
  started = true;
  // Register the slash-command menu so typing `/` shows a popup. Best-effort,
  // fire-and-forget — a transient failure must not block bridge startup.
  void setMyCommands(BOT_COMMANDS as Array<{ command: string; description: string }>).catch((err: any) => {
    console.warn(`[telegram-bridge] setMyCommands failed: ${err?.message ?? err}`);
  });
  console.log("[telegram-bridge] outbound bridge started");
}

/** Test-only — stop the bridge and clear queues. */
export function _stopTelegramBridgeForTests(): void {
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }
  if (unsubscribePermission) {
    unsubscribePermission();
    unsubscribePermission = null;
  }
  if (unsubscribeActivity) {
    unsubscribeActivity();
    unsubscribeActivity = null;
  }
  for (const st of workingByKey.values()) stopTyping(st);
  workingByKey.clear();
  started = false;
  chatQueues.clear();
}
