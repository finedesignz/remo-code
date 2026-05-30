/**
 * Unit tests for the Telegram inline-approval registry + callback_data codec.
 * Pure — no DB, no network.
 */
import { describe, test, expect, beforeEach } from "bun:test";
import {
  rememberPendingPrompt,
  takePendingPrompt,
  permissionCallbackData,
  parsePermissionCallback,
  _resetPendingPromptsForTests,
  type PendingPrompt,
} from "../src/telegram/approvals.ts";

function mkPrompt(over: Partial<PendingPrompt> = {}): PendingPrompt {
  return {
    sessionId: "s1",
    userId: "u1",
    chatId: 100,
    messageId: 9,
    toolName: "Bash",
    createdAtMs: Date.now(),
    ...over,
  };
}

beforeEach(() => _resetPendingPromptsForTests());

describe("approvals registry", () => {
  test("remember then take returns the prompt exactly once", () => {
    rememberPendingPrompt("s1", "req-1", mkPrompt());
    const first = takePendingPrompt("req-1", "u1");
    expect(first?.sessionId).toBe("s1");
    // Resolved exactly once — second take is null.
    expect(takePendingPrompt("req-1", "u1")).toBeNull();
  });

  test("unknown requestId returns null", () => {
    expect(takePendingPrompt("nope", "u1")).toBeNull();
  });

  test("expired prompt is not returned", () => {
    rememberPendingPrompt("s1", "req-old", mkPrompt({ createdAtMs: Date.now() - 11 * 60 * 1000 }));
    expect(takePendingPrompt("req-old", "u1")).toBeNull();
  });

  test("unauthorized user cannot take a prompt bound to another user", () => {
    rememberPendingPrompt("s1", "req-2", mkPrompt({ userId: "u1" }));
    // A different user tapping the same requestId gets nothing...
    expect(takePendingPrompt("req-2", "u2")).toBeNull();
    // ...and the rightful user can still resolve it.
    expect(takePendingPrompt("req-2", "u1")?.userId).toBe("u1");
  });

  // MED fast-follow (#189 security review): two users share ONE default session.
  // The runner raises a single requestId; the bridge fans the prompt to both.
  // The old requestId-only key clobbered the first binding, locking out a valid
  // approver. Both bindings must now survive and either user can resolve.
  test("two users on the same default session: either can resolve, exactly once", () => {
    rememberPendingPrompt("shared-session", "req-3", mkPrompt({ userId: "u1", chatId: 100, messageId: 11 }));
    rememberPendingPrompt("shared-session", "req-3", mkPrompt({ userId: "u2", chatId: 200, messageId: 22 }));

    // u1 taps first — resolves with u1's own chat/message context.
    const a = takePendingPrompt("req-3", "u1");
    expect(a?.userId).toBe("u1");
    expect(a?.chatId).toBe(100);
    expect(a?.messageId).toBe(11);

    // The whole prompt is now resolved — u2's later tap finds nothing.
    expect(takePendingPrompt("req-3", "u2")).toBeNull();
  });

  test("same requestId across DIFFERENT sessions stays isolated", () => {
    rememberPendingPrompt("sess-A", "dup", mkPrompt({ userId: "uA", sessionId: "sess-A" }));
    rememberPendingPrompt("sess-B", "dup", mkPrompt({ userId: "uB", sessionId: "sess-B" }));
    // Explicit sessionId disambiguates.
    expect(takePendingPrompt("dup", "uA", "sess-A")?.sessionId).toBe("sess-A");
    expect(takePendingPrompt("dup", "uB", "sess-B")?.sessionId).toBe("sess-B");
  });
});

describe("permission callback_data codec", () => {
  test("encode + decode round-trips approve", () => {
    const data = permissionCallbackData("abc", "approve");
    expect(data).toBe("pa:abc");
    expect(parsePermissionCallback(data)).toEqual({ requestId: "abc", approved: true });
  });

  test("encode + decode round-trips deny", () => {
    const data = permissionCallbackData("abc", "deny");
    expect(data).toBe("pd:abc");
    expect(parsePermissionCallback(data)).toEqual({ requestId: "abc", approved: false });
  });

  test("rejects non-permission and malformed data", () => {
    expect(parsePermissionCallback("s:session-id")).toBeNull();
    expect(parsePermissionCallback("p:20")).toBeNull();
    expect(parsePermissionCallback(undefined)).toBeNull();
    expect(parsePermissionCallback("pa:")).toBeNull();
    expect(parsePermissionCallback("pa:" + "x".repeat(61))).toBeNull();
  });
});
