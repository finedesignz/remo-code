/**
 * Phase 12 Wave 3 — Telegram outbound bridge tests.
 *
 * Covers the bridge end-to-end with sendMessage + DAL mocked. No DB, no
 * network. Verifies feature gate, lookup match/no-match, error isolation,
 * and per-chat serialization.
 */
import { describe, test, expect, beforeAll, beforeEach, afterEach, mock } from "bun:test";

// Set env BEFORE config.ts loads. Default to ENABLED; one test re-imports
// with the token unset via a sub-scope.
process.env.TELEGRAM_BOT_TOKEN = "fake-bot-token-bridge";
process.env.TELEGRAM_WEBHOOK_SECRET = "test-secret-must-be-at-least-16-chars";
process.env.TELEGRAM_BOT_USERNAME = "remocode_test_bot";

// ── Mutable state ─────────────────────────────────────────────────────────

const state: {
  // Map sessionId → users[] for getUsersWithTelegramDefaultSession.
  sessionUsers: Map<string, Array<{ id: string; telegram_chat_id: number }>>;
  // Recorded sendMessage calls (chat + text).
  sends: Array<{ chat: number | string; text: string; at: number }>;
  // Optional behavior knob for sendMessage.
  sendImpl: ((chat: number | string, text: string) => Promise<void>) | null;
} = {
  sessionUsers: new Map(),
  sends: [],
  sendImpl: null,
};

// ── Mocks ─────────────────────────────────────────────────────────────────

// Load the REAL modules first via cache-busted query so we can spread the
// real exports and override only what the bridge tests need. Without this,
// mock.module() replaces the entire module — and Bun's mock.module is
// process-wide, so other test files that import unmocked exports (e.g.
// telegram-webhook.test.ts → commands.ts → findUserByLinkCode) break.
const _realDal = await import(`../src/db/dal.ts?nomock=${Date.now()}`);
const _realClient = await import(`../src/telegram/client.ts?nomock=${Date.now()}`);

mock.module("../src/db/dal.ts", () => ({
  ..._realDal,
  getUsersWithTelegramDefaultSession: async (sessionId: string) => {
    return state.sessionUsers.get(sessionId) ?? [];
  },
}));

mock.module("../src/telegram/client.ts", () => ({
  ..._realClient,
  // Only override the network-touching helper. Keep real `escapeMarkdownV2`
  // and `splitForTelegram` (Bun mock.module is process-wide; stubbing them
  // here used to leak into telegram-client.test.ts).
  sendMessage: async (chatId: number | string, text: string) => {
    if (state.sendImpl) {
      await state.sendImpl(chatId, text);
    }
    state.sends.push({ chat: chatId, text, at: Date.now() });
  },
}));

// ── Imports (must come AFTER mock.module) ──────────────────────────────────

let emitAssistantMessageFinal: typeof import("../src/events/assistant-events.ts").emitAssistantMessageFinal;
let _resetEvents: typeof import("../src/events/assistant-events.ts")._resetAssistantEventsForTests;
let startTelegramBridge: typeof import("../src/telegram/bridge.ts").startTelegramBridge;
let _stopBridge: typeof import("../src/telegram/bridge.ts")._stopTelegramBridgeForTests;

beforeAll(async () => {
  ({ emitAssistantMessageFinal, _resetAssistantEventsForTests: _resetEvents } = await import(
    "../src/events/assistant-events.ts"
  ));
  ({ startTelegramBridge, _stopTelegramBridgeForTests: _stopBridge } = await import(
    "../src/telegram/bridge.ts"
  ));
});

beforeEach(() => {
  state.sessionUsers.clear();
  state.sends.length = 0;
  state.sendImpl = null;
  _stopBridge();
  _resetEvents();
});

afterEach(() => {
  _stopBridge();
  _resetEvents();
});


// Yield a few microtask + macrotask ticks so the bridge's async listener,
// DAL lookup, and per-chat queue have time to drain.
async function settle(ticks = 8): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe("Telegram outbound bridge", () => {
  test("forwards final assistant message to linked user's chat", async () => {
    state.sessionUsers.set("sess_A", [{ id: "u1", telegram_chat_id: 1000 }]);
    startTelegramBridge();

    emitAssistantMessageFinal({
      sessionId: "sess_A",
      userId: "u1",
      text: "hello from claude",
    });
    await settle();

    expect(state.sends).toHaveLength(1);
    expect(state.sends[0]).toMatchObject({ chat: 1000, text: "hello from claude" });
  });

  test("no users with matching default-session → no send", async () => {
    // sess_X has no rows.
    state.sessionUsers.set("sess_other", [{ id: "u2", telegram_chat_id: 2000 }]);
    startTelegramBridge();

    emitAssistantMessageFinal({
      sessionId: "sess_X",
      userId: "u-anon",
      text: "should not deliver",
    });
    await settle();

    expect(state.sends).toHaveLength(0);
  });

  test("user's default-session points elsewhere → no send for unrelated session", async () => {
    // Only sess_B has the user; emit for sess_C → DAL returns [].
    state.sessionUsers.set("sess_B", [{ id: "u3", telegram_chat_id: 3000 }]);
    startTelegramBridge();

    emitAssistantMessageFinal({
      sessionId: "sess_C",
      userId: "u3",
      text: "wrong session",
    });
    await settle();

    expect(state.sends).toHaveLength(0);
  });

  test("sendMessage throws → bridge logs and continues; next event still fires", async () => {
    state.sessionUsers.set("sess_D", [{ id: "u4", telegram_chat_id: 4000 }]);
    let calls = 0;
    state.sendImpl = async () => {
      calls++;
      if (calls === 1) throw new Error("simulated 429");
    };
    startTelegramBridge();

    emitAssistantMessageFinal({ sessionId: "sess_D", userId: "u4", text: "first" });
    await settle();
    emitAssistantMessageFinal({ sessionId: "sess_D", userId: "u4", text: "second" });
    await settle();

    // First call threw before recording; second succeeded and recorded.
    expect(calls).toBe(2);
    expect(state.sends).toHaveLength(1);
    expect(state.sends[0].text).toBe("second");
  });

  test("forwards long text via sendMessage (split handled inside client.ts)", async () => {
    state.sessionUsers.set("sess_E", [{ id: "u5", telegram_chat_id: 5000 }]);
    startTelegramBridge();

    const big = "x".repeat(10_000);
    emitAssistantMessageFinal({ sessionId: "sess_E", userId: "u5", text: big });
    await settle();

    // Bridge calls sendMessage once with the full text; client.ts owns split.
    // The mock collapses splitForTelegram → single chunk so we see exactly 1.
    expect(state.sends).toHaveLength(1);
    expect(state.sends[0].text.length).toBe(10_000);
  });

  test("per-chat serialization: two rapid events for the same chat are ordered", async () => {
    state.sessionUsers.set("sess_F", [{ id: "u6", telegram_chat_id: 6000 }]);
    const order: string[] = [];
    state.sendImpl = async (_chat, text) => {
      // First send blocks long enough that the second is queued behind it.
      if (text === "first") await new Promise((r) => setTimeout(r, 25));
      order.push(text);
    };
    startTelegramBridge();

    emitAssistantMessageFinal({ sessionId: "sess_F", userId: "u6", text: "first" });
    emitAssistantMessageFinal({ sessionId: "sess_F", userId: "u6", text: "second" });
    await settle(20); // > 25ms total

    expect(order).toEqual(["first", "second"]);
    expect(state.sends.map((s) => s.text)).toEqual(["first", "second"]);
  });

  test("startTelegramBridge is idempotent — double start does not double-send", async () => {
    state.sessionUsers.set("sess_G", [{ id: "u7", telegram_chat_id: 7000 }]);
    startTelegramBridge();
    startTelegramBridge();
    startTelegramBridge();

    emitAssistantMessageFinal({ sessionId: "sess_G", userId: "u7", text: "once" });
    await settle();

    expect(state.sends).toHaveLength(1);
  });
});

// ── Token-unset gate ──────────────────────────────────────────────────────
//
// The bridge module reads `config.telegram.botToken` at startTelegramBridge()
// call time. To exercise the disabled path we mock the config module BEFORE
// re-importing a fresh bridge instance. Done in an isolated describe block
// so we don't pollute the main tests.

describe("Telegram outbound bridge — disabled when token unset", () => {
  test("no listener registered when botToken is empty", async () => {
    // Mutate the live config singleton instead of mock.module(config) —
    // mock.module is process-wide and can't safely be unset, which leaks
    // an empty botToken into other test files (notably
    // telegram-webhook.test.ts which expects a non-empty token).
    // Use defineProperty so this works even if some other test has frozen
    // the config object.
    const { config } = await import("../src/config.ts");
    const _origBotToken = config.telegram.botToken;
    Object.defineProperty(config.telegram, "botToken", {
      value: "",
      writable: true,
      configurable: true,
    });
    const _restoreConfig = () => {
      Object.defineProperty(config.telegram, "botToken", {
        value: _origBotToken,
        writable: true,
        configurable: true,
      });
    };

    // Re-import a fresh copy of the bridge so it sees the empty token.
    delete require.cache?.[require.resolve?.("../src/telegram/bridge.ts") ?? ""];
    const freshBridge = await import("../src/telegram/bridge.ts?disabled=1" as any).catch(async () =>
      import("../src/telegram/bridge.ts")
    );

    // Reset events bus so any prior listener from the previous describe is gone.
    _resetEvents();

    freshBridge.startTelegramBridge();

    emitAssistantMessageFinal({ sessionId: "sess_Z", userId: "uZ", text: "ignored" });
    await settle();

    expect(state.sends).toHaveLength(0);
    _restoreConfig();
  });
});
