/**
 * Telegram inbound dispatch — Round-2 pipeline migration.
 *
 * `dispatchToSession` is now an adapter over the shared `dispatch/` pipeline
 * with `store: null` (telegram writes no run row). These tests exercise the
 * null-store path end-to-end:
 *   - happy path: dispatched, raw text stored (no `[telegram] ` prefix), agent
 *     frame carries raw content + images.
 *   - cost-cap skip → `cost_capped` and the send fn is NEVER called (IR-1).
 *   - session busy → `session_busy`.
 *   - agent offline → `agent_offline` (parked in grace; replay re-runs on
 *     reconnect).
 *
 * The real shared gates run (threshold + daily-cost-cap); we mock only their
 * underlying data deps (`usage/threshold`, `db/postgres`, `scheduled-tasks-dal`)
 * so the cost-cap gate is genuinely exercised, not stubbed out.
 */
import { describe, test, expect, beforeEach, mock } from "bun:test";

const inserted: Array<{ sessionId: string; role: string; content: string }> = [];
const sent: Array<any> = [];

const state = {
  overCap: false,
  channelPresent: true,
  // queue claim the pipeline's SessionQueue should return for the next enqueue;
  // we drive it by pre-occupying the real queue instead of mocking it.
  forceBusy: false,
};

mock.module("../src/db/dal.ts", () => ({
  insertMessage: async (sessionId: string, role: string, content: string) => {
    inserted.push({ sessionId, role, content });
    return { id: "m-1", created_at: "2026-05-28T00:00:00Z" };
  },
  // Phase 20: dispatch.ts → bridge.ts → transcript/manager.ts statically import
  // these. The bridge is feature-gated off (no token set in this test) so
  // ensureSessionSubscribed no-ops, but the imports must still resolve.
  getTranscriptOpenContext: async () => null,
  getUsersWithTelegramDefaultSession: async () => [],
  // Phase 20: dispatch composes the human-only PTY guard (reads runner_type).
  // These tests target stream-json sessions ⇒ the guard never blocks.
  getSessionRunnerType: async () => "stream-json",
}));

// gates.ts: dailyCostCapGate → getCostCapStatus → sql (cap) + getTodayTokenCostUsd.
mock.module("../src/db/postgres.ts", () => ({
  sql: async () => [{ cap: "10.00", tz: "UTC" }],
}));
mock.module("../src/db/token-usage-dal.ts", () => ({
  getTodayTokenCostUsd: async () => (state.overCap ? 999 : 0),
}));

// gates.ts: thresholdGate → checkUserThreshold. Always allow in these tests.
mock.module("../src/usage/threshold.ts", () => ({
  checkUserThreshold: async () => ({ allowed: true }),
}));

mock.module("../src/ws/registry.ts", () => ({
  getChannel: () =>
    state.channelPresent
      ? { ws: { send: (s: string) => { sent.push(JSON.parse(s)); } }, userId: "u", sessionId: "s" }
      : undefined,
  broadcastToSubscribers: () => {},
}));

const { dispatchToSession } = await import("../src/telegram/dispatch.ts");
const { getQueue, _reset } = await import("../src/dispatch/pipeline.ts");

beforeEach(() => {
  inserted.length = 0;
  sent.length = 0;
  state.overCap = false;
  state.channelPresent = true;
  state.forceBusy = false;
  _reset();
});

describe("dispatchToSession — pipeline (store: null)", () => {
  test("happy path: dispatched, raw text stored (no [telegram] prefix)", async () => {
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

  test("agent socket payload carries raw content + images", async () => {
    await dispatchToSession({
      userId: "u",
      sessionId: "s",
      chatId: 1,
      updateId: 2,
      text: "ship it",
      images: ["data:image/png;base64,AAAA"],
    });
    expect(sent[0]?.type).toBe("user_message");
    expect(sent[0]?.content).toBe("ship it");
    expect(sent[0]?.images).toEqual(["data:image/png;base64,AAAA"]);
  });

  test("IR-1: over cost cap → cost_capped, send NEVER called", async () => {
    state.overCap = true;
    const r = await dispatchToSession({
      userId: "u",
      sessionId: "s",
      chatId: 1,
      updateId: 3,
      text: "blocked",
    });
    expect(r.kind).toBe("cost_capped");
    if (r.kind === "cost_capped") expect(typeof r.resumesAtUtc).toBe("string");
    // No message persisted, no agent frame sent — the cost cap is non-bypassable.
    expect(inserted.length).toBe(0);
    expect(sent.length).toBe(0);
  });

  test("session busy (queue full) → session_busy", async () => {
    // Pre-occupy the in-flight slot + waiter for this session so the next
    // enqueue is 'dropped'.
    const q = getQueue();
    q.enqueue("s", "tg:1:100");
    q.enqueue("s", "tg:1:101");
    const r = await dispatchToSession({
      userId: "u",
      sessionId: "s",
      chatId: 1,
      updateId: 4,
      text: "third",
    });
    expect(r.kind).toBe("session_busy");
    expect(sent.length).toBe(0);
  });

  test("agent offline → agent_offline (parked in grace)", async () => {
    state.channelPresent = false;
    const r = await dispatchToSession({
      userId: "u",
      sessionId: "s",
      chatId: 1,
      updateId: 5,
      text: "offline",
    });
    expect(r.kind).toBe("agent_offline");
    // Nothing sent — parked for replay on reconnect.
    expect(sent.length).toBe(0);
    expect(inserted.length).toBe(0);
  });

  test("no sessionId → no_session", async () => {
    const r = await dispatchToSession({
      userId: "u",
      sessionId: "",
      chatId: 1,
      updateId: 6,
      text: "x",
    });
    expect(r.kind).toBe("no_session");
  });
});
