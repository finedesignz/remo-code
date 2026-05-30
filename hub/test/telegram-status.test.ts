/**
 * Phase 12 UX pass — /status command tests.
 *
 * Mocks: db/postgres (session + user rows), db/supervisor-dal,
 * ws/supervisor-registry, ws/registry, db/scheduled-tasks-dal, client.
 */
import { describe, test, expect, beforeEach, mock } from "bun:test";

process.env.TELEGRAM_BOT_TOKEN = "fake-bot-token-status";
process.env.TELEGRAM_WEBHOOK_SECRET = "test-secret-must-be-at-least-16-chars";
process.env.TELEGRAM_BOT_USERNAME = "remocode_test_bot_status";

const USER_ID = "u-1";
const SESSION_ID = "sess-status";
const HOST = "devbox";

const state = {
  sessionRow: null as { name: string | null; project_dir: string | null; hostname: string | null } | null,
  costCap: 10,
  costSpent: 0,
  supervisors: [] as Array<{ id: string; hostname: string; last_seen_at: Date }>,
  supervisorOnline: true,
  supervisorStale: false,
  channelPresent: false,
  sends: [] as Array<{ chat: any; text: string }>,
};

mock.module("../src/db/postgres.ts", () => ({
  sql: async (strings: TemplateStringsArray, ..._values: any[]) => {
    const text = strings.join("?");
    if (text.includes("FROM sessions")) {
      return state.sessionRow ? [state.sessionRow] : [];
    }
    if (text.includes("FROM users")) {
      return [{ cap: String(state.costCap), tz: "UTC" }];
    }
    return [];
  },
}));

mock.module("../src/db/supervisor-dal.ts", () => ({
  listSupervisorsForUser: async () => state.supervisors.map((s) => ({
    id: s.id,
    hostname: s.hostname,
    last_seen_at: state.supervisorStale ? new Date(Date.now() - 5 * 60_000) : s.last_seen_at,
  })),
}));

mock.module("../src/ws/supervisor-registry.ts", () => ({
  isSupervisorOnline: () => state.supervisorOnline,
}));

mock.module("../src/ws/registry.ts", () => ({
  getChannel: () => (state.channelPresent ? { ws: {}, userId: USER_ID, sessionId: SESSION_ID } : undefined),
}));

mock.module("../src/db/token-usage-dal.ts", () => ({
  getTodayTokenCostUsd: async () => state.costSpent,
}));

mock.module("../src/telegram/client.ts", () => ({
  sendMessage: async (chat: any, text: string) => { state.sends.push({ chat, text }); },
}));

const { runStatus } = await import("../src/telegram/status.ts");

function freshUser(over: Partial<{ defaultSession: string | null }> = {}) {
  return {
    id: USER_ID,
    email: "u@example.com",
    telegram_chat_id: 123,
    telegram_default_session_id: over.defaultSession === undefined ? SESSION_ID : over.defaultSession,
  } as any;
}

beforeEach(() => {
  state.sessionRow = { name: "kh-hub", project_dir: "C:/repos/kh-hub", hostname: HOST };
  state.costCap = 10;
  state.costSpent = 0;
  state.supervisors = [{ id: "sup-1", hostname: HOST, last_seen_at: new Date() }];
  state.supervisorOnline = true;
  state.supervisorStale = false;
  state.channelPresent = false;
  state.sends.length = 0;
});

describe("runStatus", () => {
  test("all-green status reply", async () => {
    state.channelPresent = true;
    state.costSpent = 0.42;
    const r = await runStatus({ user: freshUser(), chatId: 999 });
    expect(r.outcome).toBe("cmd_status_ok");
    expect(state.sends.length).toBe(1);
    const t = state.sends[0]!.text;
    expect(t).toContain("Linked as u@example.com");
    expect(t).toContain("kh-hub");
    expect(t).toContain("🟢 Supervisor");
    expect(t).toContain("🟢 Session");
    expect(t).toContain("$0.42");
    expect(t).toContain("$10.00");
  });

  test("missing default session → ⚠ row", async () => {
    const r = await runStatus({ user: freshUser({ defaultSession: null }), chatId: 999 });
    expect(r.outcome).toBe("cmd_status_ok");
    expect(state.sends[0]!.text).toContain("⚠ Default: not set");
  });

  test("supervisor offline → ⚠ row", async () => {
    state.supervisorOnline = false;
    const r = await runStatus({ user: freshUser(), chatId: 999 });
    expect(r.outcome).toBe("cmd_status_ok");
    expect(state.sends[0]!.text).toContain("⚠ Supervisor");
    expect(state.sends[0]!.text).toContain("offline");
  });

  test("cost-cap exceeded shows the cap line accurately", async () => {
    state.costSpent = 10.5;
    state.costCap = 10;
    const r = await runStatus({ user: freshUser(), chatId: 999 });
    expect(r.outcome).toBe("cmd_status_ok");
    expect(state.sends[0]!.text).toContain("$10.50 / $10.00");
  });

  test("channel absent shows ⚪ session row", async () => {
    state.channelPresent = false;
    const r = await runStatus({ user: freshUser(), chatId: 999 });
    expect(r.outcome).toBe("cmd_status_ok");
    expect(state.sends[0]!.text).toContain("⚪ Session: offline");
  });
});
