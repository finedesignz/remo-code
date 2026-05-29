/**
 * orchestrator-autolaunch (2026-05-28) — Telegram default-target falls back to
 * the orchestrator session.
 *
 * Exercises `POST /api/telegram/webhook/:secret` end-to-end (DB / Telegram-API
 * / dispatch mocked, no Postgres, no network) and asserts:
 *
 *   1. linked chat, NULL default, orchestrator enabled + open → dispatch targets
 *      the orchestrator AND lazy-pins it into telegram_default_session_id.
 *   2. linked chat, NULL default, orchestrator DISABLED → "No default session".
 *   3. linked chat, NULL default, orchestrator explicitly-disabled → "No default".
 *   4. stale pinned default (session deleted) → re-resolves to orchestrator +
 *      re-pins.
 *
 * mock.module is process-global — run isolated via check-baseline (per-file).
 */
import { describe, test, expect, beforeEach, mock } from "bun:test";
import { Hono } from "hono";

const TEST_SECRET = "test-secret-must-be-at-least-16-chars";
const LINKED_CHAT = 555000777;
const LINKED_USER_ID = "22222222-2222-2222-2222-222222222222";
const LINKED_EMAIL = "orch-default@example.com";
const ORCH_SESSION_ID = "sess_orch_default";

process.env.TELEGRAM_BOT_TOKEN = "fake-bot-token-orchdef";
process.env.TELEGRAM_WEBHOOK_SECRET = TEST_SECRET;
process.env.TELEGRAM_BOT_USERNAME = "remocode_orchdef_bot";

const state = {
  user: {
    id: LINKED_USER_ID,
    email: LINKED_EMAIL,
    telegram_chat_id: LINKED_CHAT as number | null,
    telegram_default_session_id: null as string | null,
    telegram_default_explicit: false,
  },
  // sessions that "exist" (getSession returns a row for these ids).
  liveSessionIds: new Set<string>(),
  // orchestrator prefs + open row.
  orchEnabled: true,
  orchDisabledExplicitly: false,
  orchOpenSession: { id: ORCH_SESSION_ID, status: "offline", is_orchestrator: true } as any,
  setDefaults: [] as Array<{ userId: string; sessionId: string | null; explicit?: boolean }>,
  dispatchCalls: [] as any[],
  dispatchOutcome: "dispatched" as string,
  sentMessages: [] as Array<{ chat: number | string; text: string }>,
  dedupe: new Set<number>(),
};

const realDal = await import(`../src/db/dal.ts?real=${Date.now()}`);

mock.module("../src/db/dal.ts", () => ({
  ...realDal,
  getUserByTelegramChatId: async (chatId: number) =>
    state.user.telegram_chat_id === Number(chatId) ? state.user : null,
  findUserByLinkCode: async () => null,
  setTelegramChatId: async () => {},
  setTelegramDefaultSession: async (userId: string, sid: string | null, explicit = false) => {
    state.setDefaults.push({ userId, sessionId: sid, explicit });
    if (state.user.id === userId) {
      state.user.telegram_default_session_id = sid;
      state.user.telegram_default_explicit = explicit;
    }
  },
  getSession: async (sessionId: string) =>
    state.liveSessionIds.has(sessionId)
      ? { id: sessionId, name: "n", project_dir: "/p", hostname: "h", is_orchestrator: sessionId === ORCH_SESSION_ID }
      : null,
  logTelegramInbound: async (input: any) => {
    const uid = Number(input.update_id);
    if (state.dedupe.has(uid)) return { inserted: false };
    state.dedupe.add(uid);
    return { inserted: true };
  },
}));

mock.module("../src/db/orchestrator-dal.ts", () => ({
  getOrchestratorState: async () => ({
    orchestrator_enabled: state.orchEnabled,
    orchestrator_name: "Orchestrator",
    orchestrator_custom_instructions: null,
    orchestrator_disabled_explicitly: state.orchDisabledExplicitly,
  }),
  findOpenOrchestratorSession: async () => state.orchOpenSession,
}));

mock.module("../src/telegram/client.ts", () => ({
  sendMessage: async (chatId: number | string, text: string) => {
    state.sentMessages.push({ chat: chatId, text });
  },
  sendMessageWithKeyboard: async (chatId: number | string, text: string) => {
    state.sentMessages.push({ chat: chatId, text });
  },
  answerCallbackQuery: async () => {},
  editMessageText: async () => {},
  editMessageReplyMarkup: async () => {},
  getFile: async (fileId: string) => ({ file_id: fileId, file_path: "x", file_size: 1 }),
  downloadFile: async () => new ArrayBuffer(8),
  escapeMarkdownV2: (s: string) => s,
  splitForTelegram: (s: string) => [s],
  TelegramClientError: class extends Error {},
}));

mock.module("../src/telegram/dispatch.ts", () => ({
  dispatchToSession: async (input: any) => {
    state.dispatchCalls.push(input);
    return state.dispatchOutcome === "dispatched"
      ? { kind: "dispatched" }
      : { kind: state.dispatchOutcome };
  },
  isOverCostCap: async () => false,
  nextUtcResetIso: () => "2026-05-29T00:00:00.000Z",
}));

// Doctor / launch deps — only hit if agent_offline fires; keep them inert.
mock.module("../src/db/supervisor-dal.ts", () => ({
  listSupervisorsForUser: async () => [{ id: "sup-1", hostname: "h", last_seen_at: new Date() }],
  createRun: async () => ({ id: "run-1" }),
}));
mock.module("../src/ws/supervisor-registry.ts", () => ({
  isSupervisorOnline: () => true,
  sendToSupervisor: () => {},
  updateSupervisorState: async () => {},
}));
mock.module("../src/ws/registry.ts", () => ({
  getChannel: () => undefined,
  broadcastToSubscribers: () => {},
}));

const { telegramWebhookRoutes } = await import("../src/api/telegram-webhook.ts");

function makeApp() {
  const app = new Hono();
  app.route("/api/telegram", telegramWebhookRoutes);
  return app;
}

async function postUpdate(text: string, updateId = Math.floor(Math.random() * 1e9)) {
  const app = makeApp();
  return app.request(`/api/telegram/webhook/${TEST_SECRET}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      update_id: updateId,
      message: { message_id: 1, date: 1700000000, chat: { id: LINKED_CHAT, type: "private" }, from: { id: LINKED_CHAT }, text },
    }),
  });
}

beforeEach(() => {
  state.user = {
    id: LINKED_USER_ID,
    email: LINKED_EMAIL,
    telegram_chat_id: LINKED_CHAT,
    telegram_default_session_id: null,
    telegram_default_explicit: false,
  };
  state.liveSessionIds = new Set([ORCH_SESSION_ID]);
  state.orchEnabled = true;
  state.orchDisabledExplicitly = false;
  state.orchOpenSession = { id: ORCH_SESSION_ID, status: "offline", is_orchestrator: true };
  state.setDefaults.length = 0;
  state.dispatchCalls.length = 0;
  state.dispatchOutcome = "dispatched";
  state.sentMessages.length = 0;
  state.dedupe.clear();
});

describe("Telegram default → orchestrator fallback", () => {
  test("null default + orchestrator enabled+open → dispatch targets orchestrator + lazy-pins", async () => {
    const res = await postUpdate("hello orchestrator");
    expect(res.status).toBe(200);
    expect(state.dispatchCalls.length).toBe(1);
    expect(state.dispatchCalls[0].sessionId).toBe(ORCH_SESSION_ID);
    // Lazy-pin persisted as NON-explicit (auto-pin, not a deliberate choice).
    expect(state.setDefaults).toEqual([{ userId: LINKED_USER_ID, sessionId: ORCH_SESSION_ID, explicit: false }]);
  });

  test("null default + orchestrator DISABLED → 'No default session' reply, no dispatch", async () => {
    state.orchEnabled = false;
    const res = await postUpdate("hello");
    expect(res.status).toBe(200);
    expect(state.dispatchCalls.length).toBe(0);
    expect(state.sentMessages.some((m) => /no default session/i.test(m.text))).toBe(true);
  });

  test("null default + orchestrator explicitly-disabled → 'No default session', no dispatch", async () => {
    state.orchEnabled = true;
    state.orchDisabledExplicitly = true;
    const res = await postUpdate("hello");
    expect(res.status).toBe(200);
    expect(state.dispatchCalls.length).toBe(0);
    expect(state.sentMessages.some((m) => /no default session/i.test(m.text))).toBe(true);
  });

  test("stale pinned default (session deleted) → re-resolves to orchestrator + re-pins", async () => {
    // Pin a session id that no longer exists (not in liveSessionIds).
    state.user.telegram_default_session_id = "sess_deleted";
    // orchestrator IS live + enabled.
    const res = await postUpdate("hello again");
    expect(res.status).toBe(200);
    expect(state.dispatchCalls.length).toBe(1);
    expect(state.dispatchCalls[0].sessionId).toBe(ORCH_SESSION_ID);
    expect(state.setDefaults).toEqual([{ userId: LINKED_USER_ID, sessionId: ORCH_SESSION_ID, explicit: false }]);
  });

  test("EXPLICIT live default (non-orchestrator) → honored, no orchestrator override, no re-pin", async () => {
    // The user deliberately picked this repo via /session or a /list tap.
    state.liveSessionIds.add("sess_project");
    state.user.telegram_default_session_id = "sess_project";
    state.user.telegram_default_explicit = true;
    const res = await postUpdate("work on the project");
    expect(res.status).toBe(200);
    expect(state.dispatchCalls.length).toBe(1);
    expect(state.dispatchCalls[0].sessionId).toBe("sess_project"); // NOT overridden
    expect(state.setDefaults.length).toBe(0); // explicit default honored, no re-pin
  });

  test("NON-explicit live default (auto-pinned repo) → orchestrator PREFERRED + re-pinned non-explicit", async () => {
    // Simulates the user whose default was auto-pinned (prewarm / prior fallback)
    // rather than explicitly chosen. The orchestrator wins for a no-choice user.
    state.liveSessionIds.add("sess_autopinned");
    state.user.telegram_default_session_id = "sess_autopinned";
    state.user.telegram_default_explicit = false;
    const res = await postUpdate("hey");
    expect(res.status).toBe(200);
    expect(state.dispatchCalls.length).toBe(1);
    expect(state.dispatchCalls[0].sessionId).toBe(ORCH_SESSION_ID);
    expect(state.setDefaults).toEqual([{ userId: LINKED_USER_ID, sessionId: ORCH_SESSION_ID, explicit: false }]);
  });
});
