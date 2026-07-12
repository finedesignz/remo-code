/**
 * Telegram outbound — collapse the "working…" agent-activity feed into a NATIVE
 * expandable blockquote (Bot API 7.4+, MarkdownV2 `**>…**`).
 *
 * Rides the FLAG-OFF stream-json event-bus source — the one that is actually LIVE
 * in prod (`REMO_TELEGRAM_TRANSCRIPT_TAIL` stays OFF in the Coolify hub). DAL +
 * client mocked; no DB, no network.
 *
 * SAFETY INVARIANT under test: permission prompts and `user_question` prompts are
 * NEVER collapsed — a buried approval prompt is a broken product.
 *
 * The `editMessageText` "message is not modified" 400 → success path is covered in
 * `telegram-client-fallback.test.ts` (the shared client owns that behavior).
 */
import { describe, test, expect, beforeAll, beforeEach, mock } from "bun:test";

// Set env BEFORE config.ts loads. Flag-OFF (default) → stream-json event-bus source.
process.env.TELEGRAM_BOT_TOKEN = "fake-bot-token-collapse";
process.env.TELEGRAM_WEBHOOK_SECRET = "test-secret-must-be-at-least-16-chars";
process.env.TELEGRAM_BOT_USERNAME = "remocode_test_bot";

/** The MarkdownV2 expandable-blockquote opener. */
const EXPANDABLE_OPEN = "**>";

const state: {
  sessionUsers: Map<string, Array<{ id: string; telegram_chat_id: number }>>;
  mdSends: Array<{ chat: number | string; text: string }>;
  edits: Array<{ chat: number | string; messageId: number; text: string }>;
  keyboardSends: Array<{ chat: number | string; text: string; keyboard: any }>;
} = { sessionUsers: new Map(), mdSends: [], edits: [], keyboardSends: [] };

const _realDal = await import(`../src/db/dal.ts?nomock=${Date.now()}`);
const _realClient = await import(`../src/telegram/client.ts?nomock=${Date.now()}`);

mock.module("../src/db/dal.ts", () => ({
  ..._realDal,
  getUsersWithTelegramDefaultSession: async (sessionId: string) =>
    state.sessionUsers.get(sessionId) ?? [],
}));

let nextMessageId = 100;
mock.module("../src/telegram/client.ts", () => ({
  ..._realClient,
  sendMessageMd: async (chatId: number | string, text: string) => {
    state.mdSends.push({ chat: chatId, text });
    return { message_id: nextMessageId++ };
  },
  editMessageTextMd: async (chatId: number | string, messageId: number, text: string) => {
    state.edits.push({ chat: chatId, messageId, text });
  },
  sendMessageWithKeyboard: async (chatId: number | string, text: string, keyboard: any) => {
    state.keyboardSends.push({ chat: chatId, text, keyboard });
    return { message_id: nextMessageId++ };
  },
  sendChatAction: async () => {},
  setMyCommands: async () => {},
  setWebhook: async () => {},
}));

let emitSessionActivity: typeof import("../src/events/session-activity-events.ts").emitSessionActivity;
let _resetActivity: typeof import("../src/events/session-activity-events.ts")._resetSessionActivityEventsForTests;
let emitAssistantMessageFinal: typeof import("../src/events/assistant-events.ts").emitAssistantMessageFinal;
let _resetAssistant: typeof import("../src/events/assistant-events.ts")._resetAssistantEventsForTests;
let emitPermissionPending: typeof import("../src/events/permission-events.ts").emitPermissionPending;
let _resetPermission: typeof import("../src/events/permission-events.ts")._resetPermissionEventsForTests;
let emitQuestionPending: typeof import("../src/events/question-events.ts").emitQuestionPending;
let _resetQuestion: typeof import("../src/events/question-events.ts")._resetQuestionEventsForTests;
let startTelegramBridge: typeof import("../src/telegram/bridge.ts").startTelegramBridge;
let _stopBridge: typeof import("../src/telegram/bridge.ts")._stopTelegramBridgeForTests;
let expandableQuote: typeof import("../src/telegram/bridge.ts").expandableQuote;

const SESSION = "11111111-1111-4111-8111-111111111111";
const CHAT = 555;

beforeAll(async () => {
  ({ emitSessionActivity, _resetSessionActivityEventsForTests: _resetActivity } = await import(
    "../src/events/session-activity-events.ts"
  ));
  ({ emitAssistantMessageFinal, _resetAssistantEventsForTests: _resetAssistant } = await import(
    "../src/events/assistant-events.ts"
  ));
  ({ emitPermissionPending, _resetPermissionEventsForTests: _resetPermission } = await import(
    "../src/events/permission-events.ts"
  ));
  ({ emitQuestionPending, _resetQuestionEventsForTests: _resetQuestion } = await import(
    "../src/events/question-events.ts"
  ));
  ({ startTelegramBridge, _stopTelegramBridgeForTests: _stopBridge, expandableQuote } = await import(
    "../src/telegram/bridge.ts"
  ));
});

beforeEach(() => {
  state.sessionUsers.clear();
  state.mdSends.length = 0;
  state.edits.length = 0;
  state.keyboardSends.length = 0;
  _stopBridge();
  _resetActivity();
  _resetAssistant();
  _resetPermission();
  _resetQuestion();
  state.sessionUsers.set(SESSION, [{ id: "user-1", telegram_chat_id: CHAT }]);
  startTelegramBridge();
});

/** Let the bridge's per-chat serial queue drain. */
async function drain(): Promise<void> {
  for (let i = 0; i < 12; i++) await new Promise((r) => setTimeout(r, 0));
}

describe("expandableQuote", () => {
  test("emits Bot-API-7.4 expandable blockquote markup and escapes content", () => {
    expect(expandableQuote(["a", "b"])).toBe("**>a\n>b**");
    // Reserved MarkdownV2 chars inside a line are escaped, not left to break markup.
    expect(expandableQuote(["run x-1."])).toBe("**>run x\\-1\\.**");
  });
});

describe("activity collapsing (working message)", () => {
  test("tool activity goes INSIDE an expandable blockquote, with a summary line outside", async () => {
    emitSessionActivity({ sessionId: SESSION, kind: "tool_use", toolName: "Bash", detail: "ls" } as any);
    await drain();

    expect(state.mdSends.length).toBe(1);
    const text = state.mdSends[0]!.text;
    expect(text).toContain(EXPANDABLE_OPEN);
    // Summary is OUTSIDE the blockquote (before it) so it reads while collapsed.
    const head = text.slice(0, text.indexOf(EXPANDABLE_OPEN));
    expect(head).toContain("Working");
    expect(head).toContain("1 tool call");
    // The tool one-liner itself is inside the collapsed block.
    expect(text.slice(text.indexOf(EXPANDABLE_OPEN))).toContain("Bash");
    // Well-formed: opens with **> and closes with **.
    expect(text.endsWith("**")).toBe(true);
  });
});

describe("final answer", () => {
  test("is NOT collapsed — it renders outside the blockquote, above the collapsed activity", async () => {
    emitSessionActivity({ sessionId: SESSION, kind: "tool_use", toolName: "Bash", detail: "ls" } as any);
    await drain();
    emitAssistantMessageFinal({ sessionId: SESSION, text: "Here is the answer" } as any);
    await drain();

    expect(state.edits.length).toBe(1);
    const text = state.edits[0]!.text;
    const quoteAt = text.indexOf(EXPANDABLE_OPEN);
    expect(quoteAt).toBeGreaterThan(-1);
    // The answer precedes the blockquote — i.e. it is never inside it.
    expect(text.slice(0, quoteAt)).toContain("Here is the answer");
    expect(text.slice(quoteAt)).not.toContain("Here is the answer");
  });

  test("4096 overflow drops the collapsed tail rather than splitting the blockquote", async () => {
    emitSessionActivity({ sessionId: SESSION, kind: "tool_use", toolName: "Bash", detail: "ls" } as any);
    await drain();
    state.mdSends.length = 0; // drop the "Working…" message — assert on the FINAL only.

    const long = "x".repeat(4090);
    emitAssistantMessageFinal({ sessionId: SESSION, text: long } as any);
    await drain();

    const final = [...state.edits, ...state.mdSends].map((m) => m.text);
    expect(final.length).toBe(1);
    // Answer alone: the blockquote tail is dropped, never split across messages.
    expect(final[0]).not.toContain(EXPANDABLE_OPEN);
    expect(final[0]).toContain("xxx");
  });
});

describe("SAFETY: approval-class prompts are never collapsed", () => {
  test("permission prompt is its own visible message with Approve/Deny — no blockquote", async () => {
    emitPermissionPending({
      sessionId: SESSION,
      requestId: "req-1",
      toolName: "Bash",
      toolInput: { command: "rm -rf /tmp/x" },
    } as any);
    await drain();

    expect(state.keyboardSends.length).toBe(1);
    const { text, keyboard } = state.keyboardSends[0]!;
    expect(text).not.toContain(EXPANDABLE_OPEN);
    expect(text).toContain("Approval needed");
    expect(JSON.stringify(keyboard)).toContain("Approve");
    expect(JSON.stringify(keyboard)).toContain("Deny");
  });

  test("user_question prompt is its own visible message with option buttons — no blockquote", async () => {
    emitQuestionPending({
      sessionId: SESSION,
      requestId: "req-2",
      question: "Which branch?",
      options: [{ label: "main" }, { label: "dev" }],
      isMultiSelect: false,
    } as any);
    await drain();

    expect(state.keyboardSends.length).toBe(1);
    const { text, keyboard } = state.keyboardSends[0]!;
    expect(text).not.toContain(EXPANDABLE_OPEN);
    expect(text).toContain("Which branch");
    expect(JSON.stringify(keyboard)).toContain("main");
  });

  test("a permission prompt raised MID-TURN stays outside the working message's blockquote", async () => {
    emitSessionActivity({ sessionId: SESSION, kind: "tool_use", toolName: "Read", detail: "a.ts" } as any);
    await drain();
    emitPermissionPending({
      sessionId: SESSION,
      requestId: "req-3",
      toolName: "Bash",
      toolInput: { command: "deploy" },
    } as any);
    await drain();

    // The prompt is a SEPARATE message, not folded into the collapsed working msg.
    expect(state.keyboardSends.length).toBe(1);
    expect(state.keyboardSends[0]!.text).not.toContain(EXPANDABLE_OPEN);
    for (const e of state.edits) expect(e.text).not.toContain("Approval needed");
  });
});
