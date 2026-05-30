/**
 * Phase 12 — Telegram inbound webhook.
 *
 * Public route mounted OUTSIDE the JWT catch-all (mirrors the Coolify webhook
 * discipline from Phase 06). The URL-path `:secret` IS the credential —
 * constant-time compared against `config.telegram.webhookSecret`. Raw body
 * is read BEFORE any JSON parse.
 *
 * Flow:
 *   1. Feature gate: 503 when token/secret unset (Telegram retries until we
 *      enable, but the user clearly hasn't pointed BotFather at us yet, so
 *      503 is honest).
 *   2. Constant-time `:secret` compare. Mismatch → 401, NO body, no DB write
 *      (avoids table-fill DoS).
 *   3. Zod-validate the `Update` envelope (minimal subset).
 *   4. Resolve user by `chat.id`. Two branches:
 *        a. UNLINKED + text starts with `/start ` → consume link code, bind.
 *        b. UNLINKED + anything else → audit `silent_drop_unlinked` + 200.
 *        c. LINKED + command → run command handler.
 *        d. LINKED + plain text / photo / document → `dispatchToSession`.
 *   5. Every authenticated hit appends one audit row. `(chat_id, update_id)`
 *      UNIQUE short-circuits Telegram retries — when the insert returns
 *      `inserted: false` we know this update was already processed, so we
 *      skip the dispatch (still return 200).
 *
 * Error discipline: any thrown error inside the post-auth pipeline is
 * caught, logged, and reported as 200 to Telegram — Telegram retries on
 * non-2xx for up to 24h, which would amplify a transient hub bug into
 * dispatch duplicates. The cost of a swallowed error is a missed message;
 * the cost of a 5xx is unbounded retries.
 */
import { Hono } from "hono";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { config } from "../config.ts";
import {
  getUserByTelegramChatId,
  getSession,
  logTelegramInbound,
  setTelegramDefaultSession,
  type TelegramUserRow,
} from "../db/dal.ts";
import {
  sendMessage,
  sendMessageWithKeyboard,
  answerCallbackQuery,
  editMessageText,
  editMessageTextMd,
  editMessageReplyMarkup,
  escapeMarkdownV2,
  getFile,
  downloadFile,
  type InlineKeyboard,
} from "../telegram/client.ts";
import {
  parseCommand,
  handleStart,
  handleList,
  handleListPicker,
  handleSession,
  listUserSessionsForPicker,
  prewarmAfterLink,
  HELP_TEXT,
  ORCHESTRATOR_SENTINEL_ID,
} from "../telegram/commands.ts";
import {
  buildSessionKeyboard,
  renderPickerText,
  parseCallbackData,
  snapOffsetToPage,
  PAGE_SIZE,
} from "../telegram/session-picker.ts";
import {
  parsePermissionCallback,
  takePendingPrompt,
} from "../telegram/approvals.ts";
import { parseStopCallback, takeStoppable, requestStop } from "../telegram/stop.ts";
import { getChannel } from "../ws/registry.ts";
import { log } from "../observability/logger.ts";
import { dispatchToSession } from "../telegram/dispatch.ts";
import { runDoctor, bufferReplay, hasBufferedReplay } from "../telegram/doctor.ts";
import { runStatus } from "../telegram/status.ts";

export const telegramWebhookRoutes = new Hono();

// ── Zod schema for inbound Update envelope ─────────────────────────────────

const PhotoSize = z.object({
  file_id: z.string(),
  file_unique_id: z.string().optional(),
  width: z.number(),
  height: z.number(),
  file_size: z.number().optional(),
});

const Document = z.object({
  file_id: z.string(),
  file_name: z.string().optional(),
  mime_type: z.string().optional(),
  file_size: z.number().optional(),
});

const Message = z.object({
  message_id: z.number(),
  date: z.number(),
  chat: z.object({ id: z.number() }),
  from: z.object({ id: z.number() }).optional(),
  text: z.string().optional(),
  caption: z.string().optional(),
  photo: z.array(PhotoSize).optional(),
  document: Document.optional(),
  voice: z.unknown().optional(),
  video: z.unknown().optional(),
  video_note: z.unknown().optional(),
  sticker: z.unknown().optional(),
  animation: z.unknown().optional(),
});

const CallbackQuery = z.object({
  id: z.string(),
  from: z.object({ id: z.number() }),
  // message is optional in Telegram's schema when the original message is too old.
  message: z
    .object({
      message_id: z.number(),
      chat: z.object({ id: z.number() }),
    })
    .optional(),
  data: z.string().optional(),
});

const Update = z.object({
  update_id: z.number(),
  message: Message.optional(),
  callback_query: CallbackQuery.optional(),
  // We intentionally ignore edited_message, channel_post, etc. (out of scope per plan).
  edited_message: z.unknown().optional(),
});

type UpdateT = z.infer<typeof Update>;
type MessageT = z.infer<typeof Message>;
type CallbackQueryT = z.infer<typeof CallbackQuery>;

// ── Helpers ────────────────────────────────────────────────────────────────

const MAX_PHOTO_BYTES = 10 * 1024 * 1024; // matches hub-wide WS limit

function constantTimeEqualStr(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

/** Best-effort send; never throws upstream. Bot token is never logged. */
async function safeSend(chatId: number | string, text: string): Promise<void> {
  try {
    await sendMessage(chatId, text);
  } catch (err: any) {
    console.warn("[telegram-webhook] sendMessage failed:", err?.status ?? "?", err?.message);
  }
}

/**
 * Pick the largest PhotoSize entry by area. Telegram sends a list of size
 * variants for each photo; largest is the one we want.
 */
function pickLargestPhoto(photos: z.infer<typeof PhotoSize>[]): z.infer<typeof PhotoSize> {
  // Contract: callers gate on `msg.photo.length > 0` before calling. Assert it
  // explicitly instead of hiding the precondition behind a non-null assertion.
  if (photos.length === 0) throw new Error("pickLargestPhoto: empty photo list");
  let best = photos[0]!;
  let bestArea = best.width * best.height;
  for (const p of photos.slice(1)) {
    const a = p.width * p.height;
    if (a > bestArea) {
      best = p;
      bestArea = a;
    }
  }
  return best;
}

/** Fetch a Telegram photo → base64 data URI, or return null on any failure. */
async function fetchPhotoAsDataUri(fileId: string): Promise<string | null> {
  try {
    const meta = await getFile(fileId);
    if (typeof meta.file_size === "number" && meta.file_size > MAX_PHOTO_BYTES) {
      return null;
    }
    const buf = await downloadFile(meta.file_path);
    if (buf.byteLength > MAX_PHOTO_BYTES) return null;
    const ext = meta.file_path.split(".").pop()?.toLowerCase() ?? "jpg";
    const mime =
      ext === "png" ? "image/png"
      : ext === "gif" ? "image/gif"
      : ext === "webp" ? "image/webp"
      : "image/jpeg";
    const b64 = Buffer.from(buf).toString("base64");
    return `data:${mime};base64,${b64}`;
  } catch (err: any) {
    console.warn("[telegram-webhook] photo fetch failed:", err?.message);
    return null;
  }
}

/**
 * orchestrator-autolaunch: resolve the user's open orchestrator session id, but
 * only when the feature is enabled and not explicitly disabled. Used as the
 * Telegram default-target FALLBACK when `telegram_default_session_id` is unset.
 * Returns null when the orchestrator is off or no session row exists yet
 * (auto-launch on supervisor.hello / inbound autoheal will create it).
 */
async function resolveOrchestratorTarget(userId: string): Promise<string | null> {
  try {
    const { getOrchestratorState, findOpenOrchestratorSession } = await import("../db/orchestrator-dal.ts");
    const prefs = await getOrchestratorState(userId);
    if (!prefs.orchestrator_enabled || prefs.orchestrator_disabled_explicitly) return null;
    const row = await findOpenOrchestratorSession(userId);
    return row?.id ?? null;
  } catch {
    return null;
  }
}

/**
 * Map a `launchOrchestrator` failure reason to a user-facing reply. Keeps the
 * "no online supervisor" copy ONLY for the supervisor-related reasons — a
 * cost/concurrency cap (`at_capacity`) must not be mis-reported as a supervisor
 * problem (H-1).
 */
function orchestratorLaunchFailureReply(reason: string | null): string {
  switch (reason) {
    case "at_capacity":
      return "Can't start the orchestrator right now — daily limit reached or too many sessions running. Try again later.";
    case "no_online_supervisor":
      return "Could not start the orchestrator — no online supervisor. Open the Remo Code desktop app and try again.";
    case "supervisor_has_no_roots":
      return "Could not start the orchestrator — your supervisor has no repo roots configured. Add one in the desktop app settings.";
    case "disabled":
      return "The orchestrator is disabled. Enable it in Settings → Connections on remo-code.";
    case "send_failed":
      return "Could not reach your supervisor to start the orchestrator. Try again in a moment.";
    default:
      return "Could not start the orchestrator. Try again in a moment.";
  }
}

/** Inbound text / attachment dispatch path (linked chat, non-command). */
async function dispatchInbound(
  user: TelegramUserRow,
  msg: MessageT,
  updateId: number,
): Promise<{ outcome: string; error?: string; replayText?: string; replayImages?: string[] }> {
  const chatId = msg.chat.id;

  // Resolve the effective target. Rules (orchestrator-as-default, 2026-05-29):
  //
  //   1. EXPLICIT default (set via `/session` or a `/list` button tap) that is
  //      still live → HONORED. Never surprise-switched to the orchestrator.
  //   2. NON-explicit default (an auto-pin from a prior fallback / prewarm) OR
  //      no default at all → the root orchestrator is PREFERRED, when enabled +
  //      open. This makes a fresh link / no-choice user land in the orchestrator.
  //   3. An explicit default pointing at a now-deleted session is dropped and
  //      treated as no-choice → falls through to the orchestrator.
  //
  // On a fallback to the orchestrator we lazy-pin its id with explicit=false so
  // the OUTBOUND bridge (which matches on `telegram_default_session_id`)
  // forwards the reply, WITHOUT promoting the pin to an explicit choice.
  let targetSessionId = user.telegram_default_session_id;
  let defaultIsExplicit = user.telegram_default_explicit === true;

  // Self-healing pin: if the default points at a now-deleted session, drop it
  // (and its explicit flag) so we fall back to the orchestrator below.
  if (targetSessionId) {
    const live = await getSession(targetSessionId, user.id).catch(() => null);
    if (!live) {
      targetSessionId = null;
      defaultIsExplicit = false;
      user.telegram_default_session_id = null;
      user.telegram_default_explicit = false;
    }
  }

  // Prefer the orchestrator UNLESS the user has an explicit, live choice.
  if (!targetSessionId || !defaultIsExplicit) {
    const orch = await resolveOrchestratorTarget(user.id);
    if (orch) {
      targetSessionId = orch;
      // Lazy-pin as NON-explicit so a later explicit `/session` repo choice
      // still wins, and the user is never silently promoted off the orchestrator.
      // Skip the write when the pin is ALREADY orchestrator + non-explicit
      // (IN-07) — otherwise every inbound message from an orchestrator user
      // re-writes the same row.
      const alreadyPinned =
        user.telegram_default_session_id === orch && user.telegram_default_explicit !== true;
      if (!alreadyPinned) {
        try {
          await setTelegramDefaultSession(user.id, orch, false);
          user.telegram_default_session_id = orch; // keep the in-memory row coherent
          user.telegram_default_explicit = false;
        } catch {
          /* swallow — dispatch still proceeds against the resolved id */
        }
      }
    }
  }
  if (!targetSessionId) {
    await safeSend(chatId, "No default session set. Use /list and /session <id> to pick one.");
    return { outcome: "no_session" };
  }

  // Build text + images.
  let text = msg.text ?? msg.caption ?? "";
  const images: string[] = [];

  if (msg.photo && msg.photo.length > 0) {
    const largest = pickLargestPhoto(msg.photo);
    const dataUri = await fetchPhotoAsDataUri(largest.file_id);
    if (dataUri) {
      images.push(dataUri);
    } else {
      await safeSend(chatId, "Could not download that photo (>10MB or fetch error). Try a smaller one.");
      return { outcome: "photo_rejected" };
    }
    if (!text) text = "(photo from telegram)";
  }

  if (msg.voice || msg.video || msg.video_note || msg.sticker || msg.animation) {
    await safeSend(chatId, "Unsupported attachment type. Send text, image, or a text file.");
    return { outcome: "unsupported_attachment" };
  }

  // Documents: text/* mime → embed as text; everything else → reject.
  if (msg.document) {
    const mime = msg.document.mime_type ?? "";
    if (!mime.startsWith("text/")) {
      await safeSend(chatId, "Unsupported attachment type. Send text, image, or a text file.");
      return { outcome: "unsupported_attachment" };
    }
    try {
      const meta = await getFile(msg.document.file_id);
      if (typeof meta.file_size === "number" && meta.file_size > MAX_PHOTO_BYTES) {
        await safeSend(chatId, "File too large (>10MB).");
        return { outcome: "document_rejected" };
      }
      const buf = await downloadFile(meta.file_path);
      const contents = new TextDecoder().decode(buf);
      const fname = msg.document.file_name ?? "attachment.txt";
      text = `${text ? text + "\n\n" : ""}--- ${fname} ---\n${contents}`;
    } catch (err: any) {
      await safeSend(chatId, "Could not fetch that file.");
      return { outcome: "document_rejected", error: err?.message };
    }
  }

  if (!text && images.length === 0) {
    await safeSend(chatId, "Empty message. Send text, an image, or a text file.");
    return { outcome: "empty" };
  }

  const result = await dispatchToSession({
    userId: user.id,
    sessionId: targetSessionId,
    chatId,
    updateId,
    text,
    images: images.length > 0 ? images : undefined,
  });

  switch (result.kind) {
    case "dispatched":
      return { outcome: "dispatched" };
    case "no_session":
      await safeSend(chatId, "No default session set. Use /list and /session <id> to pick one.");
      return { outcome: "no_session" };
    case "cost_capped":
      await safeSend(chatId, `Daily cost cap reached. Resumes at ${result.resumesAtUtc}.`);
      return { outcome: "cost_capped" };
    case "session_busy":
      await safeSend(chatId, "Session busy — try again in a moment.");
      return { outcome: "session_busy" };
    case "agent_offline":
      // NOTE: no reply here — the caller fires autoheal (runDoctor) and the
      // opener "🩺 Hold on — diagnosing & launching automatically…" replaces
      // the legacy "Your supervisor is offline" pre-amble. The caller buffers
      // text + images for auto-replay using the values surfaced below.
      return {
        outcome: "agent_offline",
        replayText: text,
        replayImages: images.length > 0 ? images : undefined,
      };
    case "failed":
      await safeSend(chatId, "Something went wrong dispatching that message.");
      return { outcome: "failed", error: result.reason };
  }
}

// ── Callback-query handler (inline-keyboard session picker) ───────────────

async function safeAnswerCallback(
  id: string,
  opts: { text?: string; show_alert?: boolean } = {},
): Promise<void> {
  try {
    await answerCallbackQuery(id, opts);
  } catch (err: any) {
    console.warn("[telegram-webhook] answerCallbackQuery failed:", err?.status ?? "?", err?.message);
  }
}

async function safeEditMessageText(
  chatId: number | string,
  messageId: number,
  text: string,
  keyboard: InlineKeyboard | null,
): Promise<void> {
  try {
    await editMessageText(chatId, messageId, text, keyboard ? { inline_keyboard: keyboard } : {});
    return;
  } catch (err: any) {
    // Telegram returns 400 "message is not modified" when the new content is
    // byte-identical to the old. That's a no-op success for our flows
    // (paginating to the same page, re-rendering after no state change).
    const status = err?.status ?? 0;
    const body = String(err?.message ?? "");
    if (status === 400 && /not modified/i.test(body)) {
      return;
    }
    // Any other failure (e.g. a parse/encoding edge case, transient 400) MUST
    // NOT silently drop the page — the picker would appear frozen ("Next does
    // nothing"). Log it AND retry once as a plain re-send so the page renders.
    console.error("[telegram-webhook] editMessageText failed:", status || "?", body);
  }
  // Fallback: re-send the page as a NEW message so the user still sees it.
  // (editMessageText can fail when the original message is too old to edit, or
  // on a transient Telegram 400; a fresh sendMessage with the keyboard always
  // works.) Best-effort — never throws upstream.
  try {
    if (keyboard) {
      await sendMessageWithKeyboard(chatId, text, keyboard);
    } else {
      await sendMessage(chatId, text);
    }
  } catch (err: any) {
    console.error("[telegram-webhook] picker fallback re-send failed:", err?.status ?? "?", err?.message);
  }
}

async function safeEditReplyMarkup(
  chatId: number | string,
  messageId: number,
  keyboard: InlineKeyboard,
): Promise<void> {
  try {
    await editMessageReplyMarkup(chatId, messageId, keyboard);
  } catch (err: any) {
    console.warn("[telegram-webhook] editMessageReplyMarkup failed:", err?.status ?? "?", err?.message);
  }
}

/**
 * Resolve an inline permission prompt (Approve / Deny tap). Looks up the pending
 * prompt by request_id, enforces that it belongs to THIS user, forwards a
 * `permission_response` onto the session's agent socket, and edits the prompt
 * message to reflect the decision. answerCallbackQuery fires on every branch.
 */
async function handlePermissionCallback(
  cb: CallbackQueryT,
  user: TelegramUserRow,
  perm: { requestId: string; approved: boolean },
): Promise<{ outcome: string }> {
  // Authorization is enforced inside takePendingPrompt: it returns the entry only
  // if THIS user is an authorized approver for (requestId). A shared default
  // session that fanned the prompt to several users now resolves for whichever
  // authorized user taps first (no last-write-wins clobber).
  const pending = takePendingPrompt(perm.requestId, user.id);
  if (!pending) {
    // Already resolved, expired, unknown, or the tapping user isn't authorized.
    await safeAnswerCallback(cb.id, { text: "This prompt already expired or was answered.", show_alert: false });
    return { outcome: "callback_permission_stale" };
  }

  // Forward the decision to the agent socket (same frame the web client sends).
  const channel = getChannel(pending.sessionId);
  if (!channel) {
    await safeAnswerCallback(cb.id, { text: "Session is offline — couldn't deliver.", show_alert: true });
    return { outcome: "callback_permission_offline" };
  }
  try {
    channel.ws.send(
      JSON.stringify({
        type: "permission_response",
        session_id: pending.sessionId,
        request_id: perm.requestId,
        approved: perm.approved,
      }),
    );
    // Audit: tool-permission grant/deny applied + delivered to the supervisor.
    log.info("permission.grant_applied", {
      session_id: pending.sessionId,
      request_id: perm.requestId,
      tool: pending.toolName,
      approved: perm.approved,
      source: "telegram",
      user_id: user.id,
    });
  } catch (err: any) {
    console.warn("[telegram-webhook] permission_response send failed:", err?.message);
    await safeAnswerCallback(cb.id, { text: "Couldn't deliver the decision. Try again.", show_alert: true });
    return { outcome: "callback_permission_send_failed" };
  }

  await safeAnswerCallback(cb.id, { text: perm.approved ? "✅ Approved" : "🚫 Denied" });

  // Edit the prompt to reflect the decision + drop the buttons.
  const chatId = cb.message?.chat.id ?? pending.chatId;
  const messageId = cb.message?.message_id ?? pending.messageId;
  if (chatId !== undefined && messageId) {
    const verdict = perm.approved ? "✅ Approved" : "🚫 Denied";
    await safeEditMessageText(chatId, messageId, `${verdict} — ${pending.toolName}`, null);
  }
  return { outcome: perm.approved ? "callback_permission_approved" : "callback_permission_denied" };
}

/**
 * Resolve a 🛑 Stop inline-button tap. Two-layer fail-closed authz:
 *   1. `takeStoppable(sessionId, user.id)` — the tapping user must be one the
 *      working message was fanned to (server-side registry; take-once). The
 *      sessionId arrives on the callback wire only to LOCATE the entry.
 *   2. `requestStop` re-verifies the user OWNS the session before sending cancel.
 * Edits the working message to "⏹ Stopped." and answers the callback on every
 * branch. A second tap (already resolved) is a benign no-op.
 */
async function handleStopCallback(
  cb: CallbackQueryT,
  user: TelegramUserRow,
  stop: { sessionId: string },
): Promise<{ outcome: string }> {
  // Layer 1: registry membership (authz + take-once). Foreign/forged sessionId
  // or a second tap finds no entry → benign "already stopped".
  const ctx = takeStoppable(stop.sessionId, user.id);
  if (!ctx) {
    await safeAnswerCallback(cb.id, { text: "Already stopped or expired.", show_alert: false });
    return { outcome: "callback_stop_stale" };
  }

  // Layer 2: ownership-checked cancel via the shared helper.
  const result = await requestStop({ sessionId: stop.sessionId, userId: user.id });

  const chatId = cb.message?.chat.id ?? ctx.chatId;
  const messageId = cb.message?.message_id ?? ctx.messageId;

  if (result === "stopped") {
    await safeAnswerCallback(cb.id, { text: "⏹ Stopped" });
    if (chatId !== undefined && messageId) {
      try {
        await editMessageTextMd(chatId, messageId as number, escapeMarkdownV2("⏹ Stopped."));
      } catch (err: any) {
        console.warn("[telegram-webhook] stop edit failed:", err?.status ?? "?", err?.message);
      }
    }
    return { outcome: "callback_stop_ok" };
  }
  if (result === "offline") {
    await safeAnswerCallback(cb.id, { text: "Session is offline — nothing to stop.", show_alert: true });
    return { outcome: "callback_stop_offline" };
  }
  if (result === "not_authorized") {
    await safeAnswerCallback(cb.id, { text: "Not allowed", show_alert: true });
    return { outcome: "callback_stop_denied" };
  }
  await safeAnswerCallback(cb.id, { text: "Couldn't deliver the stop. Try again.", show_alert: true });
  return { outcome: "callback_stop_send_failed" };
}

/**
 * `/stop` command — halt the running turn for the user's effective default
 * session (explicit/auto default if live, else the open orchestrator). Reuses
 * the SAME ownership-checked `requestStop` helper as the inline button.
 */
async function handleStopCommand(
  user: TelegramUserRow,
  chatId: number | string,
): Promise<{ outcome: string }> {
  // Resolve the target session: a live default, else the orchestrator fallback.
  let target = user.telegram_default_session_id;
  if (target) {
    const live = await getSession(target, user.id).catch(() => null);
    if (!live) target = null;
  }
  if (!target) target = await resolveOrchestratorTarget(user.id);
  if (!target) {
    await safeSend(chatId, "No active session.");
    return { outcome: "cmd_stop_no_session" };
  }

  const result = await requestStop({ sessionId: target, userId: user.id });
  const short = target.slice(0, 8);
  switch (result) {
    case "stopped":
      await safeSend(chatId, `⏹ Stopped ${short}`);
      return { outcome: "cmd_stop_ok" };
    case "offline":
      await safeSend(chatId, "No active session.");
      return { outcome: "cmd_stop_offline" };
    case "not_authorized":
      // Ownership lost between resolve + stop (deleted/transferred). Treat as none.
      await safeSend(chatId, "No active session.");
      return { outcome: "cmd_stop_denied" };
    default:
      await safeSend(chatId, "Couldn't deliver the stop. Try again.");
      return { outcome: "cmd_stop_send_failed" };
  }
}

/**
 * Handle a callback_query payload (inline-keyboard button tap).
 * Returns an audit outcome string. Authorization is enforced on every branch:
 * unlinked chat → silent drop, foreign session_id → denial toast.
 */
async function handleCallbackQuery(
  cb: CallbackQueryT,
  user: TelegramUserRow | null,
): Promise<{ outcome: string }> {
  // Unlinked chat → silent drop (mirrors unlinked text path).
  if (!user) {
    await safeAnswerCallback(cb.id);
    return { outcome: "callback_silent_drop_unlinked" };
  }

  // ── Inline-approval branch (Approve/Deny on a permission prompt) ──────────
  const perm = parsePermissionCallback(cb.data);
  if (perm) {
    return await handlePermissionCallback(cb, user, perm);
  }

  // ── Stop branch (🛑 on a streaming "Working…" message) ────────────────────
  const stop = parseStopCallback(cb.data);
  if (stop) {
    return await handleStopCallback(cb, user, stop);
  }

  const action = parseCallbackData(cb.data);
  if (!action) {
    await safeAnswerCallback(cb.id, { text: "Unknown action", show_alert: false });
    return { outcome: "callback_unknown" };
  }

  const chatId = cb.message?.chat.id;
  const messageId = cb.message?.message_id;

  if (action.kind === "set_session") {
    // Synthetic orchestrator placeholder: the user tapped the root orchestrator
    // before any orchestrator session row exists. Launch it (which creates the
    // row + pins it explicitly) instead of a set-default against a fake id.
    if (action.sessionId === ORCHESTRATOR_SENTINEL_ID) {
      await safeAnswerCallback(cb.id, { text: "🧭 Starting orchestrator…" });
      try {
        const { launchOrchestrator } = await import("../orchestrator/auto-launch.ts");
        const res = await launchOrchestrator({ userId: user.id, requireEnabled: true, skipIfRunning: true });
        const sid =
          res.ok ? res.sessionId
          : res.reason === "already_running" ? res.sessionId
          : null;
        if (sid) {
          // Explicit choice — the user deliberately tapped the orchestrator.
          await setTelegramDefaultSession(user.id, sid, true);
          user.telegram_default_session_id = sid;
          user.telegram_default_explicit = true;
          if (chatId !== undefined) {
            await safeSend(chatId, "✓ Default set to 🧭 Orchestrator (root).");
          }
        } else {
          const reason = res.ok ? null : res.reason;
          // Supervisor-availability failures (offline / couldn't reach) are
          // NOT a hard "can't select" — the orchestrator is still what the user
          // wants. Clear any conflicting explicit pin so the NEXT message falls
          // through to dispatchInbound's orchestrator-preference path, which
          // fires autoheal and lazily launches it (matching the web client's
          // lazy-start). Selecting an offline root must never silently fail.
          const lazyStartable = reason === "no_online_supervisor" || reason === "send_failed";
          if (lazyStartable) {
            try {
              // null + non-explicit → orchestrator-preference wins on next msg.
              await setTelegramDefaultSession(user.id, null, false);
              user.telegram_default_session_id = null;
              user.telegram_default_explicit = false;
            } catch {
              /* swallow — next message still resolves the orchestrator */
            }
            if (chatId !== undefined) {
              await safeSend(
                chatId,
                "🧭 Orchestrator (root) selected. Your supervisor looks offline — send a message and I'll start it automatically.",
              );
            }
          } else if (chatId !== undefined) {
            // Genuine blocker (disabled / at_capacity) — reason-specific reply.
            await safeSend(chatId, orchestratorLaunchFailureReply(reason));
          }
        }
      } catch (err: any) {
        console.warn("[telegram-webhook] orchestrator launch from picker failed:", err?.message);
      }
      // Re-render so the ✓ moves to the orchestrator row.
      if (chatId !== undefined && messageId !== undefined) {
        try {
          const rows = await listUserSessionsForPicker(user.id);
          const total = rows.length;
          const defaultId = user.telegram_default_session_id;
          const keyboard = buildSessionKeyboard({ rows, offset: 0, defaultId });
          const text = renderPickerText({ total, offset: 0, defaultId, rows });
          await safeEditMessageText(chatId, messageId, text, keyboard);
        } catch (err: any) {
          console.warn("[telegram-webhook] picker re-render failed:", err?.message);
        }
      }
      return { outcome: "callback_orchestrator_launched" };
    }

    // Authorization: user must own the session.
    const owned = await getSession(action.sessionId, user.id);
    if (!owned) {
      await safeAnswerCallback(cb.id, { text: "Not allowed", show_alert: true });
      return { outcome: "callback_session_denied" };
    }
    // A button tap IS an explicit choice — sticks, never auto-overridden.
    // SAME write the `/session` command path uses (DAL setTelegramDefaultSession
    // with explicit=true). The session row may be OFFLINE (no live supervisor /
    // channel) — that's fine: dispatch lazily starts it on the next message,
    // matching the web client. We never require a running CLI to select.
    await setTelegramDefaultSession(user.id, action.sessionId, true);
    user.telegram_default_session_id = action.sessionId;
    user.telegram_default_explicit = true;
    await safeAnswerCallback(cb.id, { text: "✓ Default session set" });

    // Explicit, ALWAYS-visible confirmation (mirrors `/session`'s reply). The
    // keyboard re-render below is best-effort and can no-op (collapsed survivor,
    // too-old message, transient 400), which previously left the user unsure the
    // tap registered. A plain confirmation guarantees they see the switch took.
    if (chatId !== undefined) {
      const label =
        (owned as any).name ||
        (owned as any).project_dir?.split(/[\\/]/).filter(Boolean).pop() ||
        action.sessionId.slice(0, 8);
      const offlineHint = !getChannel(action.sessionId)
        ? " — it'll start on your next message"
        : "";
      await safeSend(chatId, `✓ Default session set to ${label} (${action.sessionId.slice(0, 8)})${offlineHint}.`);
    }

    // Re-render the keyboard with the new ✓ mark, if we have a message ref.
    if (chatId !== undefined && messageId !== undefined) {
      try {
        const rows = await listUserSessionsForPicker(user.id);
        const total = rows.length;
        // Keep the same page the user was on — find the offset that contains
        // the picked session, fall back to 0.
        const idx = rows.findIndex((r) => r.id === action.sessionId);
        const offset = idx >= 0 ? Math.floor(idx / PAGE_SIZE) * PAGE_SIZE : 0;
        const keyboard = buildSessionKeyboard({ rows, offset, defaultId: action.sessionId });
        const text = renderPickerText({ total, offset, defaultId: action.sessionId, rows });
        await safeEditMessageText(chatId, messageId, text, keyboard);
      } catch (err: any) {
        console.warn("[telegram-webhook] picker re-render failed:", err?.message);
      }
    }
    return { outcome: "callback_session_set" };
  }

  // paginate
  if (chatId === undefined || messageId === undefined) {
    await safeAnswerCallback(cb.id);
    return { outcome: "callback_paginate_no_msg" };
  }
  try {
    const rows = await listUserSessionsForPicker(user.id);
    const total = rows.length;
    const offset = snapOffsetToPage(action.offset, total);
    const keyboard = buildSessionKeyboard({
      rows,
      offset,
      defaultId: user.telegram_default_session_id,
    });
    const text = renderPickerText({
      total,
      offset,
      defaultId: user.telegram_default_session_id,
      rows,
    });
    await safeEditMessageText(chatId, messageId, text, keyboard);
  } catch (err: any) {
    console.warn("[telegram-webhook] paginate failed:", err?.message);
  }
  await safeAnswerCallback(cb.id);
  return { outcome: "callback_paginate" };
}

// ── Route ──────────────────────────────────────────────────────────────────

telegramWebhookRoutes.post("/webhook/:secret", async (c) => {
  // Read raw body BEFORE any parse work.
  const rawBody = await c.req.text();
  const secretParam = c.req.param("secret") ?? "";

  // (1) Feature gate.
  if (!config.telegram.botToken || !config.telegram.webhookSecret) {
    return c.json({ error: "telegram_disabled" }, 503);
  }

  // (2) Constant-time URL-secret compare. Mismatch → 401, NO body, NO DB write.
  if (!constantTimeEqualStr(secretParam, config.telegram.webhookSecret)) {
    return new Response(null, { status: 401 });
  }

  // (3) Validate envelope.
  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(rawBody);
  } catch {
    // Still 200 — Telegram won't recover from this by retrying.
    return c.json({ ok: true });
  }
  const result = Update.safeParse(parsedBody);
  if (!result.success) {
    return c.json({ ok: true });
  }
  const update: UpdateT = result.data;
  if (!update.message && !update.callback_query) {
    // edited_message, channel_post, etc. — ignored per plan.
    return c.json({ ok: true });
  }
  // chat_id source: callback_query uses cb.message.chat.id (or cb.from.id when
  // the original message is too old for Telegram to send back).
  const chatId =
    update.message?.chat.id ??
    update.callback_query?.message?.chat.id ??
    update.callback_query?.from.id ??
    0;
  const msg = update.message;

  // (4) Resolve user.
  let user: TelegramUserRow | null = null;
  try {
    user = await getUserByTelegramChatId(chatId);
  } catch (err: any) {
    console.warn("[telegram-webhook] user lookup failed:", err?.message);
  }

  // (5) Audit + dedupe. (chat_id, update_id) UNIQUE — duplicate insert
  // tells us this update was already processed; skip dispatch on dupes.
  // We do this BEFORE running command/dispatch logic so duplicate Telegram
  // retries are caught immediately.
  const ins = await logTelegramInbound({
    user_id: user?.id ?? null,
    chat_id: chatId,
    update_id: update.update_id,
    outcome: "received",
    raw: update,
  });
  if (!ins.inserted) {
    // Already processed this update — short-circuit silently.
    return c.json({ ok: true, deduped: true });
  }

  // Wrap the entire post-auth pipeline so transient errors never escape as 5xx.
  try {
    // ── CALLBACK QUERY branch (inline-keyboard tap) ─────────────────────────
    if (update.callback_query) {
      const r = await handleCallbackQuery(update.callback_query, user);
      return c.json({ ok: true, outcome: r.outcome });
    }

    if (!msg) {
      // Defensive — we already checked above, but TypeScript needs the narrowing.
      return c.json({ ok: true });
    }

    // ── UNLINKED branch ────────────────────────────────────────────────────
    if (!user) {
      const text = msg.text ?? "";
      const cmd = parseCommand(text);
      if (cmd.kind === "start") {
        const r = await handleStart({ code: cmd.arg, chatId });
        if (!r.linkedUserId) {
          await safeSend(chatId, r.reply);
          return c.json({ ok: true, outcome: "link_failed" });
        }
        // Pre-warm: pick most-recent session, set as default, fire session.start.
        // Best-effort; failure falls back to /doctor on first message.
        let prewarmed: { label: string } | null = null;
        try {
          const pw = await prewarmAfterLink({
            userId: r.linkedUserId,
            existingDefault: null,
          });
          if (pw.kind === "prewarmed") prewarmed = { label: pw.label };
        } catch (err: any) {
          console.warn("[telegram-webhook] prewarm failed:", err?.message);
        }
        // Re-derive email from the canned reply (handleStart already looked it up).
        // The reply is one of: "Linked to <email>. ..." | "Linked. ..." | error path.
        const linkedToMatch = r.reply.match(/^Linked to ([^\s.]+)\./);
        const emailPart = linkedToMatch ? linkedToMatch[1] : null;
        const reply = prewarmed
          ? emailPart
            ? `✅ Linked to ${emailPart}. Pre-launching '${prewarmed.label}' so your next message lands instantly…`
            : `✅ Linked. Pre-launching '${prewarmed.label}' so your next message lands instantly…`
          : emailPart
            ? `✅ Linked to ${emailPart}. Send /list to pick a session.`
            : "✅ Linked. Send /list to pick a session.";
        await safeSend(chatId, reply);
        return c.json({ ok: true, outcome: "link_ok", prewarmed: !!prewarmed });
      }
      // Anything else from an unlinked chat → silent drop (no reply).
      return c.json({ ok: true, outcome: "silent_drop_unlinked" });
    }

    // ── LINKED branch ──────────────────────────────────────────────────────
    const text = msg.text ?? msg.caption ?? "";
    const hasAttachment = !!(msg.photo || msg.document || msg.voice || msg.video || msg.sticker || msg.animation || msg.video_note);

    // Commands only when there's no attachment AND text begins with `/`.
    if (!hasAttachment && text.startsWith("/")) {
      const cmd = parseCommand(text);
      switch (cmd.kind) {
        case "help": {
          await safeSend(chatId, HELP_TEXT);
          return c.json({ ok: true, outcome: "cmd_help" });
        }
        case "list": {
          const r = await handleListPicker({ user, offset: 0 });
          if (r.keyboard) {
            try {
              await sendMessageWithKeyboard(chatId, r.text, r.keyboard);
            } catch (err: any) {
              console.warn("[telegram-webhook] sendMessageWithKeyboard failed:", err?.status ?? "?", err?.message);
              // Fall back to plain text list if the keyboard send blew up.
              const fb = await handleList({ user });
              await safeSend(chatId, fb.reply);
            }
          } else {
            await safeSend(chatId, r.text);
          }
          return c.json({ ok: true, outcome: "cmd_list" });
        }
        case "session": {
          const r = await handleSession({ user, arg: cmd.arg });
          await safeSend(chatId, r.reply);
          return c.json({ ok: true, outcome: "cmd_session" });
        }
        case "doctor": {
          const r = await runDoctor({ user, chatId });
          return c.json({ ok: true, outcome: r.outcome });
        }
        case "status": {
          const r = await runStatus({ user, chatId });
          return c.json({ ok: true, outcome: r.outcome });
        }
        case "stop": {
          const r = await handleStopCommand(user, chatId);
          return c.json({ ok: true, outcome: r.outcome });
        }
        case "start": {
          // Already linked — replies politely, no-op.
          await safeSend(chatId, "This chat is already linked. Use /unlink from Settings → Telegram on remo-code to detach.");
          return c.json({ ok: true, outcome: "already_linked" });
        }
        case "unknown": {
          await safeSend(chatId, "Unknown command. /help for list.");
          return c.json({ ok: true, outcome: "cmd_unknown" });
        }
        case "none":
          // Slash but no valid command body — fall through to dispatch.
          break;
      }
    }

    // Pre-check: if a buffered replay is already pending for this chat and the
    // user is just sending a second message before launch finishes, swap the
    // buffer to most-recent and tell them quickly. Skip dispatchInbound to
    // avoid re-firing autoheal.
    if (hasBufferedReplay(msg.chat.id) && user.telegram_default_session_id) {
      // Extract text + images cheaply enough — re-run the same resolution.
      const text = msg.text ?? msg.caption ?? "";
      const images: string[] = [];
      if (msg.photo && msg.photo.length > 0) {
        const largest = pickLargestPhoto(msg.photo);
        const dataUri = await fetchPhotoAsDataUri(largest.file_id);
        if (dataUri) images.push(dataUri);
      }
      if (text || images.length > 0) {
        bufferReplay(msg.chat.id, {
          text: text || "(photo from telegram)",
          images: images.length > 0 ? images : undefined,
          originalUpdateId: update.update_id,
        });
        await safeSend(msg.chat.id, "Queued — I'll send this one after the launch completes.");
        return c.json({ ok: true, outcome: "replay_buffered_queue_swap" });
      }
    }

    const r = await dispatchInbound(user, msg, update.update_id);
    // Auto-heal: on agent_offline, immediately walk the user through /doctor
    // and try to auto-launch the runner. The legacy "supervisor offline" reply
    // is suppressed — runDoctor's autoheal opener replaces it. The original
    // user message is buffered for auto-replay once the launch completes.
    if (r.outcome === "agent_offline") {
      if (r.replayText !== undefined || (r.replayImages && r.replayImages.length > 0)) {
        bufferReplay(msg.chat.id, {
          text: r.replayText ?? "",
          images: r.replayImages,
          originalUpdateId: update.update_id,
        });
      }
      try {
        const dr = await runDoctor({ user, chatId: msg.chat.id, autoheal: true });
        return c.json({ ok: true, outcome: "agent_offline_autoheal", doctor: dr.outcome });
      } catch (err: any) {
        console.warn("[telegram-webhook] autoheal runDoctor failed:", err?.message);
      }
    }
    return c.json({ ok: true, outcome: r.outcome, ...(r.error ? { error: r.error } : {}) });
  } catch (err: any) {
    console.error("[telegram-webhook] pipeline error:", err?.message, err?.stack);
    return c.json({ ok: true, outcome: "pipeline_error" });
  }
});
