/**
 * Phase 12 UX pass — dispatchToSession storage shape.
 *
 * Verifies storedContent no longer carries the legacy "[telegram] " prefix.
 * Mocks DB + cost-cap + session-queue + ws/registry.
 */
import { describe, test, expect, beforeEach, mock } from "bun:test";

const inserted: Array<{ sessionId: string; role: string; content: string }> = [];
const sent: Array<any> = [];

const state = {
  overCap: false,
  channelPresent: true,
};

mock.module("../src/db/dal.ts", () => ({
  insertMessage: async (sessionId: string, role: string, content: string) => {
    inserted.push({ sessionId, role, content });
    return { id: "m-1", created_at: "2026-05-28T00:00:00Z" };
  },
}));

mock.module("../src/db/postgres.ts", () => ({
  sql: async () => [{ cap: "10.00", tz: "UTC" }],
}));

mock.module("../src/db/scheduled-tasks-dal.ts", () => ({
  sumTodayCostForUser: async () => (state.overCap ? 999 : 0),
}));

mock.module("../src/ws/registry.ts", () => ({
  getChannel: () =>
    state.channelPresent
      ? { ws: { send: (s: string) => { sent.push(JSON.parse(s)); } }, userId: "u", sessionId: "s" }
      : undefined,
  broadcastToSubscribers: () => {},
}));

mock.module("../src/scheduler/session-queue.ts", () => ({
  enqueue: () => "dispatched",
  abandon: () => {},
}));

const { dispatchToSession } = await import("../src/telegram/dispatch.ts");

beforeEach(() => {
  inserted.length = 0;
  sent.length = 0;
  state.overCap = false;
  state.channelPresent = true;
});

describe("dispatchToSession storedContent", () => {
  test("stores raw text without [telegram] prefix", async () => {
    const r = await dispatchToSession({
      userId: "u",
      sessionId: "s",
      chatId: 1,
      updateId: 1,
      text: "hello world",
    });
    expect(r.kind).toBe("dispatched");
    expect(inserted.length).toBe(1);
    expect(inserted[0]!.content).toBe("hello world");
    expect(inserted[0]!.content.startsWith("[telegram]")).toBe(false);
  });

  test("agent socket payload also drops the prefix (content is raw)", async () => {
    await dispatchToSession({
      userId: "u",
      sessionId: "s",
      chatId: 1,
      updateId: 2,
      text: "ship it",
    });
    expect(sent[0]?.type).toBe("user_message");
    expect(sent[0]?.content).toBe("ship it");
  });
});
