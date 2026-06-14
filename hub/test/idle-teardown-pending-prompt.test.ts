/**
 * idle-teardown must NOT shut down a session that is blocked on a pending
 * interactive prompt (permission_request / user_question). A Telegram-driven
 * session has no persistent WS subscriber, so without this exemption it would
 * be torn down mid-prompt, dropping the question + the in-flight turn.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  noteSubscriberCount,
  _resetIdleTeardownStateForTests,
  _forceTeardownNowForTests,
} from "../src/ws/idle-teardown";
import {
  markPromptPending,
  clearPromptPending,
  _resetPendingPromptsTrackerForTests,
} from "../src/ws/pending-prompts";
import { registerChannel, unregisterChannel } from "../src/ws/registry";

function makeChannelStub() {
  const sent: string[] = [];
  const ws = {
    send: (s: string) => { sent.push(s); return s.length; },
    close: () => {},
  } as any;
  return { ws, sent };
}

describe("idle-teardown — pending-prompt exemption", () => {
  beforeEach(() => {
    _resetIdleTeardownStateForTests();
    _resetPendingPromptsTrackerForTests();
  });
  afterEach(() => {
    _resetIdleTeardownStateForTests();
    _resetPendingPromptsTrackerForTests();
    unregisterChannel("sess_pending");
  });

  test("session with a pending prompt is NOT torn down", () => {
    const { ws, sent } = makeChannelStub();
    registerChannel("sess_pending", "user_x", ws);
    markPromptPending("sess_pending", "req-1");
    noteSubscriberCount("sess_pending", 0);
    _forceTeardownNowForTests("sess_pending");
    // No shutdown frame sent — exempted.
    expect(sent.length).toBe(0);
  });

  test("after the prompt resolves, the session is torn down normally", () => {
    const { ws, sent } = makeChannelStub();
    registerChannel("sess_pending", "user_x", ws);
    markPromptPending("sess_pending", "req-1");
    clearPromptPending("sess_pending", "req-1");
    noteSubscriberCount("sess_pending", 0);
    _forceTeardownNowForTests("sess_pending");
    expect(sent.length).toBe(1);
    expect(JSON.parse(sent[0]).type).toBe("shutdown");
  });

  test("multiple open prompts: session stays exempt until ALL resolve", () => {
    const { ws, sent } = makeChannelStub();
    registerChannel("sess_pending", "user_x", ws);
    markPromptPending("sess_pending", "req-1");
    markPromptPending("sess_pending", "req-2");
    clearPromptPending("sess_pending", "req-1");
    noteSubscriberCount("sess_pending", 0);
    _forceTeardownNowForTests("sess_pending");
    expect(sent.length).toBe(0); // req-2 still open
    clearPromptPending("sess_pending", "req-2");
    noteSubscriberCount("sess_pending", 0);
    _forceTeardownNowForTests("sess_pending");
    expect(sent.length).toBe(1);
  });
});
