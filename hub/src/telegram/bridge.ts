/**
 * Phase 20 — Telegram outbound bridge, re-sourced on the transcript-tail.
 *
 * After the Phase-17 rip the stream-json assistant-final / permission event bus
 * the old bridge consumed is gone. The bridge now
 * sources every session's output from its on-disk transcript via the per-session
 * `TranscriptSource` manager (`transcript/manager.ts`) — backend-agnostic
 * (Claude projects JSONL / Codex rollout JSONL + scrape fallback), selected by
 * the session's `cli_kind`. The bridge consumes ONLY the normalized
 * `TranscriptEntry` union; it never sees a backend-specific shape and no longer
 * subscribes to the deleted assistant-final event bus.
 *
 * Strict invariants (unchanged from the event-bus era):
 *   - FINAL assistant text + collapsed tool one-liners only. Streaming deltas
 *     never exist in the transcript stream (the adapter emits assistant_text as a
 *     completed turn), so partials are never forwarded.
 *   - Feature-gated on `config.telegram.botToken`. No token ⇒ `startTelegramBridge`
 *     is a no-op.
 *   - Per-chat serialization via `Map<chatId, Promise>` to dodge Telegram's
 *     ~1 msg/sec per-chat rate limit and keep ordering.
 *   - Idempotent boot.
 *
 * Subscription lifecycle: the bridge opens a transcript source for a session
 * LAZILY when a Telegram-default user dispatches to it (`ensureSessionSubscribed`,
 * called from the inbound dispatch path). The source stays open while the bridge
 * holds it; `_stopTelegramBridgeForTests` releases all. Permission detection +
 * surfacing (plan 03) and turn-lock release (plan 04) attach their OWN consumers
 * to the same manager source — one tail, many consumers.
 */

import { config } from "../config.ts";
import { getUsersWithTelegramDefaultSession } from "../db/dal.ts";
import {
  subscribeToSessionTranscript,
} from "./transcript/manager.ts";
import type { TranscriptEntry } from "./transcript/types.ts";
import {
  sendMessageMd,
  sendChatAction,
  editMessageTextMd,
  escapeMarkdownV2,
  setMyCommands,
  setWebhook,
} from "./client.ts";
import { BOT_COMMANDS } from "./commands.ts";
import { rememberStoppable, forgetStoppable, stopCallbackData } from "./stop.ts";
import { startPermissionSurfacing, stopPermissionSurfacing } from "./permission-surfacing.ts";
import type { InlineKeyboard } from "./client.ts";

let started = false;

// Per-session transcript subscription unsubscribe fns (bridge-owned consumer).
const sessionUnsubs = new Map<string, () => void>();

// ── Summarized-streaming state ──────────────────────────────────────────────
const TYPING_REFRESH_MS = 4000;
const EDIT_THROTTLE_MS = 900;
const MAX_TOOL_LINES = 12;

interface WorkingState {
  messageId: number;
  lines: string[];
  typingTimer: ReturnType<typeof setInterval> | null;
  lastEditAt: number;
}

const workingByKey = new Map<string, WorkingState>();

function workKey(chatId: string | number | bigint, sessionId: string): string {
  return `${String(chatId)}:${sessionId}`;
}

function toolLine(toolName: string, detail?: string): string {
  const d = (detail ?? "").trim();
  const short = d.length > 80 ? d.slice(0, 79) + "…" : d;
  return `🔧 ${toolName}${short ? " " + short : ""}`;
}

function renderWorking(lines: string[]): string {
  const head = "⏳ *Working…*";
  if (lines.length === 0) return head;
  const body = lines.map((l) => escapeMarkdownV2(l)).join("\n");
  return head + "\n\n" + body;
}

function stopKeyboard(sessionId: string): InlineKeyboard {
  return [[{ text: "🛑 Stop", callback_data: stopCallbackData(sessionId) }]];
}

function stopTyping(st: WorkingState): void {
  if (st.typingTimer) {
    clearInterval(st.typingTimer);
    st.typingTimer = null;
  }
}

// Per-chat serial queue.
const chatQueues = new Map<string, Promise<void>>();

function chatKey(chatId: string | number | bigint): string {
  return String(chatId);
}

function enqueueForChat(chatId: string | number | bigint, task: () => Promise<void>): Promise<void> {
  const key = chatKey(chatId);
  const prev = chatQueues.get(key) ?? Promise.resolve();
  const next = prev.then(task, task);
  const tail = next.catch(() => undefined);
  chatQueues.set(key, tail);
  tail.then(() => {
    if (chatQueues.get(key) === tail) chatQueues.delete(key);
  });
  return next;
}

/** A tool_use transcript entry → append a collapsed line to the working msg. */
async function onToolUse(sessionId: string, toolName: string, detail?: string): Promise<void> {
  if (!config.telegram.summarizedStreaming) return;
  let users: Array<{ id: string; telegram_chat_id: string | number }>;
  try {
    users = await getUsersWithTelegramDefaultSession(sessionId);
  } catch (err: any) {
    console.warn(`[telegram-bridge] tool_use DAL lookup failed session=${sessionId}: ${err?.message ?? err}`);
    return;
  }
  if (users.length === 0) return;

  const line = toolLine(toolName, detail);
  const keyboard = stopKeyboard(sessionId);
  for (const u of users) {
    const chatId = u.telegram_chat_id;
    if (chatId === null || chatId === undefined) continue;
    const key = workKey(chatId, sessionId);
    void enqueueForChat(chatId, async () => {
      let st = workingByKey.get(key);
      try {
        if (!st) {
          await sendChatAction(chatId as number | string, "typing");
          const sent = await sendMessageMd(chatId as number | string, renderWorking([line]), keyboard);
          const messageId = sent?.message_id ?? 0;
          if (!messageId) return;
          rememberStoppable(sessionId, u.id, { chatId, messageId });
          const typingTimer = setInterval(() => {
            void sendChatAction(chatId as number | string, "typing");
          }, TYPING_REFRESH_MS);
          st = { messageId, lines: [line], typingTimer, lastEditAt: Date.now() };
          workingByKey.set(key, st);
          return;
        }
        st.lines.push(line);
        if (st.lines.length > MAX_TOOL_LINES) st.lines = st.lines.slice(-MAX_TOOL_LINES);
        const sinceEdit = Date.now() - st.lastEditAt;
        if (sinceEdit >= EDIT_THROTTLE_MS) {
          st.lastEditAt = Date.now();
          await editMessageTextMd(chatId as number | string, st.messageId, renderWorking(st.lines), keyboard);
        }
      } catch (err: any) {
        console.warn(
          `[telegram-bridge] tool_use edit failed chat=${chatKey(chatId)} session=${sessionId}: ${err?.message ?? err}`,
        );
      }
    });
  }
}

/** An assistant_text (final) transcript entry → forward / finalize working msg. */
async function onAssistantText(sessionId: string, text: string): Promise<void> {
  let users: Array<{ id: string; telegram_chat_id: string | number }>;
  try {
    users = await getUsersWithTelegramDefaultSession(sessionId);
  } catch (err: any) {
    console.warn(`[telegram-bridge] DAL lookup failed session=${sessionId}: ${err?.message ?? err}`);
    return;
  }
  if (users.length === 0) return;

  const finalMd = escapeMarkdownV2(text);
  for (const u of users) {
    const chatId = u.telegram_chat_id;
    if (chatId === null || chatId === undefined) continue;
    const key = workKey(chatId, sessionId);
    void enqueueForChat(chatId, async () => {
      const st = workingByKey.get(key);
      try {
        if (st) {
          stopTyping(st);
          workingByKey.delete(key);
          forgetStoppable(sessionId);
          if (text.length <= 4096) {
            await editMessageTextMd(chatId as number | string, st.messageId, finalMd);
            return;
          }
          await sendMessageMd(chatId as number | string, finalMd);
          return;
        }
        await sendMessageMd(chatId as number | string, finalMd);
      } catch (err: any) {
        if (st) stopTyping(st);
        workingByKey.delete(key);
        forgetStoppable(sessionId);
        console.warn(
          `[telegram-bridge] final send failed chat=${chatKey(chatId)} session=${sessionId}: ${err?.message ?? err}`,
        );
      }
    });
  }
}

/** The bridge's own transcript consumer — handles output entries only.
 *  Permission detection (plan 03) and turn-lock release (plan 04) attach their
 *  OWN consumers to the same source via the manager. */
function bridgeConsumer(entry: TranscriptEntry): void {
  switch (entry.kind) {
    case "assistant_text":
      void onAssistantText(entry.sessionId, entry.text);
      break;
    case "tool_use":
      void onToolUse(entry.sessionId, entry.toolName, entry.detail);
      break;
    // permission_request / user_question — handled by the permission surfacing
    // consumer (plan 03), NOT here.
    // turn_complete — consumed by the turn lock (plan 04).
    default:
      break;
  }
}

/**
 * Ensure a transcript source is open for `sessionId` with the bridge's output
 * consumer (and the permission-surfacing consumer) attached. Idempotent per
 * session. Called from the inbound dispatch path when a Telegram user sends to a
 * session (the moment we know the session is telegram-relevant + likely live).
 * No-op when the bridge isn't started (no token).
 */
export async function ensureSessionSubscribed(sessionId: string): Promise<void> {
  if (!started) return;
  if (sessionUnsubs.has(sessionId)) return;
  const unsub = await subscribeToSessionTranscript(sessionId, bridgeConsumer);
  if (!unsub) return; // no session row / unresolvable
  // Guard against a racing concurrent call having installed one already.
  if (sessionUnsubs.has(sessionId)) {
    unsub();
    return;
  }
  sessionUnsubs.set(sessionId, unsub);
  // Plan 03: attach the fail-closed permission surfacing consumer to the SAME
  // source (one tail, many consumers). It manages its own unsubscribe lifetime.
  await startPermissionSurfacing(sessionId);
}

/** Release a session's transcript subscription (e.g. on idle teardown). */
export function releaseSessionSubscription(sessionId: string): void {
  const unsub = sessionUnsubs.get(sessionId);
  if (unsub) {
    unsub();
    sessionUnsubs.delete(sessionId);
  }
  stopPermissionSurfacing(sessionId);
}

/**
 * Boot the bridge. Idempotent. No-op when `TELEGRAM_BOT_TOKEN` is unset.
 */
export function startTelegramBridge(): void {
  if (started) return;
  if (!config.telegram.botToken) return;
  started = true;
  void setMyCommands(BOT_COMMANDS as Array<{ command: string; description: string }>).catch((err: any) => {
    console.warn(`[telegram-bridge] setMyCommands failed: ${err?.message ?? err}`);
  });
  if (config.telegram.webhookSecret) {
    const base = (process.env.REMO_PUBLIC_URL || "https://app.remo-code.com").replace(/\/+$/, "");
    const webhookUrl = `${base}/api/telegram/webhook/${config.telegram.webhookSecret}`;
    void setWebhook(webhookUrl).catch((err: any) => {
      console.warn(`[telegram-bridge] setWebhook failed: ${err?.message ?? err}`);
    });
  }
  console.log("[telegram-bridge] transcript-tail outbound bridge started");
}

/** Test-only — stop the bridge and clear queues + subscriptions. */
export function _stopTelegramBridgeForTests(): void {
  for (const unsub of sessionUnsubs.values()) {
    try {
      unsub();
    } catch {
      /* ignore */
    }
  }
  sessionUnsubs.clear();
  for (const st of workingByKey.values()) stopTyping(st);
  workingByKey.clear();
  started = false;
  chatQueues.clear();
}

/** Test-only — force the started flag (so ensureSessionSubscribed runs). */
export function _setStartedForTests(v: boolean): void {
  started = v;
}

/** Test-only — the bridge's transcript consumer (for direct unit feeding). */
export const _bridgeConsumerForTests = bridgeConsumer;
