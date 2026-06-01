/**
 * Phase 20 plan 03 task 1 — fail-closed permission detector (T-20-06 CRITICAL).
 *
 * The detector is the security boundary: a malformed/ambiguous permission must
 * produce ZERO pendings (⇒ zero Telegram prompts + zero keystrokes downstream).
 * These are NEGATIVE assertions: the dangerous path produces nothing.
 */
import { describe, expect, it, beforeEach } from "bun:test";
import {
  detectPending,
  detectorSkipCount,
  _resetDetectorSkipCountForTests,
} from "../src/telegram/transcript/permission-detector.ts";
import type { TranscriptEntry } from "../src/telegram/transcript/types.ts";

beforeEach(() => _resetDetectorSkipCountForTests());

describe("detectPending — accepts only clean enumerated prompts", () => {
  it("a valid boolean permission ⇒ a pending with approve/deny", () => {
    const e: TranscriptEntry = {
      kind: "permission_request",
      sessionId: "s1",
      requestId: "r1",
      toolName: "Bash",
      options: [
        { id: "approve", label: "Approve" },
        { id: "deny", label: "Deny" },
      ],
    };
    const p = detectPending(e);
    expect(p).not.toBeNull();
    expect(p!.shape).toBe("permission");
    expect(p!.options.length).toBe(2);
  });

  it("a valid option-select user_question ⇒ a pending", () => {
    const e: TranscriptEntry = {
      kind: "user_question",
      sessionId: "s1",
      requestId: "q1",
      questionText: "Which?",
      options: [
        { id: "0", label: "A" },
        { id: "1", label: "B" },
      ],
    };
    const p = detectPending(e);
    expect(p).not.toBeNull();
    expect(p!.shape).toBe("question");
  });
});

describe("detectPending — FAIL-CLOSED (zero pendings on ambiguity)", () => {
  it("missing requestId ⇒ null + skip", () => {
    const e = {
      kind: "permission_request",
      sessionId: "s1",
      requestId: "",
      toolName: "Bash",
      options: [{ id: "approve", label: "A" }, { id: "deny", label: "D" }],
    } as TranscriptEntry;
    expect(detectPending(e)).toBeNull();
    expect(detectorSkipCount()).toBe(1);
  });

  it("empty options ⇒ null + skip (no implicit default choice)", () => {
    const e = {
      kind: "permission_request",
      sessionId: "s1",
      requestId: "r1",
      toolName: "Bash",
      options: [],
    } as TranscriptEntry;
    expect(detectPending(e)).toBeNull();
    expect(detectorSkipCount()).toBe(1);
  });

  it("an option missing a label ⇒ null + skip", () => {
    const e = {
      kind: "permission_request",
      sessionId: "s1",
      requestId: "r1",
      toolName: "Bash",
      options: [{ id: "0", label: "" }],
    } as unknown as TranscriptEntry;
    expect(detectPending(e)).toBeNull();
    expect(detectorSkipCount()).toBe(1);
  });

  it("assistant_text / tool_use / turn_complete are NEVER permissions", () => {
    expect(detectPending({ kind: "assistant_text", sessionId: "s", text: "hi" })).toBeNull();
    expect(detectPending({ kind: "tool_use", sessionId: "s", toolName: "Edit" })).toBeNull();
    expect(detectPending({ kind: "turn_complete", sessionId: "s" })).toBeNull();
    // non-prompt kinds don't bump the skip counter (they aren't malformed prompts)
    expect(detectorSkipCount()).toBe(0);
  });

  it("a scrape-mode session never produces a permission (no permission_request kind reaches here)", () => {
    // Scrape mode only emits assistant_text + turn_complete — both null above.
    expect(detectPending({ kind: "assistant_text", sessionId: "s", text: "x" })).toBeNull();
  });
});
