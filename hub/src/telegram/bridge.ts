/**
 * Telegram OUTBOUND bridge — DUAL-SOURCE, flag-gated on `REMO_TELEGRAM_TRANSCRIPT_TAIL`.
 *
 * There are two distinct sources for the assistant replies / tool one-liners /
 * permission prompts that get forwarded to Telegram. Which one is active is
 * decided ONCE at boot by `config.telegramTranscriptTail` (env
 * `REMO_TELEGRAM_TRANSCRIPT_TAIL`). NOTE: this is DECOUPLED from the web PTY flag
 * `REMO_PTY_INTERACTIVE` — flipping the web terminal on does NOT switch Telegram to
 * the transcript-tail, because that path needs CLI transcripts co-located with the
 * hub (false in the Coolify split topology). Keep this OFF in the Coolify hub:
 *
 *   ── flag OFF (PROD DEFAULT) — stream-json event-bus source ────────────────
 *   The bridge subscribes to the hub's internal event bus:
 *     - `onAssistantMessageFinal` → final assistant text  (assistant_message:final)
 *     - `onSessionActivity`       → tool_use one-liners    (summarized streaming)
 *     - `onPermissionPending`     → inline Approve/Deny prompts
 *   These events are emitted from the stream-json runner finalize path in
 *   `ws/agent.ts` and live ENTIRELY in hub memory — they do NOT touch the local
 *   filesystem. This is the ONLY host-agnostic source and is what works in the
 *   prod Coolify hub (where the CLI + its transcript files live on a DIFFERENT
 *   host — the supervisor — so there are no `~/.claude/projects/...` files to
 *   tail). This path is byte-for-byte the origin/main behavior the live user
 *   has today.
 *
 *   ── flag ON (POST-CUTOVER) — transcript-tail source ───────────────────────
 *   The bridge sources every session's output from its on-disk transcript via
 *   the per-session `TranscriptSource` manager (`transcript/manager.ts`) —
 *   backend-agnostic (Claude projects JSONL / Codex rollout JSONL + scrape
 *   fallback), selected by the session's `cli_kind`. Permission surfacing
 *   (plan 03) and turn-lock release (plan 04) attach their OWN consumers to the
 *   same source. This is the source for the interactive-PTY world AFTER the
 *   cutover, when the CLI runs co-located with a transcript the consumer can
 *   read. It is NOT safe in the current split hub/supervisor prod topology,
 *   hence the gate.
 *
 * Strict invariants (identical for both sources):
 *   - FINAL assistant text + collapsed tool one-liners only. No streaming deltas.
 *   - Feature-gated on `config.telegram.botToken`. No token ⇒ no-op boot.
 *   - Per-chat serialization via `Map<chatId, Promise>` (Telegram ~1 msg/sec/chat).
 *   - Idempotent boot.
 */

import { config } from "../config.ts";
import {
  onAssistantMessageFinal,
  type AssistantMessageFinalEvent,
} from "../events/assistant-events.ts";
import {
  onPermissionPending,
  type PermissionPendingEvent,
} from "../events/permission-events.ts";
import {
  onQuestionPending,
  type QuestionPendingEvent,
} from "../events/question-events.ts";
import {
  onSessionActivity,
  type SessionActivityEvent,
} from "../events/session-activity-events.ts";
import { getUsersWithTelegramDefaultSession } from "../db/dal.ts";
import {
  subscribeToSessionTranscript,
} from "./transcript/manager.ts";
import type { TranscriptEntry } from "./transcript/types.ts";
import {
  sendMessageMd,
  sendMessageHtml,
  sendMessageWithKeyboard,
  sendChatAction,
  editMessageTextHtml,
  escapeHtml,
  escapeMarkdownV2,
  setMyCommands,
  setWebhook,
} from "./client.ts";
import { BOT_COMMANDS } from "./commands.ts";
import { rememberPendingPrompt, permissionCallbackData } from "./approvals.ts";
import { rememberQuestionOption, questionCallbackData } from "./question-approvals.ts";
import { rememberStoppable, forgetStoppable, stopCallbackData } from "./stop.ts";
import { startPermissionSurfacing, stopPermissionSurfacing } from "./permission-surfacing.ts";
import { onTurnComplete } from "./turn-lock.ts";
import type { InlineKeyboard } from "./client.ts";

let started = false;

// Event-bus unsubscribe fns (flag-OFF / stream-json source).
let unsubscribeFinal: (() => void) | null = null;
let unsubscribePermission: (() => void) | null = null;
let unsubscribeQuestion: (() => void) | null = null;
let unsubscribeActivity: (() => void) | null = null;

// Per-session transcript subscription unsubscribe fns (flag-ON / transcript source).
const sessionUnsubs = new Map<string, () => void>();

// ── Summarized-streaming state ──────────────────────────────────────────────
const TYPING_REFRESH_MS = 4000;
const EDIT_THROTTLE_MS = 900;
const MAX_TOOL_LINES = 12;
/** Telegram's hard per-message cap (UTF-16 code units). */
const MAX_TG_LEN = 4096;

interface WorkingState {
  messageId: number;
  lines: string[];
  /** TOTAL tool calls this turn (not capped by MAX_TOOL_LINES — drives the summary). */
  toolCount: number;
  startedAtMs: number;
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

/**
 * Wrap already-plain lines in a NATIVE Telegram EXPANDABLE blockquote — rendered
 * collapsed with a tap-to-expand control (the "read more" the activity feed needs).
 *
 * HTML parse_mode, NOT MarkdownV2: `<blockquote expandable>` is ONE unambiguous
 * tag, whereas the MarkdownV2 form is a fragile line-prefix construct (`**>` opener,
 * `>` per line, a terminator that is easy to get wrong) layered on top of an 18-char
 * reserved set — a `>` or `.` inside a tool detail is enough to break the block or
 * 400 the whole message. HTML's escape surface is just `& < >`. parse_mode is
 * per-message, so only these activity messages are HTML; the permission/question
 * prompts stay MarkdownV2 and are untouched.
 */
export function expandableQuote(lines: string[]): string {
  const body = lines.map((l) => escapeHtml(l)).join("\n");
  return `<blockquote expandable>${body}</blockquote>`;
}

/** One-liner shown OUTSIDE the collapsed block: "🔧 4 tool calls · 12s". */
export function activitySummary(toolCount: number, startedAtMs: number, nowMs: number): string {
  const secs = Math.max(0, Math.round((nowMs - startedAtMs) / 1000));
  return `🔧 ${toolCount} tool call${toolCount === 1 ? "" : "s"} · ${secs}s`;
}

/**
 * The in-flight "Working…" message (HTML). With collapsing ON (default) the tool
 * one-liners live inside an expandable blockquote behind a visible summary line;
 * with it OFF the legacy flat list is rendered.
 */
export function renderWorking(
  st: Pick<WorkingState, "lines" | "toolCount" | "startedAtMs">,
  nowMs: number = Date.now(),
): string {
  const head = "⏳ <b>Working…</b>";
  if (st.lines.length === 0) return head;
  if (!config.telegram.collapseActivity) {
    return head + "\n\n" + st.lines.map((l) => escapeHtml(l)).join("\n");
  }
  const summary = escapeHtml(activitySummary(st.toolCount, st.startedAtMs, nowMs));
  return head + " — " + summary + "\n\n" + expandableQuote(st.lines);
}

/**
 * The FINAL turn message (HTML): the assistant's answer stays OUTSIDE the
 * blockquote, fully visible; the turn's activity is appended collapsed underneath.
 * Drops the collapsed tail when the combined text would blow Telegram's 4096-char
 * cap — a blockquote must NEVER be split across messages (the tag would break).
 * The cap is measured on the ESCAPED string, which is what Telegram counts.
 */
export function renderFinal(
  text: string,
  st: Pick<WorkingState, "lines" | "toolCount" | "startedAtMs"> | undefined,
  nowMs: number = Date.now(),
): string {
  const answer = escapeHtml(text);
  if (!st || !config.telegram.collapseActivity || st.lines.length === 0) return answer;
  const tail =
    "\n\n" + escapeHtml(activitySummary(st.toolCount, st.startedAtMs, nowMs)) + "\n" + expandableQuote(st.lines);
  if (answer.length + tail.length > MAX_TG_LEN) return answer;
  return answer + tail;
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

// ── Shared rendering primitives (source-agnostic) ───────────────────────────

/** Append a collapsed tool one-liner to the per-(chat,session) working msg. */
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
          const startedAtMs = Date.now();
          const seed = { lines: [line], toolCount: 1, startedAtMs };
          const sent = await sendMessageHtml(chatId as number | string, renderWorking(seed), keyboard);
          const messageId = sent?.message_id ?? 0;
          if (!messageId) return;
          rememberStoppable(sessionId, u.id, { chatId, messageId });
          const typingTimer = setInterval(() => {
            void sendChatAction(chatId as number | string, "typing");
          }, TYPING_REFRESH_MS);
          st = { messageId, ...seed, typingTimer, lastEditAt: Date.now() };
          workingByKey.set(key, st);
          return;
        }
        st.lines.push(line);
        st.toolCount += 1;
        if (st.lines.length > MAX_TOOL_LINES) st.lines = st.lines.slice(-MAX_TOOL_LINES);
        const sinceEdit = Date.now() - st.lastEditAt;
        if (sinceEdit >= EDIT_THROTTLE_MS) {
          st.lastEditAt = Date.now();
          await editMessageTextHtml(chatId as number | string, st.messageId, renderWorking(st), keyboard);
        }
      } catch (err: any) {
        console.warn(
          `[telegram-bridge] tool_use edit failed chat=${chatKey(chatId)} session=${sessionId}: ${err?.message ?? err}`,
        );
      }
    });
  }
}

/** Forward / finalize the working msg with the final assistant text. */
async function onAssistantText(sessionId: string, text: string): Promise<void> {
  let users: Array<{ id: string; telegram_chat_id: string | number }>;
  try {
    users = await getUsersWithTelegramDefaultSession(sessionId);
  } catch (err: any) {
    console.warn(`[telegram-bridge] DAL lookup failed session=${sessionId}: ${err?.message ?? err}`);
    return;
  }
  if (users.length === 0) return;

  for (const u of users) {
    const chatId = u.telegram_chat_id;
    if (chatId === null || chatId === undefined) continue;
    const key = workKey(chatId, sessionId);
    void enqueueForChat(chatId, async () => {
      const st = workingByKey.get(key);
      // Answer OUTSIDE the blockquote; the turn's activity collapsed underneath.
      const finalHtml = renderFinal(text, st);
      try {
        if (st) {
          stopTyping(st);
          workingByKey.delete(key);
          forgetStoppable(sessionId);
          if (finalHtml.length <= MAX_TG_LEN) {
            await editMessageTextHtml(chatId as number | string, st.messageId, finalHtml);
            return;
          }
          // Too long to edit in place — sendMessageHtml chunks it via
          // splitHtmlForTelegram (entity-safe). renderFinal has already dropped the
          // blockquote tail at this size, so no tag is ever split.
          await sendMessageHtml(chatId as number | string, finalHtml);
          return;
        }
        await sendMessageHtml(chatId as number | string, finalHtml);
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

/** Surface a permission prompt inline (Approve/Deny) to the session's TG users. */
async function onPermissionPrompt(
  sessionId: string,
  requestId: string,
  toolName: string,
  toolInput: unknown,
): Promise<void> {
  let users: Array<{ id: string; telegram_chat_id: string | number }>;
  try {
    users = await getUsersWithTelegramDefaultSession(sessionId);
  } catch (err: any) {
    console.warn(`[telegram-bridge] permission DAL lookup failed session=${sessionId}: ${err?.message ?? err}`);
    return;
  }
  if (users.length === 0) return;

  const preview = previewToolInput(toolInput);
  const text =
    `🔐 Approval needed — *${escapeMarkdownV2(toolName)}*` +
    (preview ? "\n\n```\n" + escapeMarkdownV2(preview) + "\n```" : "") +
    `\n\nApprove this action?`;
  const keyboard = [[
    { text: "✅ Approve", callback_data: permissionCallbackData(requestId, "approve") },
    { text: "🚫 Deny", callback_data: permissionCallbackData(requestId, "deny") },
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
          if (mdErr?.status === 400) {
            sent = await sendMessageWithKeyboard(chatId as number | string, text, keyboard);
          } else {
            throw mdErr;
          }
        }
        rememberPendingPrompt(sessionId, requestId, {
          sessionId,
          userId: u.id,
          chatId,
          messageId: sent?.message_id ?? 0,
          toolName,
          createdAtMs: Date.now(),
        });
      } catch (err: any) {
        console.warn(
          `[telegram-bridge] permission prompt send failed chat=${chatKey(chatId)} session=${sessionId}: ${err?.message ?? err}`,
        );
      }
    });
  }
}

// ── flag-OFF (PROD) source: stream-json event bus ───────────────────────────

function onFinal(e: AssistantMessageFinalEvent): void {
  void onAssistantText(e.sessionId, e.text);
}

function onActivity(e: SessionActivityEvent): void {
  if (e.kind !== "tool_use") return;
  void onToolUse(e.sessionId, e.toolName, e.detail);
}

function onPermissionPendingEvent(e: PermissionPendingEvent): void {
  void onPermissionPrompt(e.sessionId, e.requestId, e.toolName, e.toolInput);
}

// ── flag-ON (POST-CUTOVER) source: per-session transcript tail ──────────────

/** The bridge's own transcript consumer — output entries only. Permission
 *  detection (plan 03) + turn-lock release (plan 04) attach their own consumers
 *  to the same source via the manager. */
function bridgeConsumer(entry: TranscriptEntry): void {
  switch (entry.kind) {
    case "assistant_text":
      void onAssistantText(entry.sessionId, entry.text);
      break;
    case "tool_use":
      void onToolUse(entry.sessionId, entry.toolName, entry.detail);
      break;
    case "turn_complete":
      onTurnComplete(entry.sessionId);
      break;
    // permission_request / user_question — handled by the permission surfacing
    // consumer (plan 03), NOT here.
    default:
      break;
  }
}

/**
 * Ensure a transcript source is open for `sessionId` (flag-ON path only).
 * Idempotent per session. Called from the inbound dispatch path when a Telegram
 * user sends to a session. No-op when the bridge isn't started OR when running
 * the flag-OFF event-bus source (the bus is global, not per-session).
 */
export async function ensureSessionSubscribed(sessionId: string): Promise<void> {
  if (!started) return;
  // flag OFF: outbound comes from the global event bus — nothing to open here.
  if (!config.telegramTranscriptTail) return;
  if (sessionUnsubs.has(sessionId)) return;
  const unsub = await subscribeToSessionTranscript(sessionId, bridgeConsumer);
  if (!unsub) return; // no session row / unresolvable
  if (sessionUnsubs.has(sessionId)) {
    unsub();
    return;
  }
  sessionUnsubs.set(sessionId, unsub);
  // Plan 03: fail-closed permission surfacing on the SAME source.
  await startPermissionSurfacing(sessionId);
}

/** Release a session's transcript subscription (flag-ON path; e.g. idle teardown). */
export function releaseSessionSubscription(sessionId: string): void {
  const unsub = sessionUnsubs.get(sessionId);
  if (unsub) {
    unsub();
    sessionUnsubs.delete(sessionId);
  }
  stopPermissionSurfacing(sessionId);
}

/**
 * A runner raised a multiple-choice question (AskUserQuestion / elicitation).
 * Surface it inline with ONE BUTTON PER OPTION to every user whose Telegram
 * default session is the emitting session, and record each option button so the
 * webhook callback can resolve the chosen label.
 *
 * Multi-select (v1): rendered identically; each tap answers with that single
 * option's label. The web client retains true multi-select.
 *
 * Free-form questions (no options): we still surface the question text so the
 * user isn't left hanging, with a hint to reply in chat. (A plain reply flows
 * through the normal dispatch path; bridging it to question_response is out of
 * scope for v1 — noted for follow-up.)
 */
async function onQuestionPendingEvent(e: QuestionPendingEvent): Promise<void> {
  let users: Array<{ id: string; telegram_chat_id: string | number }>;
  try {
    users = await getUsersWithTelegramDefaultSession(e.sessionId);
  } catch (err: any) {
    console.warn(`[telegram-bridge] question DAL lookup failed session=${e.sessionId}: ${err?.message ?? err}`);
    return;
  }
  if (users.length === 0) return;

  const hint = e.isMultiSelect ? "\n\n_Pick one option \\(tap a button\\):_" : "";
  const headMd =
    `❓ *Question* — ` +
    escapeMarkdownV2(e.question.length > 600 ? e.question.slice(0, 599) + "…" : e.question) +
    hint;

  for (const u of users) {
    const chatId = u.telegram_chat_id;
    if (chatId === null || chatId === undefined) continue;
    void enqueueForChat(chatId, async () => {
      try {
        // Mint one token per (user, option) and build a one-button-per-row keyboard.
        // The callback's own `cb.message` carries chat/message_id for the edit, so
        // the token doesn't need a (yet-unknown) prompt message_id — we store 0.
        const keyboard: InlineKeyboard = [];
        for (const opt of e.options) {
          const token = rememberQuestionOption({
            sessionId: e.sessionId,
            requestId: e.requestId,
            userId: u.id,
            chatId,
            messageId: 0,
            label: opt.label,
            question: e.question,
          });
          const btnText = opt.label.length > 60 ? opt.label.slice(0, 59) + "…" : opt.label;
          keyboard.push([{ text: btnText, callback_data: questionCallbackData(token) }]);
        }

        if (keyboard.length > 0) {
          try {
            await sendMessageWithKeyboard(chatId as number | string, headMd, keyboard, {
              parse_mode: "MarkdownV2",
            });
          } catch (mdErr: any) {
            if (mdErr?.status === 400) {
              await sendMessageWithKeyboard(chatId as number | string, headMd, keyboard);
            } else {
              throw mdErr;
            }
          }
        } else {
          // No options — surface as a plain message (no buttons to resolve).
          await sendMessageMd(chatId as number | string, headMd);
        }
      } catch (err: any) {
        console.warn(
          `[telegram-bridge] question prompt send failed chat=${chatKey(chatId)} session=${e.sessionId}: ${err?.message ?? err}`,
        );
      }
    });
  }
}

/**
 * Boot the bridge. Idempotent. No-op when `TELEGRAM_BOT_TOKEN` is unset.
 * Chooses the outbound source by `config.telegramTranscriptTail` (see file header).
 */
export function startTelegramBridge(): void {
  if (started) return;
  if (!config.telegram.botToken) return;
  started = true;

  if (config.telegramTranscriptTail) {
    // POST-CUTOVER: transcript-tail source. Per-session subscriptions are opened
    // lazily by ensureSessionSubscribed() on inbound dispatch — nothing global
    // to wire here.
    console.log("[telegram-bridge] transcript-tail outbound bridge started (REMO_PTY_INTERACTIVE=1)");
  } else {
    // PROD DEFAULT: stream-json event-bus source (host-agnostic). Restores the
    // origin/main outbound behavior — works in the split hub/supervisor topology
    // where the hub has no local CLI transcript files.
    unsubscribeFinal = onAssistantMessageFinal(onFinal);
    unsubscribePermission = onPermissionPending(onPermissionPendingEvent);
    // Multiple-choice questions (AskUserQuestion) ride the same stream-json
    // event-bus path — `user_question:pending` is emitted by ws/agent.ts only on
    // this path, so the inline-question surfacing is wired here (not in the
    // transcript-tail branch, where questions arrive as PTY keystroke prompts).
    unsubscribeQuestion = onQuestionPending(onQuestionPendingEvent);
    unsubscribeActivity = onSessionActivity(onActivity);
    console.log("[telegram-bridge] stream-json (assistant_message:final) outbound bridge started");
  }

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
}

/** Test-only — stop the bridge and clear queues + subscriptions. */
export function _stopTelegramBridgeForTests(): void {
  if (unsubscribeFinal) {
    unsubscribeFinal();
    unsubscribeFinal = null;
  }
  if (unsubscribePermission) {
    unsubscribePermission();
    unsubscribePermission = null;
  }
  if (unsubscribeQuestion) {
    unsubscribeQuestion();
    unsubscribeQuestion = null;
  }
  if (unsubscribeActivity) {
    unsubscribeActivity();
    unsubscribeActivity = null;
  }
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
