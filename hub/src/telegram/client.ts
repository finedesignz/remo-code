/**
 * Phase 12 — Telegram Bot API client (hub-wide bot).
 *
 * Thin wrapper over `https://api.telegram.org/bot<TOKEN>/...`. Token is sourced
 * from `config.telegram.botToken`; helpers throw if the token is unset so
 * callers must gate on `config.telegram.botToken !== ""` before invoking.
 *
 * Responsibilities:
 *   - sendMessage with MarkdownV2 escape + 4096-char split.
 *   - getFile / downloadFile for inbound photo/document handling.
 *   - Never log the bot token. Errors carry status + body slice only.
 *
 * The legacy `hub/src/scheduler/post-run/telegram.ts` uses per-user tokens
 * from `user_integrations` and is intentionally NOT consolidated here this
 * wave (kept alive for one release per Phase 12 rollback plan).
 */
import { config } from "../config.ts";

const API_BASE = "https://api.telegram.org";
const MAX_MESSAGE_LEN = 4096;
const PREFER_BREAK_WINDOW = 200; // search last 200 chars for a nice boundary

export class TelegramClientError extends Error {
  constructor(public status: number, public bodyPreview: string) {
    super(`telegram api ${status}: ${bodyPreview.slice(0, 200)}`);
  }
}

function tokenOrThrow(): string {
  const t = config.telegram.botToken;
  if (!t) throw new Error("telegram client called without TELEGRAM_BOT_TOKEN");
  return t;
}

/**
 * Escape MarkdownV2 reserved characters per
 * https://core.telegram.org/bots/api#markdownv2-style.
 * Used on outbound Claude text to avoid Telegram returning 400 on unbalanced
 * markup — we don't try to preserve intentional Markdown structure.
 */
export function escapeMarkdownV2(text: string): string {
  // Reserved: _ * [ ] ( ) ~ ` > # + - = | { } . !
  return text.replace(/[_*\[\]()~`>#+\-=|{}.!\\]/g, (m) => "\\" + m);
}

/**
 * Split a long string into <=4096-char chunks. Prefer breaking on \n\n, then
 * \n, then space, within the last 200 chars of each candidate chunk. Falls
 * back to a hard split when no boundary exists. Multi-byte safe: works on
 * code units (Telegram counts UTF-16 code units; we conservatively count
 * JS string length which is the same).
 */
export function splitForTelegram(text: string, maxLen: number = MAX_MESSAGE_LEN): string[] {
  if (text.length <= maxLen) return text.length === 0 ? [] : [text];
  const out: string[] = [];
  let remaining = text;
  while (remaining.length > maxLen) {
    const window = remaining.slice(0, maxLen);
    const searchFrom = Math.max(0, maxLen - PREFER_BREAK_WINDOW);
    let cut = -1;
    // Prefer paragraph break, then newline, then space.
    const para = window.lastIndexOf("\n\n", maxLen);
    if (para >= searchFrom) cut = para + 2;
    if (cut < 0) {
      const nl = window.lastIndexOf("\n", maxLen);
      if (nl >= searchFrom) cut = nl + 1;
    }
    if (cut < 0) {
      const sp = window.lastIndexOf(" ", maxLen);
      if (sp >= searchFrom) cut = sp + 1;
    }
    if (cut < 0) cut = maxLen;
    out.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut);
  }
  if (remaining.length > 0) out.push(remaining);
  return out;
}

export interface SendMessageOptions {
  parse_mode?: "MarkdownV2";
  disable_web_page_preview?: boolean;
}

/** Telegram inline keyboard button. callback_data must be ≤64 bytes. */
export interface InlineKeyboardButton {
  text: string;
  callback_data?: string;
  url?: string;
}

/** A grid of inline buttons. Outer array = rows, inner array = buttons in row. */
export type InlineKeyboard = InlineKeyboardButton[][];

export async function sendMessage(
  chatId: number | string,
  text: string,
  opts: SendMessageOptions = {},
): Promise<void> {
  const token = tokenOrThrow();
  const url = `${API_BASE}/bot${token}/sendMessage`;
  const chunks = splitForTelegram(text);
  for (const chunk of chunks) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: chunk,
        ...(opts.parse_mode ? { parse_mode: opts.parse_mode } : {}),
        ...(opts.disable_web_page_preview ? { disable_web_page_preview: true } : {}),
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new TelegramClientError(res.status, body);
    }
  }
}

/**
 * Send a message with an inline keyboard attached. Long text splits the same
 * way as sendMessage, but the keyboard ONLY attaches to the LAST chunk
 * (Telegram supports one reply_markup per message).
 */
/**
 * Send `text` with MarkdownV2 parse_mode. If Telegram rejects the markup with
 * a 400 (an unbalanced/unescaped reserved char makes it reject the WHOLE
 * message), retry ONCE as plain text so a session is never silently dropped.
 * Non-400 errors propagate (caller's queue swallows + logs).
 *
 * Callers are responsible for escaping any text that should render literally
 * via `escapeMarkdownV2`; intentional markup (```code```, *bold*) is passed
 * through by the caller assembling the message.
 */
export async function sendMessageMd(
  chatId: number | string,
  text: string,
): Promise<{ message_id: number } | void> {
  try {
    return await sendMessageReturningId(chatId, text, { parse_mode: "MarkdownV2" });
  } catch (err) {
    if (err instanceof TelegramClientError && err.status === 400) {
      // Markup rejected — fall back to plain text (strip nothing; Telegram
      // renders the raw chars). Better an unformatted message than none.
      return await sendMessageReturningId(chatId, text);
    }
    throw err;
  }
}

/**
 * Like {@link sendMessage} but returns the message_id of the LAST chunk sent
 * (parity with sendMessageWithKeyboard's return). Internal — callers use
 * sendMessage / sendMessageMd.
 */
async function sendMessageReturningId(
  chatId: number | string,
  text: string,
  opts: SendMessageOptions = {},
): Promise<{ message_id: number } | void> {
  const token = tokenOrThrow();
  const url = `${API_BASE}/bot${token}/sendMessage`;
  const chunks = splitForTelegram(text);
  let last: { message_id: number } | undefined;
  for (const chunk of chunks) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: chunk,
        ...(opts.parse_mode ? { parse_mode: opts.parse_mode } : {}),
        ...(opts.disable_web_page_preview ? { disable_web_page_preview: true } : {}),
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new TelegramClientError(res.status, body);
    }
    try {
      const json = (await res.json()) as { result?: { message_id?: number } };
      if (typeof json.result?.message_id === "number") last = { message_id: json.result.message_id };
    } catch {
      /* swallow — id is best-effort */
    }
  }
  return last;
}

/**
 * Send a Telegram chat action (e.g. "typing"). Expires after ~5s on Telegram's
 * side, so callers refresh on an interval while a turn is active. Best-effort —
 * errors are swallowed (a failed typing indicator must never affect delivery).
 */
export async function sendChatAction(
  chatId: number | string,
  action: "typing" = "typing",
): Promise<void> {
  const token = config.telegram.botToken;
  if (!token) return;
  try {
    await fetch(`${API_BASE}/bot${token}/sendChatAction`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, action }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    /* swallow — typing indicator is non-essential */
  }
}

export async function sendMessageWithKeyboard(
  chatId: number | string,
  text: string,
  inlineKeyboard: InlineKeyboard,
  opts: SendMessageOptions = {},
): Promise<{ message_id: number } | void> {
  const token = tokenOrThrow();
  const url = `${API_BASE}/bot${token}/sendMessage`;
  const chunks = splitForTelegram(text);
  if (chunks.length === 0) chunks.push("");
  let lastResult: { message_id: number } | undefined;
  for (let i = 0; i < chunks.length; i++) {
    const isLast = i === chunks.length - 1;
    const body: Record<string, unknown> = {
      chat_id: chatId,
      text: chunks[i],
      ...(opts.parse_mode ? { parse_mode: opts.parse_mode } : {}),
      ...(opts.disable_web_page_preview ? { disable_web_page_preview: true } : {}),
    };
    if (isLast) body.reply_markup = { inline_keyboard: inlineKeyboard };
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const respBody = await res.text().catch(() => "");
      throw new TelegramClientError(res.status, respBody);
    }
    if (isLast) {
      // Return the sent message_id so callers (the inline-approval prompt) can
      // edit it after a decision. Best-effort — a parse failure just yields void.
      try {
        const json = (await res.json()) as { result?: { message_id?: number } };
        if (typeof json.result?.message_id === "number") {
          lastResult = { message_id: json.result.message_id };
        }
      } catch {
        /* swallow — message_id is non-essential for non-approval callers */
      }
    }
  }
  return lastResult;
}

/**
 * Reply to a callback_query. Shown as toast in Telegram client (or alert if
 * `show_alert: true`). MUST be called within ~15s of receiving the callback
 * or Telegram shows a stale-callback warning to the user.
 */
export async function answerCallbackQuery(
  callbackQueryId: string,
  opts: { text?: string; show_alert?: boolean } = {},
): Promise<void> {
  const token = tokenOrThrow();
  const url = `${API_BASE}/bot${token}/answerCallbackQuery`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      callback_query_id: callbackQueryId,
      ...(opts.text ? { text: opts.text } : {}),
      ...(opts.show_alert ? { show_alert: true } : {}),
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new TelegramClientError(res.status, body);
  }
}

/**
 * Edit a previously-sent message's text + optionally its keyboard. Used by
 * paginated session picker to swap pages without spamming new messages.
 */
export async function editMessageText(
  chatId: number | string,
  messageId: number,
  text: string,
  opts: SendMessageOptions & { inline_keyboard?: InlineKeyboard } = {},
): Promise<void> {
  const token = tokenOrThrow();
  const url = `${API_BASE}/bot${token}/editMessageText`;
  const body: Record<string, unknown> = {
    chat_id: chatId,
    message_id: messageId,
    text,
    ...(opts.parse_mode ? { parse_mode: opts.parse_mode } : {}),
    ...(opts.disable_web_page_preview ? { disable_web_page_preview: true } : {}),
  };
  if (opts.inline_keyboard) body.reply_markup = { inline_keyboard: opts.inline_keyboard };
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    const respBody = await res.text().catch(() => "");
    throw new TelegramClientError(res.status, respBody);
  }
}

/**
 * Replace only the inline keyboard on an existing message. Used to mark the
 * picked session button with a ✓ after a session-set callback succeeds.
 */
export async function editMessageReplyMarkup(
  chatId: number | string,
  messageId: number,
  inlineKeyboard: InlineKeyboard,
): Promise<void> {
  const token = tokenOrThrow();
  const url = `${API_BASE}/bot${token}/editMessageReplyMarkup`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      message_id: messageId,
      reply_markup: { inline_keyboard: inlineKeyboard },
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    const respBody = await res.text().catch(() => "");
    throw new TelegramClientError(res.status, respBody);
  }
}

/**
 * Register the bot's command list with Telegram so typing `/` shows a popup
 * menu in the client. Idempotent on Telegram's side — calling repeatedly with
 * the same list is a no-op. Call ONCE at bridge startup.
 *
 * `commands` is `[{ command, description }]`; `command` must be 1–32 chars,
 * lowercase letters/digits/underscores, NO leading slash (Telegram adds it).
 */
export async function setMyCommands(
  commands: Array<{ command: string; description: string }>,
): Promise<void> {
  const token = tokenOrThrow();
  const url = `${API_BASE}/bot${token}/setMyCommands`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ commands }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new TelegramClientError(res.status, body);
  }
}

/**
 * MarkdownV2 variant of {@link editMessageText} with a 400→plain-text fallback,
 * mirroring {@link sendMessageMd}. Used by the streaming "working…" message which
 * is edited repeatedly as a turn progresses. A "message is not modified" 400
 * (identical text) is treated as success — it's a benign no-op edit.
 */
export async function editMessageTextMd(
  chatId: number | string,
  messageId: number,
  text: string,
): Promise<void> {
  try {
    await editMessageText(chatId, messageId, text, { parse_mode: "MarkdownV2" });
  } catch (err) {
    if (err instanceof TelegramClientError && err.status === 400) {
      if (err.bodyPreview.includes("message is not modified")) return;
      await editMessageText(chatId, messageId, text);
      return;
    }
    throw err;
  }
}

export async function getFile(fileId: string): Promise<{ file_id: string; file_path: string; file_size?: number }> {
  const token = tokenOrThrow();
  const url = `${API_BASE}/bot${token}/getFile?file_id=${encodeURIComponent(fileId)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new TelegramClientError(res.status, body);
  }
  const json = (await res.json()) as { ok: boolean; result?: { file_id: string; file_path?: string; file_size?: number } };
  if (!json.ok || !json.result || !json.result.file_path) {
    throw new TelegramClientError(res.status, JSON.stringify(json).slice(0, 200));
  }
  return { file_id: json.result.file_id, file_path: json.result.file_path, file_size: json.result.file_size };
}

/**
 * Download a file by its file_path (from getFile). Returns the raw bytes.
 * Caller is responsible for size-capping BEFORE invoking — pass file_size
 * through getFile() and reject early if oversize.
 */
export async function downloadFile(filePath: string): Promise<ArrayBuffer> {
  const token = tokenOrThrow();
  const url = `${API_BASE}/file/bot${token}/${filePath}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new TelegramClientError(res.status, body);
  }
  return await res.arrayBuffer();
}
