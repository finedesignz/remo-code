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
