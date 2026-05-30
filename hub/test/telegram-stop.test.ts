/**
 * Unit tests for the Telegram Stop registry + callback_data codec + the shared
 * `requestStop` cancel helper. Pure — no real DB, no network (deps injected).
 */
import { describe, test, expect, beforeEach } from "bun:test";
import {
  stopCallbackData,
  parseStopCallback,
  rememberStoppable,
  takeStoppable,
  forgetStoppable,
  requestStop,
  _resetStoppableForTests,
} from "../src/telegram/stop.ts";

beforeEach(() => _resetStoppableForTests());

describe("stop callback_data codec", () => {
  test("encode + decode round-trips a session id", () => {
    const sid = "11111111-2222-3333-4444-555555555555";
    const data = stopCallbackData(sid);
    expect(data).toBe("sx:" + sid);
    expect(data.length).toBeLessThanOrEqual(64);
    expect(parseStopCallback(data)).toEqual({ sessionId: sid });
  });

  test("rejects non-stop and malformed data", () => {
    expect(parseStopCallback("pa:req")).toBeNull(); // approval, not stop
    expect(parseStopCallback("s:session")).toBeNull(); // picker
    expect(parseStopCallback(undefined)).toBeNull();
    expect(parseStopCallback("sx:")).toBeNull(); // empty id
    expect(parseStopCallback("sx:" + "x".repeat(61))).toBeNull(); // over-long id
  });
});

describe("stop registry", () => {
  test("remember then take returns ctx exactly once (take-once)", () => {
    rememberStoppable("s1", "u1", { chatId: 100, messageId: 9 });
    const first = takeStoppable("s1", "u1");
    expect(first).toEqual({ chatId: 100, messageId: 9 });
    // Second tap is a benign no-op.
    expect(takeStoppable("s1", "u1")).toBeNull();
  });

  test("unknown session returns null", () => {
    expect(takeStoppable("nope", "u1")).toBeNull();
  });

  test("fail-closed: a non-owner user cannot take a stop bound to another user", () => {
    rememberStoppable("s1", "u1", { chatId: 100, messageId: 9 });
    // Foreign user tapping the same session id gets nothing...
    expect(takeStoppable("s1", "u2")).toBeNull();
    // ...and the entry is NOT consumed — the rightful user can still stop.
    expect(takeStoppable("s1", "u1")).toEqual({ chatId: 100, messageId: 9 });
  });

  test("two users on the same session: either can stop, take-once resolves it", () => {
    rememberStoppable("shared", "u1", { chatId: 100, messageId: 11 });
    rememberStoppable("shared", "u2", { chatId: 200, messageId: 22 });
    const a = takeStoppable("shared", "u1");
    expect(a).toEqual({ chatId: 100, messageId: 11 });
    // Whole entry resolved — u2's later tap finds nothing.
    expect(takeStoppable("shared", "u2")).toBeNull();
  });

  test("forgetStoppable drops the entry (turn finalized)", () => {
    rememberStoppable("s1", "u1", { chatId: 1, messageId: 2 });
    forgetStoppable("s1");
    expect(takeStoppable("s1", "u1")).toBeNull();
  });
});

describe("requestStop shared cancel helper", () => {
  function mkChannel() {
    const sent: string[] = [];
    return {
      sent,
      channel: { ws: { send: (s: string) => sent.push(s) } } as any,
    };
  }

  test("owner + online → sends cancel frame, returns 'stopped'", async () => {
    const { sent, channel } = mkChannel();
    const out = await requestStop({
      sessionId: "sess-1",
      userId: "owner",
      getSessionImpl: async () => ({ id: "sess-1" }) as any,
      getChannelImpl: () => channel,
    });
    expect(out).toBe("stopped");
    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0]!)).toEqual({ type: "cancel", session_id: "sess-1" });
  });

  test("fail-closed: non-owner (getSession → null) returns 'not_authorized', no send", async () => {
    const { sent, channel } = mkChannel();
    const out = await requestStop({
      sessionId: "sess-1",
      userId: "intruder",
      getSessionImpl: async () => null as any,
      getChannelImpl: () => channel,
    });
    expect(out).toBe("not_authorized");
    expect(sent).toHaveLength(0);
  });

  test("owner but session offline (no channel) returns 'offline', no send", async () => {
    const out = await requestStop({
      sessionId: "sess-1",
      userId: "owner",
      getSessionImpl: async () => ({ id: "sess-1" }) as any,
      getChannelImpl: () => undefined as any,
    });
    expect(out).toBe("offline");
  });

  test("getSession throwing is treated as not_authorized (fail closed)", async () => {
    const out = await requestStop({
      sessionId: "sess-1",
      userId: "owner",
      getSessionImpl: async () => {
        throw new Error("db down");
      },
      getChannelImpl: () => mkChannel().channel,
    });
    expect(out).toBe("not_authorized");
  });
});
