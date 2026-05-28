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
  editMessageReplyMarkup,
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
  HELP_TEXT,
} from "../telegram/commands.ts";
import {
  buildSessionKeyboard,
  renderPickerText,
  parseCallbackData,
  snapOffsetToPage,
} from "../telegram/session-picker.ts";
import { dispatchToSession } from "../telegram/dispatch.ts";

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

/** Inbound text / attachment dispatch path (linked chat, non-command). */
async function dispatchInbound(
  user: TelegramUserRow,
  msg: MessageT,
  updateId: number,
): Promise<{ outcome: string; error?: string }> {
  const chatId = msg.chat.id;

  if (!user.telegram_default_session_id) {
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
    sessionId: user.telegram_default_session_id,
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
      await safeSend(chatId, "Your supervisor is offline. Reconnect it and try again.");
      return { outcome: "agent_offline" };
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
  } catch (err: any) {
    console.warn("[telegram-webhook] editMessageText failed:", err?.status ?? "?", err?.message);
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

  const action = parseCallbackData(cb.data);
  if (!action) {
    await safeAnswerCallback(cb.id, { text: "Unknown action", show_alert: false });
    return { outcome: "callback_unknown" };
  }

  const chatId = cb.message?.chat.id;
  const messageId = cb.message?.message_id;

  if (action.kind === "set_session") {
    // Authorization: user must own the session.
    const owned = await getSession(action.sessionId, user.id);
    if (!owned) {
      await safeAnswerCallback(cb.id, { text: "Not allowed", show_alert: true });
      return { outcome: "callback_session_denied" };
    }
    await setTelegramDefaultSession(user.id, action.sessionId);
    await safeAnswerCallback(cb.id, { text: "✓ Default session set" });

    // Re-render the keyboard with the new ✓ mark, if we have a message ref.
    if (chatId !== undefined && messageId !== undefined) {
      try {
        const rows = await listUserSessionsForPicker(user.id);
        const total = rows.length;
        // Keep the same page the user was on — find the offset that contains
        // the picked session, fall back to 0.
        const idx = rows.findIndex((r) => r.id === action.sessionId);
        const offset = idx >= 0 ? Math.floor(idx / 20) * 20 : 0;
        const keyboard = buildSessionKeyboard({ rows, offset, defaultId: action.sessionId });
        const text = renderPickerText({ total, offset, defaultId: action.sessionId });
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
        await safeSend(chatId, r.reply);
        return c.json({ ok: true, outcome: r.linkedUserId ? "link_ok" : "link_failed" });
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

    const r = await dispatchInbound(user, msg, update.update_id);
    return c.json({ ok: true, outcome: r.outcome, ...(r.error ? { error: r.error } : {}) });
  } catch (err: any) {
    console.error("[telegram-webhook] pipeline error:", err?.message, err?.stack);
    return c.json({ ok: true, outcome: "pipeline_error" });
  }
});
