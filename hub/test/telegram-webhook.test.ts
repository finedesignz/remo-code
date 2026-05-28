/**
 * Phase 12 Wave 2 — Telegram webhook tests.
 *
 * Covers the `POST /api/telegram/webhook/:secret` route end-to-end with all
 * DB / Telegram-API / dispatch dependencies mocked via `mock.module`. No
 * Postgres, no network.
 */
import { describe, test, expect, beforeAll, beforeEach, mock } from "bun:test";
import { Hono } from "hono";

const TEST_SECRET = "test-secret-must-be-at-least-16-chars";
const LINKED_CHAT = 555000111;
const UNLINKED_CHAT = 999000222;
const LINKED_USER_ID = "11111111-1111-1111-1111-111111111111";
const LINKED_EMAIL = "linked@example.com";

// Set env BEFORE config.ts loads.
process.env.TELEGRAM_BOT_TOKEN = "fake-bot-token";
process.env.TELEGRAM_WEBHOOK_SECRET = TEST_SECRET;
process.env.TELEGRAM_BOT_USERNAME = "remocode_test_bot";

// ── Mutable test state ─────────────────────────────────────────────────────

type DispatchKind =
  | "dispatched"
  | "no_session"
  | "cost_capped"
  | "session_busy"
  | "agent_offline"
  | "failed";

const state: {
  linkCodeUser: { id: string; expiresAt: Date | null } | null;
  user: { id: string; email: string; telegram_chat_id: number | null; telegram_default_session_id: string | null } | null;
  insertedLogs: any[];
  dedupeOnUpdateId: Set<number>;
  sentMessages: Array<{ chat: number | string; text: string }>;
  dispatchOutcome: DispatchKind;
  dispatchCalls: any[];
} = {
  linkCodeUser: null,
  user: null,
  insertedLogs: [],
  dedupeOnUpdateId: new Set(),
  sentMessages: [],
  dispatchOutcome: "dispatched",
  dispatchCalls: [],
};

// ── Mocks ──────────────────────────────────────────────────────────────────

mock.module("../src/db/dal.ts", () => ({
  getUserByTelegramChatId: async (chatId: number) => {
    if (state.user && state.user.telegram_chat_id === Number(chatId)) return state.user;
    return null;
  },
  findUserByLinkCode: async (_code: string) => state.linkCodeUser,
  setTelegramChatId: async (userId: string, chatId: number) => {
    if (state.user && state.user.id === userId) state.user.telegram_chat_id = Number(chatId);
    else state.user = { id: userId, email: LINKED_EMAIL, telegram_chat_id: Number(chatId), telegram_default_session_id: null };
    state.linkCodeUser = null;
  },
  setTelegramDefaultSession: async (userId: string, sid: string | null) => {
    if (state.user && state.user.id === userId) state.user.telegram_default_session_id = sid;
  },
  logTelegramInbound: async (input: any) => {
    const uid = Number(input.update_id);
    if (state.dedupeOnUpdateId.has(uid)) return { inserted: false };
    state.dedupeOnUpdateId.add(uid);
    state.insertedLogs.push(input);
    return { inserted: true };
  },
  // Used transitively by handleStart's email lookup.
  // The commands module imports `sql` from db/postgres directly for that
  // lookup, which we mock below.
}));

mock.module("../src/db/postgres.ts", () => ({
  sql: async (_strings: TemplateStringsArray, ..._values: any[]) => {
    // Only used for the email lookup in handleStart. Return whatever user we have.
    if (state.user) return [{ email: state.user.email }];
    return [];
  },
}));

// Telegram client — record sends, never network.
mock.module("../src/telegram/client.ts", () => ({
  sendMessage: async (chatId: number | string, text: string) => {
    state.sentMessages.push({ chat: chatId, text });
  },
  getFile: async (fileId: string) => ({ file_id: fileId, file_path: "photos/file.jpg", file_size: 1024 }),
  downloadFile: async (_fp: string) => new ArrayBuffer(8),
  escapeMarkdownV2: (s: string) => s,
  splitForTelegram: (s: string) => [s],
  TelegramClientError: class extends Error {},
}));

// Dispatch — record calls, return configured outcome.
mock.module("../src/telegram/dispatch.ts", () => ({
  dispatchToSession: async (input: any) => {
    state.dispatchCalls.push(input);
    switch (state.dispatchOutcome) {
      case "dispatched":
        return { kind: "dispatched" };
      case "no_session":
        return { kind: "no_session" };
      case "cost_capped":
        return { kind: "cost_capped", resumesAtUtc: "2026-05-29T00:00:00.000Z" };
      case "session_busy":
        return { kind: "session_busy" };
      case "agent_offline":
        return { kind: "agent_offline" };
      case "failed":
        return { kind: "failed", reason: "test" };
    }
  },
  isOverCostCap: async () => false,
  nextUtcResetIso: () => "2026-05-29T00:00:00.000Z",
}));

// ── Helpers ────────────────────────────────────────────────────────────────

function post(app: Hono, path: string, body: any): Promise<Response> {
  return app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function mkUpdate(opts: { update_id: number; chatId: number; text?: string; photo?: any[]; document?: any }) {
  return {
    update_id: opts.update_id,
    message: {
      message_id: 1,
      date: Math.floor(Date.now() / 1000),
      chat: { id: opts.chatId },
      from: { id: opts.chatId },
      ...(opts.text !== undefined ? { text: opts.text } : {}),
      ...(opts.photo ? { photo: opts.photo } : {}),
      ...(opts.document ? { document: opts.document } : {}),
    },
  };
}

let app: Hono;

beforeAll(async () => {
  const mod = await import("../src/api/telegram-webhook.ts");
  app = new Hono();
  app.route("/api/telegram", mod.telegramWebhookRoutes);
});

beforeEach(() => {
  state.linkCodeUser = null;
  state.user = null;
  state.insertedLogs = [];
  state.dedupeOnUpdateId = new Set();
  state.sentMessages = [];
  state.dispatchOutcome = "dispatched";
  state.dispatchCalls = [];
});

// ── Tests ──────────────────────────────────────────────────────────────────

describe("auth", () => {
  test("401 with empty body on secret mismatch", async () => {
    const res = await post(app, "/api/telegram/webhook/wrong-secret-value", mkUpdate({ update_id: 1, chatId: UNLINKED_CHAT, text: "hi" }));
    expect(res.status).toBe(401);
    expect(await res.text()).toBe("");
    // Critical: NO audit row on auth fail (avoid table-fill DoS).
    expect(state.insertedLogs.length).toBe(0);
  });

  test("503 when feature disabled (token unset)", async () => {
    // Re-import config with the env var stripped, then re-import the route.
    const oldToken = process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_BOT_TOKEN;
    // We can't easily re-import config since it's cached. Instead, stub it.
    mock.module("../src/config.ts", () => ({
      config: { telegram: { botToken: "", webhookSecret: TEST_SECRET, botUsername: "" } },
    }));
    // Re-import the route module so it picks up the new config binding.
    const mod = await import("../src/api/telegram-webhook.ts?disabled");
    const a = new Hono();
    a.route("/api/telegram", mod.telegramWebhookRoutes);
    const res = await post(a, `/api/telegram/webhook/${TEST_SECRET}`, mkUpdate({ update_id: 9001, chatId: UNLINKED_CHAT, text: "hi" }));
    expect(res.status).toBe(503);
    // Restore.
    process.env.TELEGRAM_BOT_TOKEN = oldToken;
    mock.module("../src/config.ts", () => ({
      config: { telegram: { botToken: "fake-bot-token", webhookSecret: TEST_SECRET, botUsername: "" } },
    }));
  });
});

describe("/start link flow", () => {
  test("valid code links chat_id and replies with email", async () => {
    state.linkCodeUser = { id: LINKED_USER_ID, expiresAt: new Date(Date.now() + 5 * 60 * 1000) };
    const res = await post(app, `/api/telegram/webhook/${TEST_SECRET}`, mkUpdate({ update_id: 100, chatId: UNLINKED_CHAT, text: "/start ABC12345" }));
    expect(res.status).toBe(200);
    expect(state.user?.telegram_chat_id).toBe(UNLINKED_CHAT);
    expect(state.sentMessages[0]?.text).toContain("Linked to");
  });

  test("expired code rejected with friendly message", async () => {
    state.linkCodeUser = { id: LINKED_USER_ID, expiresAt: new Date(Date.now() - 1000) };
    const res = await post(app, `/api/telegram/webhook/${TEST_SECRET}`, mkUpdate({ update_id: 101, chatId: UNLINKED_CHAT, text: "/start STALE123" }));
    expect(res.status).toBe(200);
    expect(state.user).toBeNull();
    expect(state.sentMessages[0]?.text.toLowerCase()).toContain("expired");
  });

  test("invalid code rejected with friendly message", async () => {
    state.linkCodeUser = null;
    const res = await post(app, `/api/telegram/webhook/${TEST_SECRET}`, mkUpdate({ update_id: 102, chatId: UNLINKED_CHAT, text: "/start XXXXXXXX" }));
    expect(res.status).toBe(200);
    expect(state.sentMessages[0]?.text.toLowerCase()).toContain("invalid or expired");
  });
});

describe("unlinked chat silent drop + dedupe", () => {
  test("plain text from unlinked chat → 200 silent + audit row", async () => {
    const res = await post(app, `/api/telegram/webhook/${TEST_SECRET}`, mkUpdate({ update_id: 200, chatId: UNLINKED_CHAT, text: "hello bot" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.outcome).toBe("silent_drop_unlinked");
    expect(state.sentMessages.length).toBe(0); // no reply
    expect(state.insertedLogs.length).toBe(1); // audit row written
  });

  test("duplicate (chat_id, update_id) → 200 silent, dispatched once", async () => {
    state.user = { id: LINKED_USER_ID, email: LINKED_EMAIL, telegram_chat_id: LINKED_CHAT, telegram_default_session_id: "sess_abc" };
    const u = mkUpdate({ update_id: 300, chatId: LINKED_CHAT, text: "hello" });
    const r1 = await post(app, `/api/telegram/webhook/${TEST_SECRET}`, u);
    expect(r1.status).toBe(200);
    expect(state.dispatchCalls.length).toBe(1);
    const r2 = await post(app, `/api/telegram/webhook/${TEST_SECRET}`, u);
    expect(r2.status).toBe(200);
    const body2 = (await r2.json()) as any;
    expect(body2.deduped).toBe(true);
    expect(state.dispatchCalls.length).toBe(1); // NOT incremented
  });
});

describe("linked command dispatch", () => {
  beforeEach(() => {
    state.user = { id: LINKED_USER_ID, email: LINKED_EMAIL, telegram_chat_id: LINKED_CHAT, telegram_default_session_id: "sess_abc" };
  });

  test("/help replies with command reference", async () => {
    const res = await post(app, `/api/telegram/webhook/${TEST_SECRET}`, mkUpdate({ update_id: 400, chatId: LINKED_CHAT, text: "/help" }));
    expect(res.status).toBe(200);
    expect(state.sentMessages[0]?.text).toContain("/list");
    expect(state.sentMessages[0]?.text).toContain("/session");
  });

  test("/start from already-linked chat → polite no-op", async () => {
    const res = await post(app, `/api/telegram/webhook/${TEST_SECRET}`, mkUpdate({ update_id: 401, chatId: LINKED_CHAT, text: "/start XYZ" }));
    expect(res.status).toBe(200);
    expect(state.sentMessages[0]?.text).toContain("already linked");
  });

  test("unknown command from linked chat → 'Unknown command'", async () => {
    const res = await post(app, `/api/telegram/webhook/${TEST_SECRET}`, mkUpdate({ update_id: 402, chatId: LINKED_CHAT, text: "/wat" }));
    expect(res.status).toBe(200);
    expect(state.sentMessages[0]?.text.toLowerCase()).toContain("unknown command");
  });
});

describe("linked plain-text dispatch", () => {
  test("text from linked user with default session → dispatchToSession called", async () => {
    state.user = { id: LINKED_USER_ID, email: LINKED_EMAIL, telegram_chat_id: LINKED_CHAT, telegram_default_session_id: "sess_abc" };
    const res = await post(app, `/api/telegram/webhook/${TEST_SECRET}`, mkUpdate({ update_id: 500, chatId: LINKED_CHAT, text: "ship it" }));
    expect(res.status).toBe(200);
    expect(state.dispatchCalls.length).toBe(1);
    expect(state.dispatchCalls[0].text).toBe("ship it");
    expect(state.dispatchCalls[0].sessionId).toBe("sess_abc");
  });

  test("text from linked user with NO default session → friendly nudge, no dispatch", async () => {
    state.user = { id: LINKED_USER_ID, email: LINKED_EMAIL, telegram_chat_id: LINKED_CHAT, telegram_default_session_id: null };
    const res = await post(app, `/api/telegram/webhook/${TEST_SECRET}`, mkUpdate({ update_id: 501, chatId: LINKED_CHAT, text: "hi" }));
    expect(res.status).toBe(200);
    // dispatchInbound gates on default_session_id BEFORE calling dispatchToSession.
    expect(state.dispatchCalls.length).toBe(0);
    expect(state.sentMessages[0]?.text.toLowerCase()).toContain("no default session");
  });

  test("cost-cap exceeded → throttle reply, no further dispatch follow-up", async () => {
    state.user = { id: LINKED_USER_ID, email: LINKED_EMAIL, telegram_chat_id: LINKED_CHAT, telegram_default_session_id: "sess_abc" };
    state.dispatchOutcome = "cost_capped";
    const res = await post(app, `/api/telegram/webhook/${TEST_SECRET}`, mkUpdate({ update_id: 502, chatId: LINKED_CHAT, text: "expensive" }));
    expect(res.status).toBe(200);
    expect(state.dispatchCalls.length).toBe(1);
    expect(state.sentMessages[0]?.text.toLowerCase()).toContain("daily cost cap");
  });

  test("session_busy → polite busy reply", async () => {
    state.user = { id: LINKED_USER_ID, email: LINKED_EMAIL, telegram_chat_id: LINKED_CHAT, telegram_default_session_id: "sess_abc" };
    state.dispatchOutcome = "session_busy";
    const res = await post(app, `/api/telegram/webhook/${TEST_SECRET}`, mkUpdate({ update_id: 503, chatId: LINKED_CHAT, text: "queue me" }));
    expect(res.status).toBe(200);
    expect(state.sentMessages[0]?.text.toLowerCase()).toContain("busy");
  });
});
