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
    rememberPendingPrompt("req-1", mkPrompt());
    const first = takePendingPrompt("req-1");
    expect(first?.sessionId).toBe("s1");
    // Resolved exactly once — second take is null.
    expect(takePendingPrompt("req-1")).toBeNull();
  });

  test("unknown requestId returns null", () => {
    expect(takePendingPrompt("nope")).toBeNull();
  });

  test("expired prompt is not returned", () => {
    rememberPendingPrompt("req-old", mkPrompt({ createdAtMs: Date.now() - 11 * 60 * 1000 }));
    expect(takePendingPrompt("req-old")).toBeNull();
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
