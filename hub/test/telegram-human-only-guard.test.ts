/**
 * Phase 20 plan 05 — Telegram injection rides the Phase-16 human-only guard
 * (R-TG-11, T-20-13, ToS).
 *
 * A genuine human Telegram message reaches a pty-interactive session; an
 * automation-sourced Telegram-origin dispatch (scheduler/auto-nudge) is REJECTED
 * by the guard and injects nothing. NEGATIVE assertion: the dangerous path
 * produces nothing.
 */
import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";

const inserted: Array<{ sessionId: string; content: string }> = [];
const sent: Array<any> = [];
const state = { runnerType: "pty-interactive" as "pty-interactive" | "stream-json" };

mock.module("../src/db/dal.ts", () => ({
  insertMessage: async (sessionId: string, _role: string, content: string) => {
    inserted.push({ sessionId, content });
    return { id: "m1", created_at: "2026-05-31T00:00:00Z" };
  },
  getTranscriptOpenContext: async () => null,
  getUsersWithTelegramDefaultSession: async () => [],
  getSessionRunnerType: async () => state.runnerType,
}));

mock.module("../src/db/postgres.ts", () => ({
  sql: async () => [{ cap: "10.00", tz: "UTC" }],
}));
mock.module("../src/db/token-usage-dal.ts", () => ({
  getTodayTokenCostUsd: async () => 0,
  getTodayTokenTotal: async () => 0,
}));
mock.module("../src/usage/threshold.ts", () => ({
  checkUserThreshold: async () => ({ allowed: true }),
}));
mock.module("../src/ws/registry.ts", () => ({
  getChannel: () => ({ ws: { send: (s: string) => sent.push(JSON.parse(s)) }, userId: "u", sessionId: "s" }),
  broadcastToSubscribers: () => {},
}));

const { dispatchToSession } = await import("../src/telegram/dispatch.ts");
const { _reset } = await import("../src/dispatch/pipeline.ts");

beforeEach(() => {
  inserted.length = 0;
  sent.length = 0;
  state.runnerType = "pty-interactive";
  _reset();
});

describe("human-only PTY guard on Telegram dispatch", () => {
  test("a genuine human message reaches a pty-interactive session", async () => {
    const r = await dispatchToSession({
      userId: "u",
      sessionId: "s",
      chatId: 1,
      updateId: 1,
      text: "hello",
      source: "human",
    });
    expect(r.kind).toBe("dispatched");
    expect(sent.length).toBe(1);
  });

  test("a missing source is NOT treated as human -- fail closed (PTYCAP Phase 3, D-09)", async () => {
    const r = await dispatchToSession({ userId: "u", sessionId: "s", chatId: 1, updateId: 2, text: "hi" } as any);
    expect(r.kind).toBe("automation_blocked");
    expect(sent.length).toBe(0);
    expect(inserted.length).toBe(0);
  });

  test("an automation-sourced dispatch is REJECTED on a pty-interactive session (nothing injected)", async () => {
    const r = await dispatchToSession({
      userId: "u",
      sessionId: "s",
      chatId: 1,
      updateId: 3,
      text: "auto nudge",
      source: "scheduler",
    });
    expect(r.kind).toBe("automation_blocked");
    if (r.kind === "automation_blocked") expect(r.reason).toContain("automation_blocked_on_pty");
    // NEGATIVE: nothing reached the PTY / agent socket.
    expect(sent.length).toBe(0);
    expect(inserted.length).toBe(0);
  });

  test("automation on a stream-json session is NOT blocked by this guard", async () => {
    state.runnerType = "stream-json";
    const r = await dispatchToSession({
      userId: "u",
      sessionId: "s",
      chatId: 1,
      updateId: 4,
      text: "scheduled",
      source: "scheduler",
    });
    // stream-json sessions are unaffected by the human-only PTY guard.
    expect(r.kind).toBe("dispatched");
  });
});

describe("governed-automation flag ON (PTYCAP Phase 3)", () => {
  const FLAG = "REMO_GOVERNED_AUTOMATION_PTY";
  afterEach(() => {
    delete process.env[FLAG];
  });

  test("flag ON: a scheduler-sourced dispatch with the kill switch engaged is refused with the real reason (nothing sent, nothing inserted)", async () => {
    process.env[FLAG] = "1";
    process.env.REMO_AUTOMATION_KILL_SWITCH = "1";
    try {
      const r = await dispatchToSession({
        userId: "u",
        sessionId: "s",
        chatId: 1,
        updateId: 5,
        text: "auto nudge",
        source: "scheduler",
      });
      expect(r.kind).toBe("automation_blocked");
      if (r.kind === "automation_blocked") {
        expect(r.reason).toBe("automation_blocked_on_pty:scheduler:automation_halted:env");
      }
      expect(sent.length).toBe(0);
      expect(inserted.length).toBe(0);
    } finally {
      delete process.env.REMO_AUTOMATION_KILL_SWITCH;
    }
  });

  test("flag ON: a scheduler-sourced dispatch with the kill switch clear and no counter key is refused lifetime_counter_key_missing (fail closed)", async () => {
    process.env[FLAG] = "1";
    const r = await dispatchToSession({
      userId: "u",
      sessionId: "s",
      chatId: 1,
      updateId: 7,
      text: "auto nudge",
      source: "scheduler",
    });
    expect(r.kind).toBe("automation_blocked");
    if (r.kind === "automation_blocked") {
      expect(r.reason).toBe("automation_blocked_on_pty:scheduler:lifetime_counter_key_missing");
    }
    expect(sent.length).toBe(0);
    expect(inserted.length).toBe(0);
  });

  test("flag ON: a human-sourced dispatch is still dispatched", async () => {
    process.env[FLAG] = "1";
    const r = await dispatchToSession({
      userId: "u",
      sessionId: "s",
      chatId: 1,
      updateId: 6,
      text: "hello",
      source: "human",
    });
    expect(r.kind).toBe("dispatched");
    expect(sent.length).toBe(1);
  });
});
