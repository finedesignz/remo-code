/**
 * Phase 20 plan 03 task 3 — keystroke injection (R-TG-08, T-20-07).
 *
 * The Telegram tap injects backend-specific PTY keystrokes via term.input — NOT
 * the deleted permission_response. Asserts: injected bytes match the mapping;
 * injection targets ONLY the bound session's PTY; an unmappable option injects
 * nothing.
 *
 * ⚠️ The literal byte VALUES are provisional (manual gate — VALIDATION item 1);
 * these tests assert the WIRING + the mapping CONTRACT (right key per shape,
 * fail-closed on unmappable, correct-PTY targeting), not the final live bytes.
 */
import { describe, expect, it, beforeEach, mock } from "bun:test";

// Capture term.input frames per session via a mocked registry.
const sent: Record<string, string[]> = {};
mock.module("../src/ws/registry.ts", () => ({
  getChannel: (sessionId: string) =>
    sessionId === "offline"
      ? undefined
      : { ws: { send: (s: string) => { (sent[sessionId] ??= []).push(s); } } },
}));

const { keystrokeFor, toBase64 } = await import("../src/telegram/transcript/keystroke-map.ts");
const { injectPtyKeystroke } = await import("../src/telegram/transcript/pty-inject.ts");
import type { DetectedPending } from "../src/telegram/transcript/permission-detector.ts";

beforeEach(() => {
  for (const k of Object.keys(sent)) delete sent[k];
});

function boolPending(sessionId: string): DetectedPending {
  return {
    sessionId,
    requestId: "r1",
    toolName: "Bash",
    shape: "permission",
    options: [
      { id: "approve", label: "Approve" },
      { id: "deny", label: "Deny" },
    ],
  };
}

describe("keystrokeFor — per-backend mapping (fail-closed)", () => {
  it("claude approve/deny map to distinct non-empty byte sequences", () => {
    const p = boolPending("s");
    const approve = keystrokeFor("claude", p, "approve");
    const deny = keystrokeFor("claude", p, "deny");
    expect(approve).toBeTruthy();
    expect(deny).toBeTruthy();
    expect(approve).not.toBe(deny);
  });

  it("codex approve/deny map to non-empty sequences", () => {
    const p = boolPending("s");
    expect(keystrokeFor("codex", p, "approve")).toBeTruthy();
    expect(keystrokeFor("codex", p, "deny")).toBeTruthy();
  });

  it("an enumerated in-range option index maps; out-of-range ⇒ null (fail-closed)", () => {
    const p: DetectedPending = {
      sessionId: "s",
      requestId: "q",
      toolName: "Q?",
      shape: "question",
      options: [
        { id: "0", label: "A" },
        { id: "1", label: "B" },
      ],
    };
    expect(keystrokeFor("claude", p, "0")).toBeTruthy();
    expect(keystrokeFor("claude", p, "1")).toBeTruthy();
    expect(keystrokeFor("claude", p, "5")).toBeNull(); // out of range
    expect(keystrokeFor("claude", p, "abc")).toBeNull(); // non-numeric
  });
});

describe("injectPtyKeystroke — targets only the bound session", () => {
  it("writes a term.input frame to the bound session, none to others", () => {
    const bytes = keystrokeFor("claude", boolPending("sessX"), "approve")!;
    const res = injectPtyKeystroke("sessX", bytes);
    expect(res.ok).toBe(true);
    expect(sent["sessX"]?.length).toBe(1);
    const frame = JSON.parse(sent["sessX"][0]);
    expect(frame.type).toBe("term.input");
    expect(frame.session_id).toBe("sessX");
    expect(frame.bytes).toBe(toBase64(bytes));
    // no other session received anything
    expect(sent["sessY"]).toBeUndefined();
  });

  it("an offline session ⇒ ok:false offline (nothing injected)", () => {
    const res = injectPtyKeystroke("offline", "y\r");
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("offline");
  });

  it("frame uses term.input (NOT the deleted permission_response)", () => {
    injectPtyKeystroke("sessZ", "y\r");
    const frame = JSON.parse(sent["sessZ"][0]);
    expect(frame.type).toBe("term.input");
    expect(frame.type).not.toBe("permission_response");
  });
});
