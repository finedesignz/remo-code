/**
 * Deploy-safety gate — Telegram OUTBOUND source is selected by REMO_PTY_INTERACTIVE.
 *
 * Prod default (flag OFF) MUST use the stream-json `assistant_message:final`
 * event-bus consumer — the only host-agnostic source that works in the split
 * hub/supervisor Coolify topology (the hub has no local CLI transcript files).
 *
 * This file pins the flag OFF and proves:
 *   (a) emitting on the event bus forwards to the matching telegram-default user
 *   (b) tool_use activity events render the working message
 *   (c) permission-pending events surface an inline Approve/Deny prompt
 *   (d) ensureSessionSubscribed() is a NO-OP (no transcript source is opened)
 *
 * The flag-ON (transcript-tail) source is proven in
 * telegram-output-from-transcript.test.ts.
 */
import { describe, test, expect, beforeAll, beforeEach, afterEach, mock } from "bun:test";

process.env.TELEGRAM_BOT_TOKEN = "fake-bot-token-gate";
process.env.TELEGRAM_WEBHOOK_SECRET = "test-secret-must-be-at-least-16-chars";
// PROD DEFAULT: stream-json event-bus outbound source.
process.env.REMO_PTY_INTERACTIVE = "0";

const state: {
  sessionUsers: Map<string, Array<{ id: string; telegram_chat_id: number }>>;
  sends: Array<{ chat: number | string; text: string }>;
  edits: Array<{ chat: number | string; messageId: number; text: string }>;
  keyboards: Array<{ chat: number | string; text: string }>;
  chatActions: Array<number | string>;
} = { sessionUsers: new Map(), sends: [], edits: [], keyboards: [], chatActions: [] };

const _realDal = await import(`../src/db/dal.ts?nomock=${Date.now()}`);
const _realClient = await import(`../src/telegram/client.ts?nomock=${Date.now()}`);

mock.module("../src/db/dal.ts", () => ({
  ..._realDal,
  getUsersWithTelegramDefaultSession: async (sessionId: string) =>
    state.sessionUsers.get(sessionId) ?? [],
}));

mock.module("../src/telegram/client.ts", () => ({
  ..._realClient,
  sendMessageMd: async (chatId: number | string, text: string) => {
    state.sends.push({ chat: chatId, text });
    return { message_id: 99 };
  },
  editMessageTextMd: async (chatId: number | string, messageId: number, text: string) => {
    state.edits.push({ chat: chatId, messageId, text });
  },
  sendMessageWithKeyboard: async (chatId: number | string, text: string) => {
    state.keyboards.push({ chat: chatId, text });
    return { message_id: 77 };
  },
  sendChatAction: async (chatId: number | string) => {
    state.chatActions.push(chatId);
  },
  setMyCommands: async () => {},
  setWebhook: async () => {},
}));

let bridge: typeof import("../src/telegram/bridge.ts");
let config: typeof import("../src/config.ts").config;
let assistantEvents: typeof import("../src/events/assistant-events.ts");
let activityEvents: typeof import("../src/events/session-activity-events.ts");
let permissionEvents: typeof import("../src/events/permission-events.ts");
let manager: typeof import("../src/telegram/transcript/manager.ts");

beforeAll(async () => {
  bridge = await import("../src/telegram/bridge.ts");
  config = (await import("../src/config.ts")).config;
  assistantEvents = await import("../src/events/assistant-events.ts");
  activityEvents = await import("../src/events/session-activity-events.ts");
  permissionEvents = await import("../src/events/permission-events.ts");
  manager = await import("../src/telegram/transcript/manager.ts");
});

beforeEach(() => {
  state.sessionUsers.clear();
  state.sends.length = 0;
  state.edits.length = 0;
  state.keyboards.length = 0;
  state.chatActions.length = 0;
  bridge._stopTelegramBridgeForTests();
  assistantEvents._resetAssistantEventsForTests?.();
  manager._resetTranscriptManagerForTests();
  manager._setContextResolverForTests(null);
});

afterEach(() => {
  bridge._stopTelegramBridgeForTests();
});

async function settle(ticks = 10): Promise<void> {
  for (let i = 0; i < ticks; i++) await new Promise((r) => setTimeout(r, 0));
}

describe("flag OFF (prod default) → stream-json event-bus outbound", () => {
  test("config.ptyInteractive is false in prod default", () => {
    expect(config.ptyInteractive).toBe(false);
  });

  test("assistant_message:final on the event bus forwards to the TG user", async () => {
    state.sessionUsers.set("sess_X", [{ id: "u1", telegram_chat_id: 111 }]);
    bridge.startTelegramBridge();
    assistantEvents.emitAssistantMessageFinal({ sessionId: "sess_X", userId: "u1", text: "hi from bus" });
    await settle();
    expect(state.sends.length).toBe(1);
    expect(state.sends[0].chat).toBe(111);
    expect(state.sends[0].text).toContain("hi from bus");
  });

  test("tool_use activity renders the working message", async () => {
    state.sessionUsers.set("sess_Y", [{ id: "u2", telegram_chat_id: 222 }]);
    bridge.startTelegramBridge();
    activityEvents.emitSessionActivity({ sessionId: "sess_Y", userId: "u2", kind: "tool_use", toolName: "Edit", detail: "foo.ts" });
    await settle();
    expect(state.sends.some((s) => s.chat === 222 && s.text.includes("Working"))).toBe(true);
  });

  test("permission_request:pending surfaces an inline Approve/Deny prompt", async () => {
    state.sessionUsers.set("sess_Z", [{ id: "u3", telegram_chat_id: 333 }]);
    bridge.startTelegramBridge();
    permissionEvents.emitPermissionPending({
      sessionId: "sess_Z",
      userId: "u3",
      requestId: "req-1",
      toolName: "Bash",
      toolInput: { command: "ls" },
    });
    await settle();
    expect(state.keyboards.some((k) => k.chat === 333 && k.text.includes("Approval needed"))).toBe(true);
  });

  test("ensureSessionSubscribed is a NO-OP (no transcript source opened)", async () => {
    // Even with a resolver that WOULD resolve, the flag-OFF path must not tail.
    manager._setContextResolverForTests(async (sessionId: string) => ({
      sessionId,
      projectDir: "/x",
      cliKind: "claude" as const,
      transcriptPath: "/nonexistent/x.jsonl",
      codexRolloutId: null,
    }));
    bridge.startTelegramBridge();
    await bridge.ensureSessionSubscribed("sess_NO");
    await settle();
    expect(manager.transcriptMode("sess_NO")).toBeNull();
  });
});
