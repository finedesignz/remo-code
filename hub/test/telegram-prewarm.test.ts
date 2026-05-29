/**
 * Phase 12 UX pass — prewarmAfterLink tests.
 *
 * Mocks db/postgres + db/dal + launch. Verifies that on a fresh /start link
 * we pick the user's most-recent session, set it as default, and fire
 * launchSessionForUser. With zero sessions, returns "no_sessions" cleanly.
 */
import { describe, test, expect, beforeEach, mock } from "bun:test";

process.env.TELEGRAM_BOT_TOKEN = "fake-bot-token-prewarm";
process.env.TELEGRAM_WEBHOOK_SECRET = "test-secret-must-be-at-least-16-chars";
process.env.TELEGRAM_BOT_USERNAME = "remocode_test_bot_pw";

const state = {
  rows: [] as Array<{ id: string; name: string | null; project_dir: string | null }>,
  setDefaults: [] as Array<{ userId: string; sessionId: string | null }>,
  launchCalls: [] as Array<{ userId: string; sessionId: string }>,
};

mock.module("../src/db/postgres.ts", () => ({
  sql: async (strings: TemplateStringsArray, ..._values: any[]) => {
    const text = strings.join("?");
    if (text.includes("FROM sessions")) return state.rows;
    return [];
  },
}));

mock.module("../src/db/dal.ts", () => ({
  findUserByLinkCode: async () => null,
  setTelegramChatId: async () => {},
  setTelegramDefaultSession: async (userId: string, sid: string | null) => {
    state.setDefaults.push({ userId, sessionId: sid });
  },
}));

mock.module("../src/telegram/launch.ts", () => ({
  launchSessionForUser: async (args: { userId: string; sessionId: string }) => {
    state.launchCalls.push(args);
    return { ok: true, runId: "run-1", supervisorId: "sup-1", hostname: "h", repoPath: "/p" };
  },
}));

mock.module("./session-picker.ts", () => ({
  buildSessionKeyboard: () => [],
  renderPickerText: () => "",
  applySidebarParityFilter: (rows: any[]) => rows,
  PAGE_SIZE: 20,
}));

const { prewarmAfterLink } = await import("../src/telegram/commands.ts");

beforeEach(() => {
  state.rows = [];
  state.setDefaults.length = 0;
  state.launchCalls.length = 0;
});

describe("prewarmAfterLink", () => {
  test("existing default → skipped (already_set), no DB write, no launch", async () => {
    const r = await prewarmAfterLink({ userId: "u1", existingDefault: "old-sess" });
    expect(r.kind).toBe("skipped");
    if (r.kind === "skipped") expect(r.reason).toBe("already_set");
    expect(state.setDefaults.length).toBe(0);
    expect(state.launchCalls.length).toBe(0);
  });

  test("zero sessions → skipped (no_sessions), no launch", async () => {
    state.rows = [];
    const r = await prewarmAfterLink({ userId: "u1", existingDefault: null });
    expect(r.kind).toBe("skipped");
    if (r.kind === "skipped") expect(r.reason).toBe("no_sessions");
    expect(state.launchCalls.length).toBe(0);
  });

  test("one session → default set + launch fired", async () => {
    state.rows = [{ id: "sess-1", name: "vidgenatar", project_dir: "/r/vidgenatar" }];
    const r = await prewarmAfterLink({ userId: "u1", existingDefault: null });
    expect(r.kind).toBe("prewarmed");
    if (r.kind === "prewarmed") {
      expect(r.sessionId).toBe("sess-1");
      expect(r.label).toBe("vidgenatar");
    }
    expect(state.setDefaults).toEqual([{ userId: "u1", sessionId: "sess-1" }]);
    // launch is fire-and-forget (`void`); the call is dispatched synchronously
    // but await microtasks to be sure.
    await new Promise((r) => setTimeout(r, 5));
    expect(state.launchCalls).toEqual([{ userId: "u1", sessionId: "sess-1" }]);
  });

  test("malformed row (no id) → skipped, no launch", async () => {
    state.rows = [{ id: undefined as any, name: null, project_dir: null }];
    const r = await prewarmAfterLink({ userId: "u1", existingDefault: null });
    expect(r.kind).toBe("skipped");
    if (r.kind === "skipped") expect(r.reason).toBe("no_sessions");
    expect(state.launchCalls.length).toBe(0);
  });
});
