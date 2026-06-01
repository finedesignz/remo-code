/**
 * Phase 20 plan 03 task 2 — (sessionId, requestId) disambiguation + authorization
 * (T-20-07 / T-20-08 / T-20-09).
 *
 * Reuses the existing approvals registry verbatim. Asserts: two sessions with the
 * SAME synthetic requestId don't collide; an unauthorized user's tap is rejected;
 * a take removes the entry so a replayed tap finds nothing.
 */
import { describe, expect, it, beforeEach } from "bun:test";
import {
  rememberPendingPrompt,
  takePendingPrompt,
  optionCallbackData,
  parsePermissionCallback,
  _resetPendingPromptsForTests,
} from "../src/telegram/approvals.ts";

beforeEach(() => _resetPendingPromptsForTests());

function remember(sessionId: string, requestId: string, userId: string) {
  rememberPendingPrompt(sessionId, requestId, {
    sessionId,
    userId,
    chatId: 100,
    messageId: 1,
    toolName: "Bash",
    createdAtMs: Date.now(),
    injection: { cliKind: "claude", shape: "permission", options: [{ id: "approve", label: "A" }, { id: "deny", label: "D" }] },
  });
}

describe("approvals keying (sessionId, requestId)", () => {
  it("two sessions with the SAME requestId resolve independently (no collision)", () => {
    remember("sessA", "REQ", "u1");
    remember("sessB", "REQ", "u1");
    const a = takePendingPrompt("REQ", "u1", "sessA");
    const b = takePendingPrompt("REQ", "u1", "sessB");
    expect(a?.sessionId).toBe("sessA");
    expect(b?.sessionId).toBe("sessB");
  });

  it("an unauthorized user's tap is rejected (T-20-09)", () => {
    remember("sessA", "REQ", "u1");
    expect(takePendingPrompt("REQ", "u2", "sessA")).toBeNull();
    // the authorized user can still take it
    expect(takePendingPrompt("REQ", "u1", "sessA")?.sessionId).toBe("sessA");
  });

  it("a take REMOVES the entry — a replayed tap finds nothing (T-20-08)", () => {
    remember("sessA", "REQ", "u1");
    expect(takePendingPrompt("REQ", "u1", "sessA")).not.toBeNull();
    expect(takePendingPrompt("REQ", "u1", "sessA")).toBeNull();
  });

  it("the injection context survives the round trip", () => {
    remember("sessA", "REQ", "u1");
    const p = takePendingPrompt("REQ", "u1", "sessA");
    expect(p?.injection?.cliKind).toBe("claude");
    expect(p?.injection?.shape).toBe("permission");
  });
});

describe("callback_data encoding", () => {
  it("option callback_data round-trips and stays ≤64 bytes", () => {
    const data = optionCallbackData("abcdef123456", 2);
    expect(data.length).toBeLessThanOrEqual(64);
    const parsed = parsePermissionCallback(data);
    expect(parsed?.optionId).toBe("2");
    expect(parsed?.requestId).toBe("abcdef123456");
  });

  it("approve/deny callback_data parses to a boolean decision", () => {
    expect(parsePermissionCallback("pa:r1")).toEqual({ requestId: "r1", approved: true });
    expect(parsePermissionCallback("pd:r1")).toEqual({ requestId: "r1", approved: false });
  });

  it("a garbage callback_data ⇒ null", () => {
    expect(parsePermissionCallback("xx:r1")).toBeNull();
    expect(parsePermissionCallback("po:abc:r1")).toBeNull(); // non-numeric index
  });
});
