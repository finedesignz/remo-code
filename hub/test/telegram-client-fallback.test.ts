/**
 * sendMessageMd / editMessageTextMd MarkdownV2 → plain-text fallback.
 *
 * Telegram rejects an entire message with HTTP 400 when its MarkdownV2 markup is
 * unbalanced. The bridge must never silently drop a session's reply, so a 400 on
 * a MarkdownV2 send is retried ONCE as plain text. This test drives that path by
 * stubbing global fetch.
 */
import { describe, test, expect, beforeEach, afterAll } from "bun:test";

// client.ts reads config.telegram.botToken at CALL time, so we mutate the live
// config singleton (no mock.module — that's process-wide and would leak an
// empty/forced token into sibling test files; mirrors telegram-bridge.test.ts's
// "disabled when token unset" approach).
import { config } from "../src/config.ts";
// Import via a cache-busted query so we always get the REAL client even when a
// sibling test file mock.module()'s "../src/telegram/client.ts" (Bun mock.module
// is process-wide; without this, telegram-bridge.test.ts's stub of sendMessageMd
// leaks in and this file's 400-fallback assertions break in the full-suite run).
const { sendMessageMd, editMessageTextMd } = await import(
  `../src/telegram/client.ts?nomock=${Date.now()}`
);

const _origToken = config.telegram.botToken;
Object.defineProperty(config.telegram, "botToken", {
  value: "fake-bot-token-fallback",
  writable: true,
  configurable: true,
});

interface Call {
  url: string;
  body: any;
}

const realFetch = globalThis.fetch;
let calls: Call[] = [];

/** A fetch stub that returns the next queued response and records the call. */
function installFetch(responder: (call: Call) => { ok: boolean; status: number; result?: any; body?: string }) {
  globalThis.fetch = (async (url: any, init: any) => {
    const body = init?.body ? JSON.parse(init.body) : undefined;
    const call: Call = { url: String(url), body };
    calls.push(call);
    const r = responder(call);
    return {
      ok: r.ok,
      status: r.status,
      json: async () => ({ ok: r.ok, result: r.result ?? { message_id: 1 } }),
      text: async () => r.body ?? "",
    } as any;
  }) as any;
}

beforeEach(() => {
  calls = [];
});
afterAll(() => {
  globalThis.fetch = realFetch;
  Object.defineProperty(config.telegram, "botToken", {
    value: _origToken,
    writable: true,
    configurable: true,
  });
});

describe("sendMessageMd 400 → plain-text fallback", () => {
  test("first MarkdownV2 send 400s, retries once as plain text and succeeds", async () => {
    let n = 0;
    installFetch(() => {
      n += 1;
      // First attempt (MarkdownV2) → 400; second (plain) → 200.
      if (n === 1) return { ok: false, status: 400, body: "Bad Request: can't parse entities" };
      return { ok: true, status: 200, result: { message_id: 42 } };
    });

    const res = await sendMessageMd(123, "oops *unbalanced");
    expect(res).toEqual({ message_id: 42 });
    expect(calls).toHaveLength(2);
    // Attempt 1 carried parse_mode; the retry did NOT.
    expect(calls[0]!.body.parse_mode).toBe("MarkdownV2");
    expect(calls[1]!.body.parse_mode).toBeUndefined();
    expect(calls[1]!.body.text).toBe("oops *unbalanced");
  });

  test("MarkdownV2 send that succeeds does NOT retry", async () => {
    installFetch(() => ({ ok: true, status: 200, result: { message_id: 7 } }));
    const res = await sendMessageMd(123, "all good");
    expect(res).toEqual({ message_id: 7 });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body.parse_mode).toBe("MarkdownV2");
  });

  test("non-400 error propagates (no plain-text retry)", async () => {
    installFetch(() => ({ ok: false, status: 429, body: "Too Many Requests" }));
    await expect(sendMessageMd(123, "rate limited")).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });

  test("editMessageTextMd 400 retries as plain text", async () => {
    let n = 0;
    installFetch(() => {
      n += 1;
      if (n === 1) return { ok: false, status: 400, body: "Bad Request: can't parse entities" };
      return { ok: true, status: 200 };
    });
    await editMessageTextMd(123, 9, "edit *broken");
    expect(calls).toHaveLength(2);
    expect(calls[0]!.body.parse_mode).toBe("MarkdownV2");
    expect(calls[1]!.body.parse_mode).toBeUndefined();
  });

  test('editMessageTextMd treats "message is not modified" 400 as success (no retry)', async () => {
    installFetch(() => ({ ok: false, status: 400, body: "Bad Request: message is not modified" }));
    await editMessageTextMd(123, 9, "same text");
    // Single call — the benign 400 is swallowed, no plain-text retry.
    expect(calls).toHaveLength(1);
  });
});
