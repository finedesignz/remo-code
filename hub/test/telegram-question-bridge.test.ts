/**
 * Telegram inline multiple-choice questions (AskUserQuestion) — outbound bridge.
 *
 * Re-homed from the deleted event-bus `telegram-bridge.test.ts` (Phase 20 replaced
 * that file with `telegram-output-from-transcript.test.ts`). The MCQ question flow
 * rides the FLAG-OFF stream-json event-bus source: `ws/agent.ts` emits
 * `user_question:pending`, the bridge renders one inline button per option, and a
 * tap resolves to the chosen option label. Mirrors the mock conventions of the
 * surviving telegram bridge tests (DAL + client mocked, no DB, no network).
 */
import { describe, test, expect, beforeAll, beforeEach, afterEach, mock } from "bun:test";

// Set env BEFORE config.ts loads. Flag-OFF (default) → stream-json event-bus source.
process.env.TELEGRAM_BOT_TOKEN = "fake-bot-token-question";
process.env.TELEGRAM_WEBHOOK_SECRET = "test-secret-must-be-at-least-16-chars";
process.env.TELEGRAM_BOT_USERNAME = "remocode_test_bot";

const state: {
  sessionUsers: Map<string, Array<{ id: string; telegram_chat_id: number }>>;
  keyboardSends: Array<{ chat: number | string; text: string; keyboard: any }>;
} = { sessionUsers: new Map(), keyboardSends: [] };

const _realDal = await import(`../src/db/dal.ts?nomock=${Date.now()}`);
const _realClient = await import(`../src/telegram/client.ts?nomock=${Date.now()}`);

mock.module("../src/db/dal.ts", () => ({
  ..._realDal,
  getUsersWithTelegramDefaultSession: async (sessionId: string) =>
    state.sessionUsers.get(sessionId) ?? [],
}));

mock.module("../src/telegram/client.ts", () => ({
  ..._realClient,
  sendMessageWithKeyboard: async (chatId: number | string, text: string, keyboard: any) => {
    state.keyboardSends.push({ chat: chatId, text, keyboard });
    return { message_id: 42 };
  },
  // Plain MarkdownV2 send (free-form question fallback path).
  sendMessageMd: async () => ({ message_id: 43 }),
  setMyCommands: async () => {},
  setWebhook: async () => {},
}));

let emitQuestionPending: typeof import("../src/events/question-events.ts").emitQuestionPending;
let _resetQuestionEvents: typeof import("../src/events/question-events.ts")._resetQuestionEventsForTests;
let parseQuestionCallback: typeof import("../src/telegram/question-approvals.ts").parseQuestionCallback;
let takeQuestionOption: typeof import("../src/telegram/question-approvals.ts").takeQuestionOption;
let _resetQuestionPrompts: typeof import("../src/telegram/question-approvals.ts")._resetQuestionPromptsForTests;
let startTelegramBridge: typeof import("../src/telegram/bridge.ts").startTelegramBridge;
let _stopBridge: typeof import("../src/telegram/bridge.ts")._stopTelegramBridgeForTests;

beforeAll(async () => {
  ({ emitQuestionPending, _resetQuestionEventsForTests: _resetQuestionEvents } = await import(
    "../src/events/question-events.ts"
  ));
  ({ parseQuestionCallback, takeQuestionOption, _resetQuestionPromptsForTests: _resetQuestionPrompts } =
    await import("../src/telegram/question-approvals.ts"));
  ({ startTelegramBridge, _stopTelegramBridgeForTests: _stopBridge } = await import(
    "../src/telegram/bridge.ts"
  ));
});

beforeEach(() => {
  state.sessionUsers.clear();
  state.keyboardSends.length = 0;
  _stopBridge();
  _resetQuestionEvents();
  _resetQuestionPrompts();
});

afterEach(() => {
  _stopBridge();
  _resetQuestionEvents();
  _resetQuestionPrompts();
});

async function settle(ticks = 8): Promise<void> {
  for (let i = 0; i < ticks; i++) await new Promise((r) => setTimeout(r, 0));
}

describe("Telegram outbound bridge — multiple-choice questions", () => {
  test("emitQuestionPending → one inline button per option with qa: callback data", async () => {
    state.sessionUsers.set("sess_Q", [{ id: "uq1", telegram_chat_id: 7000 }]);
    startTelegramBridge();

    emitQuestionPending({
      sessionId: "sess_Q",
      userId: "uq1",
      requestId: "req-q-1",
      question: "Which database?",
      options: [{ label: "Postgres" }, { label: "SQLite" }],
      isMultiSelect: false,
    });
    await settle();

    expect(state.keyboardSends).toHaveLength(1);
    const ks = state.keyboardSends[0];
    expect(ks.chat).toBe(7000);
    // One row per option, one button per row.
    expect(ks.keyboard).toHaveLength(2);
    expect(ks.keyboard[0][0].text).toBe("Postgres");
    expect(ks.keyboard[1][0].text).toBe("SQLite");
    // Callback data is the qa: token codec and resolves to the chosen label.
    const cb0 = parseQuestionCallback(ks.keyboard[0][0].callback_data);
    expect(cb0).not.toBeNull();
    const chosen = takeQuestionOption(cb0!.token, "uq1");
    expect(chosen?.label).toBe("Postgres");
    expect(chosen?.sessionId).toBe("sess_Q");
    expect(chosen?.requestId).toBe("req-q-1");
  });

  test("no matching default-session → no question prompt sent", async () => {
    state.sessionUsers.set("sess_other", [{ id: "u2", telegram_chat_id: 2000 }]);
    startTelegramBridge();
    emitQuestionPending({
      sessionId: "sess_none",
      userId: "u2",
      requestId: "req-q-2",
      question: "q?",
      options: [{ label: "A" }],
      isMultiSelect: false,
    });
    await settle();
    expect(state.keyboardSends).toHaveLength(0);
  });
});
