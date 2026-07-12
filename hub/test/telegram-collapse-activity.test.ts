/**
 * Telegram outbound — collapse the "working…" agent-activity feed into a NATIVE
 * expandable blockquote, sent with **HTML parse_mode** (`<blockquote expandable>`).
 *
 * Rides the FLAG-OFF stream-json event-bus source — the one that is actually LIVE
 * in prod (`REMO_TELEGRAM_TRANSCRIPT_TAIL` stays OFF in the Coolify hub). DAL +
 * client mocked; no DB, no network.
 *
 * NOTE: these are STRUCTURAL tests — they pin the wiring (what goes inside the
 * block, what stays outside, what is never collapsed). They do NOT prove Telegram
 * accepts the markup; the markup itself is proven against the LIVE Bot API by
 * `tools/telegram-render-probe.ts` (see docs/telegram-bridge.md).
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

/** The tag Telegram renders as a collapsed, tap-to-expand block. */
const EXPANDABLE_OPEN = "<blockquote expandable>";

const state: {
  sessionUsers: Map<string, Array<{ id: string; telegram_chat_id: number }>>;
  htmlSends: Array<{ chat: number | string; text: string }>;
  edits: Array<{ chat: number | string; messageId: number; text: string }>;
  keyboardSends: Array<{ chat: number | string; text: string; keyboard: any }>;
} = { sessionUsers: new Map(), htmlSends: [], edits: [], keyboardSends: [] };

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
  sendMessageHtml: async (chatId: number | string, text: string) => {
    state.htmlSends.push({ chat: chatId, text });
    return { message_id: nextMessageId++ };
  },
  editMessageTextHtml: async (chatId: number | string, messageId: number, text: string) => {
    state.edits.push({ chat: chatId, messageId, text });
  },
  sendMessageMd: async () => ({ message_id: nextMessageId++ }),
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
let activitySummary: typeof import("../src/telegram/bridge.ts").activitySummary;
let renderWorking: typeof import("../src/telegram/bridge.ts").renderWorking;
let renderFinal: typeof import("../src/telegram/bridge.ts").renderFinal;
let splitHtmlForTelegram: typeof import("../src/telegram/client.ts").splitHtmlForTelegram;

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
  ({
    startTelegramBridge,
    _stopTelegramBridgeForTests: _stopBridge,
    expandableQuote,
    activitySummary,
    renderWorking,
    renderFinal,
  } = await import("../src/telegram/bridge.ts"));
  splitHtmlForTelegram = (_realClient as any).splitHtmlForTelegram;
});

beforeEach(() => {
  state.sessionUsers.clear();
  state.htmlSends.length = 0;
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

describe("expandableQuote (HTML)", () => {
  test("emits a single <blockquote expandable> tag and escapes & < >", () => {
    expect(expandableQuote(["a", "b"])).toBe("<blockquote expandable>a\nb</blockquote>");
    expect(expandableQuote(["a <b> & c"])).toBe(
      "<blockquote expandable>a &lt;b&gt; &amp; c</blockquote>",
    );
  });

  test("MarkdownV2-hostile characters are INERT in HTML — no escaping needed, no broken block", () => {
    const hostile = "_ * [ ] ( ) ~ ` # + - = | { } . !";
    expect(expandableQuote([hostile])).toBe(`<blockquote expandable>${hostile}</blockquote>`);
  });

  test("a leading '>' in a tool detail cannot break the block (it becomes &gt;)", () => {
    // Exactly the class of bug MarkdownV2's line-prefix blockquote invites.
    const out = expandableQuote(["> not a quote marker"]);
    expect(out).toBe("<blockquote expandable>&gt; not a quote marker</blockquote>");
    expect(out.split("<blockquote").length - 1).toBe(1);
  });
});

describe("activitySummary", () => {
  test("elapsed seconds are deterministic (nowMs is injected)", () => {
    expect(activitySummary(1, 1_000, 1_000)).toBe("🔧 1 tool call · 0s");
    expect(activitySummary(4, 1_000, 13_400)).toBe("🔧 4 tool calls · 12s");
  });
});

describe("splitHtmlForTelegram", () => {
  test("never splits an HTML entity in half", () => {
    // No whitespace anywhere → forces the hard-split fallback right through entities.
    const html = "&amp;".repeat(100); // 500 chars
    const chunks = splitHtmlForTelegram(html, 42);
    expect(chunks.join("")).toBe(html);
    for (const c of chunks) {
      expect(/&[a-zA-Z#0-9]*$/.test(c)).toBe(false); // no trailing half-entity
      expect(c.length).toBeLessThanOrEqual(42);
    }
  });
});

describe("activity collapsing (working message)", () => {
  test("tool activity goes INSIDE the expandable block, with a summary line outside", async () => {
    emitSessionActivity({ sessionId: SESSION, kind: "tool_use", toolName: "Bash", detail: "ls" } as any);
    await drain();

    expect(state.htmlSends.length).toBe(1);
    const text = state.htmlSends[0]!.text;
    expect(text).toContain(EXPANDABLE_OPEN);
    // Summary is OUTSIDE the block (before it) so it reads while collapsed.
    const head = text.slice(0, text.indexOf(EXPANDABLE_OPEN));
    expect(head).toContain("Working");
    expect(head).toContain("1 tool call");
    // The tool one-liner itself is inside the collapsed block.
    expect(text.slice(text.indexOf(EXPANDABLE_OPEN))).toContain("Bash");
    expect(text.endsWith("</blockquote>")).toBe(true);
  });
});

describe("final answer", () => {
  test("is NOT collapsed — it renders outside the block, above the collapsed activity", async () => {
    emitSessionActivity({ sessionId: SESSION, kind: "tool_use", toolName: "Bash", detail: "ls" } as any);
    await drain();
    emitAssistantMessageFinal({ sessionId: SESSION, text: "Here is the answer" } as any);
    await drain();

    expect(state.edits.length).toBe(1);
    const text = state.edits[0]!.text;
    const quoteAt = text.indexOf(EXPANDABLE_OPEN);
    expect(quoteAt).toBeGreaterThan(-1);
    // The answer precedes the block — i.e. it is never inside it.
    expect(text.slice(0, quoteAt)).toContain("Here is the answer");
    expect(text.slice(quoteAt)).not.toContain("Here is the answer");
  });

  test("4096 overflow drops the collapsed tail rather than splitting the blockquote", () => {
    const st = { lines: ["🔧 Bash ls"], toolCount: 1, startedAtMs: 0 };
    const long = "x".repeat(4090);
    const out = renderFinal(long, st, 0);
    expect(out).not.toContain(EXPANDABLE_OPEN);
    expect(out).toBe(long);
  });

  test("the 4096 check is measured on the ESCAPED string, not the raw text", () => {
    const st = { lines: ["🔧 Bash ls"], toolCount: 1, startedAtMs: 0 };
    // 1000 raw '&' → 5000 escaped chars: raw fits under 4096, escaped does not.
    const raw = "&".repeat(1000);
    const out = renderFinal(raw, st, 0);
    expect(out).not.toContain(EXPANDABLE_OPEN); // tail dropped on the ESCAPED length
    expect(out).toBe("&amp;".repeat(1000));
  });

  test("an over-cap answer is chunked entity-safely by the client splitter", () => {
    const raw = "&".repeat(2000); // 10_000 escaped chars — well over the cap
    const html = renderFinal(raw, undefined, 0);
    const chunks = splitHtmlForTelegram(html);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("")).toBe(html);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(4096);
      expect(/&[a-zA-Z#0-9]*$/.test(c)).toBe(false); // no half entity
    }
  });
});

describe("collapse flag off", () => {
  test("renderWorking falls back to the flat list when collapsing is disabled", async () => {
    const { config } = await import("../src/config.ts");
    const prev = config.telegram.collapseActivity;
    (config.telegram as any).collapseActivity = false;
    try {
      const out = renderWorking({ lines: ["🔧 Bash ls"], toolCount: 1, startedAtMs: 0 }, 0);
      expect(out).not.toContain(EXPANDABLE_OPEN);
      expect(out).toContain("🔧 Bash ls");
    } finally {
      (config.telegram as any).collapseActivity = prev;
    }
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
    expect(text).not.toContain("<blockquote");
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
    expect(text).not.toContain("<blockquote");
    expect(text).toContain("Which branch");
    expect(JSON.stringify(keyboard)).toContain("main");
  });

  test("a permission prompt raised MID-TURN stays outside the working message's block", async () => {
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
    expect(state.keyboardSends[0]!.text).not.toContain("<blockquote");
    for (const e of state.edits) expect(e.text).not.toContain("Approval needed");
  });
});
