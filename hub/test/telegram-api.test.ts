/**
 * Phase 12 Wave 4 — Authenticated Telegram REST tests.
 *
 * Mounts the authed router behind a fake auth middleware that injects
 * `userId`, plus a fake CSRF guard mirroring the production double-submit
 * shape. DAL + link-code module + postgres `sql` are mocked — no DB.
 */
import { describe, test, expect, beforeAll, beforeEach, mock } from "bun:test";
import { Hono } from "hono";

const USER_ID = "11111111-1111-1111-1111-111111111111";
const OTHER_USER_ID = "22222222-2222-2222-2222-222222222222";
const SESSION_ID_OWNED = "sess-owned";
const SESSION_ID_FOREIGN = "sess-foreign";

// Set env BEFORE config.ts loads.
process.env.TELEGRAM_BOT_TOKEN = "fake-bot-token";
process.env.TELEGRAM_WEBHOOK_SECRET = "test-secret-must-be-at-least-16-chars";
process.env.TELEGRAM_BOT_USERNAME = "remocode_test_bot";

// ── Mutable test state ─────────────────────────────────────────────────────

const state: {
  user: {
    id: string;
    telegram_chat_id: string | null;
    telegram_default_session_id: string | null;
  };
  linkCodeGenerated: { code: string; expiresAt: Date } | null;
  defaultSessionSet: { userId: string; sessionId: string | null; explicit?: boolean } | null;
  cleared: boolean;
  linkCodeCleared: boolean;
  botUsername: string;
} = {
  user: { id: USER_ID, telegram_chat_id: null, telegram_default_session_id: null },
  linkCodeGenerated: null,
  defaultSessionSet: null,
  cleared: false,
  linkCodeCleared: false,
  botUsername: "remocode_test_bot",
};

// ── Mocks ──────────────────────────────────────────────────────────────────

// Spread real dal so unmocked exports stay resolvable for sibling files in the
// full suite (Bun mock.module is process-global). See memory: bun-mock-pollution.
const realDalTA = await import(`../src/db/dal.ts?real=${Date.now()}`);
mock.module("../src/db/dal.ts", () => ({
  ...realDalTA,
  getSession: async (sessionId: string, userId: string) => {
    if (sessionId === SESSION_ID_OWNED && userId === USER_ID) {
      return { id: SESSION_ID_OWNED, name: "owned", project_dir: null };
    }
    return null;
  },
  setTelegramDefaultSession: async (userId: string, sid: string | null, explicit: boolean) => {
    state.defaultSessionSet = { userId, sessionId: sid, explicit };
    if (userId === USER_ID) state.user.telegram_default_session_id = sid;
  },
  clearTelegramChatId: async (userId: string) => {
    if (userId === USER_ID) {
      state.cleared = true;
      state.user.telegram_chat_id = null;
      state.user.telegram_default_session_id = null;
    }
  },
  setTelegramLinkCode: async (userId: string, code: string | null, _exp: Date | null) => {
    if (userId === USER_ID && code === null) state.linkCodeCleared = true;
  },
}));

mock.module("../src/db/postgres.ts", () => ({
  sql: async (_strings: TemplateStringsArray, ..._values: any[]) => {
    // /status SELECT — return the in-memory user row.
    return [
      {
        telegram_chat_id: state.user.telegram_chat_id,
        telegram_default_session_id: state.user.telegram_default_session_id,
      },
    ];
  },
}));

mock.module("../src/telegram/link-codes.ts", () => ({
  createLinkCode: async (_userId: string) => {
    const code = "ABCD1234";
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    state.linkCodeGenerated = { code, expiresAt };
    return { code, expiresAt };
  },
}));

// Mock config so we can flip botUsername per-test.
mock.module("../src/config.ts", () => ({
  config: {
    telegram: {
      get botToken() { return "fake-bot-token"; },
      get webhookSecret() { return "test-secret-must-be-at-least-16-chars"; },
      get botUsername() { return state.botUsername; },
    },
  },
}));

// ── Helpers ────────────────────────────────────────────────────────────────

const CSRF_TOKEN = "csrf-fixture-token-32chars";

/**
 * Build the test app: fake auth middleware → fake CSRF guard → telegram
 * router. Mirrors the production stack ordering. Auth header `x-test-user`
 * injects the userId (omit to simulate an unauthed request → 401).
 */
async function buildApp(): Promise<Hono> {
  const { telegram } = await import("../src/api/telegram.ts");
  const app = new Hono();

  // Fake auth — sets userId from header, else 401.
  app.use("/api/telegram/*", async (c, next) => {
    const u = c.req.header("x-test-user");
    if (!u) return c.json({ error: "unauthorized" }, 401);
    c.set("userId", u);
    await next();
  });

  // Fake CSRF — production uses double-submit; here we require the header
  // match a fixture token on mutating methods. Mirrors csrfGuard semantics.
  const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);
  app.use("/api/telegram/*", async (c, next) => {
    if (!MUTATING.has(c.req.method.toUpperCase())) return next();
    const hdr = c.req.header("X-CSRF-Token") || c.req.header("x-csrf-token");
    if (hdr !== CSRF_TOKEN) return c.json({ error: "csrf_failed" }, 403);
    await next();
  });

  app.route("/api/telegram", telegram);
  return app;
}

let app: Hono;

beforeAll(async () => {
  app = await buildApp();
});

beforeEach(() => {
  state.user = { id: USER_ID, telegram_chat_id: null, telegram_default_session_id: null };
  state.linkCodeGenerated = null;
  state.defaultSessionSet = null;
  state.cleared = false;
  state.linkCodeCleared = false;
  state.botUsername = "remocode_test_bot";
});

function authedHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { "x-test-user": USER_ID, "X-CSRF-Token": CSRF_TOKEN, ...extra };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("GET /api/telegram/status", () => {
  test("401 when unauthed", async () => {
    const res = await app.request("/api/telegram/status");
    expect(res.status).toBe(401);
  });

  test("unlinked state", async () => {
    const res = await app.request("/api/telegram/status", {
      headers: { "x-test-user": USER_ID },
    });
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.linked).toBe(false);
    expect(body.chat_id).toBeNull();
    expect(body.default_session_id).toBeNull();
    expect(body.bot_username).toBe("remocode_test_bot");
    expect(body.bot_configured).toBe(true);
  });

  test("linked state (chat_id stringified)", async () => {
    state.user.telegram_chat_id = "555000111";
    state.user.telegram_default_session_id = SESSION_ID_OWNED;
    const res = await app.request("/api/telegram/status", {
      headers: { "x-test-user": USER_ID },
    });
    const body: any = await res.json();
    expect(body.linked).toBe(true);
    expect(body.chat_id).toBe("555000111");
    expect(typeof body.chat_id).toBe("string");
    expect(body.default_session_id).toBe(SESSION_ID_OWNED);
  });
});

describe("POST /api/telegram/link-code", () => {
  test("401 when unauthed", async () => {
    const res = await app.request("/api/telegram/link-code", {
      method: "POST",
      headers: { "X-CSRF-Token": CSRF_TOKEN },
    });
    expect(res.status).toBe(401);
  });

  test("403 when CSRF token missing", async () => {
    const res = await app.request("/api/telegram/link-code", {
      method: "POST",
      headers: { "x-test-user": USER_ID },
    });
    expect(res.status).toBe(403);
  });

  test("returns code + deepLink + expiresAt", async () => {
    const res = await app.request("/api/telegram/link-code", {
      method: "POST",
      headers: authedHeaders(),
    });
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.code).toBe("ABCD1234");
    expect(body.deepLink).toBe("https://t.me/remocode_test_bot?start=ABCD1234");
    expect(typeof body.expiresAt).toBe("string");
    expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  test("503 when bot_username unset", async () => {
    state.botUsername = "";
    const res = await app.request("/api/telegram/link-code", {
      method: "POST",
      headers: authedHeaders(),
    });
    expect(res.status).toBe(503);
    const body: any = await res.json();
    expect(body.error).toBe("telegram_not_configured");
  });
});

describe("DELETE /api/telegram/link", () => {
  test("clears telegram fields, 204", async () => {
    state.user.telegram_chat_id = "555000111";
    state.user.telegram_default_session_id = SESSION_ID_OWNED;
    const res = await app.request("/api/telegram/link", {
      method: "DELETE",
      headers: authedHeaders(),
    });
    expect(res.status).toBe(204);
    expect(state.cleared).toBe(true);
    expect(state.linkCodeCleared).toBe(true);
  });

  test("CSRF required", async () => {
    const res = await app.request("/api/telegram/link", {
      method: "DELETE",
      headers: { "x-test-user": USER_ID },
    });
    expect(res.status).toBe(403);
  });
});

describe("PUT /api/telegram/default-session", () => {
  test("sets owned session", async () => {
    const res = await app.request("/api/telegram/default-session", {
      method: "PUT",
      headers: { ...authedHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: SESSION_ID_OWNED }),
    });
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.session_id).toBe(SESSION_ID_OWNED);
    // C-2: a web-UI default pick is a DELIBERATE choice → explicit=true so it is
    // never auto-overridden to the orchestrator on the next inbound message.
    expect(state.defaultSessionSet).toEqual({ userId: USER_ID, sessionId: SESSION_ID_OWNED, explicit: true });
  });

  test("404 on foreign session", async () => {
    const res = await app.request("/api/telegram/default-session", {
      method: "PUT",
      headers: { ...authedHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: SESSION_ID_FOREIGN }),
    });
    expect(res.status).toBe(404);
    const body: any = await res.json();
    expect(body.error).toBe("session_not_found");
    expect(state.defaultSessionSet).toBeNull();
  });

  test("null clears the default", async () => {
    state.user.telegram_default_session_id = SESSION_ID_OWNED;
    const res = await app.request("/api/telegram/default-session", {
      method: "PUT",
      headers: { ...authedHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: null }),
    });
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.session_id).toBeNull();
    // Clearing is NOT a choice → explicit=false (lets a later inbound prefer the orchestrator).
    expect(state.defaultSessionSet).toEqual({ userId: USER_ID, sessionId: null, explicit: false });
  });

  test("400 on invalid body", async () => {
    const res = await app.request("/api/telegram/default-session", {
      method: "PUT",
      headers: { ...authedHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ bogus: 1 }),
    });
    expect(res.status).toBe(400);
  });

  test("CSRF required", async () => {
    const res = await app.request("/api/telegram/default-session", {
      method: "PUT",
      headers: { "x-test-user": USER_ID, "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: null }),
    });
    expect(res.status).toBe(403);
  });

  test("rejects setting another user's session (different userId)", async () => {
    const res = await app.request("/api/telegram/default-session", {
      method: "PUT",
      headers: { "x-test-user": OTHER_USER_ID, "X-CSRF-Token": CSRF_TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: SESSION_ID_OWNED }),
    });
    expect(res.status).toBe(404);
  });
});
