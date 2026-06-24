/**
 * Unit tests for the Telegram inline-question registry + callback_data codec.
 * Pure — no DB, no network.
 */
import { describe, test, expect, beforeEach } from "bun:test";
import {
  rememberQuestionOption,
  takeQuestionOption,
  questionCallbackData,
  parseQuestionCallback,
  _resetQuestionPromptsForTests,
} from "../src/telegram/question-approvals.ts";

beforeEach(() => _resetQuestionPromptsForTests());

describe("question-approvals registry", () => {
  test("remember an option then take returns the chosen label exactly once", () => {
    const tok = rememberQuestionOption({
      sessionId: "s1",
      requestId: "req-1",
      userId: "u1",
      chatId: 100,
      messageId: 9,
      label: "Option A",
      question: "Pick one",
    });
    const first = takeQuestionOption(tok, "u1");
    expect(first?.label).toBe("Option A");
    expect(first?.sessionId).toBe("s1");
    expect(first?.requestId).toBe("req-1");
    // Resolved exactly once.
    expect(takeQuestionOption(tok, "u1")).toBeNull();
  });

  test("tapping ONE option invalidates the whole prompt (all sibling option tokens)", () => {
    const t1 = rememberQuestionOption({
      sessionId: "s1", requestId: "req-2", userId: "u1", chatId: 1, messageId: 1, label: "A", question: "q",
    });
    const t2 = rememberQuestionOption({
      sessionId: "s1", requestId: "req-2", userId: "u1", chatId: 1, messageId: 1, label: "B", question: "q",
    });
    expect(takeQuestionOption(t1, "u1")?.label).toBe("A");
    // The other option for the same prompt is now dead.
    expect(takeQuestionOption(t2, "u1")).toBeNull();
  });

  test("unauthorized user cannot take an option bound to another user", () => {
    const tok = rememberQuestionOption({
      sessionId: "s1", requestId: "req-3", userId: "u1", chatId: 1, messageId: 1, label: "A", question: "q",
    });
    expect(takeQuestionOption(tok, "u2")).toBeNull();
    expect(takeQuestionOption(tok, "u1")?.userId).toBe("u1");
  });

  test("unknown token returns null", () => {
    expect(takeQuestionOption("nope", "u1")).toBeNull();
  });

  test("expired option is not returned", () => {
    const tok = rememberQuestionOption({
      sessionId: "s1", requestId: "req-old", userId: "u1", chatId: 1, messageId: 1, label: "A", question: "q",
      createdAtMs: Date.now() - 11 * 60 * 1000,
    });
    expect(takeQuestionOption(tok, "u1")).toBeNull();
  });

  test("tokens are tiny — callback_data stays well under Telegram's 64-byte cap", () => {
    const tok = rememberQuestionOption({
      sessionId: "session-uuid-that-is-quite-long-aaaaaaaa-bbbb",
      requestId: "request-uuid-also-long-cccccccc-dddd",
      userId: "u1", chatId: 1, messageId: 1, label: "Some Option", question: "q",
    });
    expect(questionCallbackData(tok).length).toBeLessThanOrEqual(64);
  });
});

describe("question callback_data codec", () => {
  test("encode + decode round-trips", () => {
    const data = questionCallbackData("abc");
    expect(data).toBe("qa:abc");
    expect(parseQuestionCallback(data)).toEqual({ token: "abc" });
  });

  test("rejects non-question and malformed data", () => {
    expect(parseQuestionCallback("pa:abc")).toBeNull(); // permission
    expect(parseQuestionCallback("s:session-id")).toBeNull();
    expect(parseQuestionCallback(undefined)).toBeNull();
    expect(parseQuestionCallback("qa:")).toBeNull();
    expect(parseQuestionCallback("qa:" + "x".repeat(61))).toBeNull();
  });
});
