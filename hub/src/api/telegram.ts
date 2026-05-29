/**
 * Phase 12 Wave 4 — Authenticated Telegram REST.
 *
 * Sits behind the `/api/*` JWT/cookie auth catch-all AND the CSRF guard
 * (mounted in hub/src/index.ts). The public webhook at
 * `/api/telegram/webhook/:secret` is mounted on a DIFFERENT router earlier
 * in the pipeline — see hub/src/api/telegram-webhook.ts — and is the only
 * Telegram surface exempt from auth+CSRF+license.
 *
 * Endpoints (all require authed userId + CSRF on mutating methods):
 *   GET    /api/telegram/status            → linked state + bot_username
 *   POST   /api/telegram/link-code         → fresh 10-min code + deep link
 *   DELETE /api/telegram/link              → unlink chat + clear default
 *   PUT    /api/telegram/default-session   → set/clear default routing
 *
 * Invariants:
 *   - `chat_id` is BigInt-safe → always serialized as string in JSON.
 *   - Session ownership verified before set: a user cannot point Telegram
 *     at a session they don't own.
 *   - If `config.telegram.botUsername` is unset, link-code returns 503 so
 *     the UI shows the "not configured" card instead of producing a code
 *     that has no deep-link to consume it.
 */
import { Hono } from "hono";
import { z } from "zod";
import { config } from "../config.ts";
import {
  getSession,
  setTelegramDefaultSession,
  clearTelegramChatId,
  setTelegramLinkCode,
} from "../db/dal.ts";
import { sql } from "../db/postgres.ts";
import { createLinkCode } from "../telegram/link-codes.ts";

export const telegram = new Hono();

function chatIdToString(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  // postgres.js returns BIGINT as string by default; defensively coerce.
  return String(v);
}

// GET /api/telegram/status
// Returns the current link state plus the bot username so the UI can render
// the deep-link button label / "not configured" empty state.
telegram.get("/status", async (c) => {
  const userId = c.get("userId") as string;
  const rows = await sql<
    Array<{
      telegram_chat_id: string | number | null;
      telegram_default_session_id: string | null;
    }>
  >`
    SELECT telegram_chat_id, telegram_default_session_id
      FROM users
     WHERE id = ${userId}
     LIMIT 1
  `;
  const row = rows[0];
  const chatId = chatIdToString(row?.telegram_chat_id ?? null);
  return c.json({
    linked: chatId !== null,
    chat_id: chatId,
    default_session_id: row?.telegram_default_session_id ?? null,
    bot_username: config.telegram.botUsername || null,
    bot_configured: !!(config.telegram.botToken && config.telegram.webhookSecret),
  });
});

// POST /api/telegram/link-code
// Generate a fresh 10-min single-use code and return it together with the
// deep link the user taps to send `/start <code>` in Telegram.
telegram.post("/link-code", async (c) => {
  const userId = c.get("userId") as string;
  const botUsername = config.telegram.botUsername;
  if (!botUsername) {
    return c.json({ error: "telegram_not_configured" }, 503);
  }
  const { code, expiresAt } = await createLinkCode(userId);
  return c.json({
    code,
    deepLink: `https://t.me/${botUsername}?start=${code}`,
    expiresAt: expiresAt.toISOString(),
  });
});

// DELETE /api/telegram/link
// Clear chat_id, default_session_id, and any in-flight link code. 204.
telegram.delete("/link", async (c) => {
  const userId = c.get("userId") as string;
  await clearTelegramChatId(userId);
  // clearTelegramChatId nulls chat_id + default_session_id but leaves any
  // stale link-code lying around — wipe it too so a re-link starts clean.
  await setTelegramLinkCode(userId, null, null);
  return c.body(null, 204);
});

const PutDefaultSchema = z.object({
  session_id: z.string().nullable(),
});

// PUT /api/telegram/default-session
// Set or clear the session Telegram inbound text routes to. Verifies
// ownership before writing.
telegram.put("/default-session", async (c) => {
  const userId = c.get("userId") as string;
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  const parsed = PutDefaultSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "invalid_body" }, 400);
  }
  const sessionId = parsed.data.session_id;
  if (sessionId !== null) {
    const owned = await getSession(sessionId, userId);
    if (!owned) {
      return c.json({ error: "session_not_found" }, 404);
    }
  }
  // A web-UI default pick is a DELIBERATE choice → explicit. Clearing (null) is
  // not a choice → not explicit, so a later inbound can prefer the orchestrator.
  await setTelegramDefaultSession(userId, sessionId, sessionId !== null);
  return c.json({ session_id: sessionId });
});
