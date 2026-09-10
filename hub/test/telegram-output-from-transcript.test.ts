/**
 * Phase 20 plan 02 — Telegram outbound bridge re-sourced from the transcript.
 *
 * The bridge consumes the normalized TranscriptEntry stream (NOT the deleted
 * assistant_message:final event bus). These tests drive the bridge's transcript
 * consumer + the per-session manager and assert:
 *   - a final assistant_text is sent to the matching telegram-default user
 *   - tool_use creates/edits the working message (existing UX preserved)
 *   - no streaming-delta path exists (the union has no partial kind)
 *   - the manager opens ONE source and fans entries to consumers
 */
import { describe, test, expect, beforeAll, beforeEach, afterEach, mock } from "bun:test";

process.env.TELEGRAM_BOT_TOKEN = "fake-bot-token-transcript";
process.env.TELEGRAM_WEBHOOK_SECRET = "test-secret-must-be-at-least-16-chars";
// Flag-ON: this suite exercises the transcript-tail outbound source, now gated on
// the DECOUPLED REMO_TELEGRAM_TRANSCRIPT_TAIL flag (independent of the web PTY flag).
// The flag-OFF (stream-json) source is covered by telegram-outbound-source-gate.test.ts.
process.env.REMO_TELEGRAM_TRANSCRIPT_TAIL = "1";

const state: {
  sessionUsers: Map<string, Array<{ id: string; telegram_chat_id: number }>>;
  sends: Array<{ chat: number | string; text: string }>;
  edits: Array<{ chat: number | string; messageId: number; text: string }>;
  chatActions: Array<number | string>;
} = { sessionUsers: new Map(), sends: [], edits: [], chatActions: [] };

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
  // The working/final messages are sent as HTML (collapsible activity blockquote).
  sendMessageHtml: async (chatId: number | string, text: string) => {
    state.sends.push({ chat: chatId, text });
    return { message_id: 99 };
  },
  editMessageTextHtml: async (chatId: number | string, messageId: number, text: string) => {
    state.edits.push({ chat: chatId, messageId, text });
  },
  sendChatAction: async (chatId: number | string) => {
    state.chatActions.push(chatId);
  },
  setMyCommands: async () => {},
  setWebhook: async () => {},
}));

let bridge: typeof import("../src/telegram/bridge.ts");
let manager: typeof import("../src/telegram/transcript/manager.ts");

beforeAll(async () => {
  bridge = await import("../src/telegram/bridge.ts");
  manager = await import("../src/telegram/transcript/manager.ts");
});

beforeEach(() => {
  state.sessionUsers.clear();
  state.sends.length = 0;
  state.edits.length = 0;
  state.chatActions.length = 0;
  bridge._stopTelegramBridgeForTests();
  manager._resetTranscriptManagerForTests();
  manager._setContextResolverForTests(null);
});

afterEach(() => {
  bridge._stopTelegramBridgeForTests();
  manager._resetTranscriptManagerForTests();
  manager._setContextResolverForTests(null);
});

async function settle(ticks = 10): Promise<void> {
  for (let i = 0; i < ticks; i++) await new Promise((r) => setTimeout(r, 0));
}

describe("bridge output sourced from TranscriptEntry (R-TG-04)", () => {
  test("assistant_text is sent to the matching telegram-default user", async () => {
    state.sessionUsers.set("sess_A", [{ id: "u1", telegram_chat_id: 111 }]);
    bridge._bridgeConsumerForTests({ kind: "assistant_text", sessionId: "sess_A", text: "hello" });
    await settle();
    expect(state.sends.length).toBe(1);
    expect(state.sends[0].chat).toBe(111);
    expect(state.sends[0].text).toContain("hello");
  });

  test("no matching user ⇒ no send", async () => {
    bridge._bridgeConsumerForTests({ kind: "assistant_text", sessionId: "sess_none", text: "x" });
    await settle();
    expect(state.sends.length).toBe(0);
  });

  test("tool_use creates a working message then assistant_text finalizes it (UX preserved)", async () => {
    state.sessionUsers.set("sess_B", [{ id: "u2", telegram_chat_id: 222 }]);
    bridge._bridgeConsumerForTests({ kind: "tool_use", sessionId: "sess_B", toolName: "Edit", detail: "foo.ts" });
    await settle();
    // working message sent + typing action fired
    expect(state.sends.length).toBe(1);
    expect(state.sends[0].text).toContain("Working");
    expect(state.chatActions.length).toBeGreaterThan(0);
    // final edits the working message
    bridge._bridgeConsumerForTests({ kind: "assistant_text", sessionId: "sess_B", text: "done" });
    await settle();
    expect(state.edits.some((e) => e.text.includes("done"))).toBe(true);
  });

  test("the TranscriptEntry union carries NO streaming-delta kind (T-20-04)", async () => {
    const mod = await import("../src/telegram/transcript/types.ts");
    expect(mod.TRANSCRIPT_ENTRY_KINDS).not.toContain("text_delta");
    expect(mod.TRANSCRIPT_ENTRY_KINDS).not.toContain("thinking");
  });
});

describe("the bridge supports BOTH outbound sources (flag-gated)", () => {
  // Phase 20 originally asserted the bridge no longer imports the event bus.
  // That regressed prod (the Coolify hub has no local CLI transcript files, so
  // the transcript tail emits nothing). The deploy-safe design keeps the
  // stream-json event-bus source as the flag-OFF prod default and uses the
  // transcript tail only under REMO_PTY_INTERACTIVE=1.
  test("bridge.ts references BOTH the event bus and the transcript manager", async () => {
    const src = await Bun.file(new URL("../src/telegram/bridge.ts", import.meta.url)).text();
    expect(src).toContain("onAssistantMessageFinal");
    expect(src).toMatch(/events\/assistant-events/);
    expect(src).toMatch(/transcript\/manager/);
  });
});

describe("transcript manager fans one source to many consumers (R-TG-04)", () => {
  test("ensureSessionSubscribed opens a source via the injected resolver", async () => {
    // Inject a resolver returning a claude ctx pointing at a temp transcript.
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(join(tmpdir(), "tg-mgr-"));
    const file = join(dir, "sess.jsonl");
    writeFileSync(
      file,
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "from-file" }] } }) + "\n",
    );
    manager._setContextResolverForTests(async (sessionId: string) => ({
      sessionId,
      projectDir: "/x",
      cliKind: "claude" as const,
      transcriptPath: file,
      codexRolloutId: null,
    }));
    state.sessionUsers.set("sess_C", [{ id: "u3", telegram_chat_id: 333 }]);

    bridge._setStartedForTests(true);
    await bridge.ensureSessionSubscribed("sess_C");
    await new Promise((r) => setTimeout(r, 800));
    await settle();
    expect(manager.transcriptMode("sess_C")).toBe("file");
    // text is MarkdownV2-escaped ("from\-file"); match on the unescaped token.
    expect(state.sends.some((s) => s.chat === 333 && s.text.includes("from") && s.text.includes("file"))).toBe(true);

    bridge.releaseSessionSubscription("sess_C");
    expect(manager.transcriptMode("sess_C")).toBeNull();
  });

  test("unresolvable session ⇒ ensureSessionSubscribed no-ops", async () => {
    manager._setContextResolverForTests(async () => null);
    bridge._setStartedForTests(true);
    await bridge.ensureSessionSubscribed("ghost");
    expect(manager.transcriptMode("ghost")).toBeNull();
  });
});
