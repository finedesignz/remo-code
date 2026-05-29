/**
 * Telegram inline-keyboard session picker tests.
 *
 * Two layers:
 *   1. Pure-module unit tests for `session-picker.ts` (keyboard rendering,
 *      callback_data parse/encode, pagination boundaries) — no mocks needed.
 *   2. Webhook integration tests (callback_query routing, authorization) with
 *      DB / client / dispatch mocked via `mock.module` (mirrors
 *      telegram-webhook.test.ts harness exactly).
 */
import { describe, test, expect, beforeAll, beforeEach, mock } from "bun:test";
import { Hono } from "hono";

import {
  PAGE_SIZE,
  buildSessionKeyboard,
  deriveLabel,
  parseCallbackData,
  renderPickerText,
  snapOffsetToPage,
  type PickerSessionRow,
} from "../src/telegram/session-picker.ts";

// ── Pure unit tests ─────────────────────────────────────────────────────────

function mkSession(i: number, projectDir?: string): PickerSessionRow {
  return {
    id: `sess-${String(i).padStart(4, "0")}-uuid`,
    name: null,
    project_dir: projectDir ?? `C:/Users/u/GitHub/finedezignz/repo-${i}`,
  };
}

describe("session-picker pure", () => {
  test("PAGE_SIZE is 20", () => {
    expect(PAGE_SIZE).toBe(20);
  });

  test("deriveLabel uses last path segment", () => {
    expect(deriveLabel({ id: "x", name: null, project_dir: "C:/Users/a/GitHub/vidgenatar" })).toBe("vidgenatar");
    expect(deriveLabel({ id: "x", name: null, project_dir: "/home/u/some-cool-repo" })).toBe("some-cool-repo");
  });

  test("deriveLabel truncates over 28 chars", () => {
    const longRepo = "a".repeat(40);
    const out = deriveLabel({ id: "x", name: null, project_dir: `/u/${longRepo}` });
    expect(out.length).toBeLessThanOrEqual(28);
    expect(out.endsWith("…")).toBe(true);
  });

  test("deriveLabel falls back to name then short id", () => {
    expect(deriveLabel({ id: "abcdef0123", name: "My Session", project_dir: null })).toBe("My Session");
    expect(deriveLabel({ id: "abcdef0123", name: null, project_dir: null })).toBe("abcdef01");
  });

  test("parseCallbackData accepts s: and p:, rejects others", () => {
    expect(parseCallbackData("s:abc-def")).toEqual({ kind: "set_session", sessionId: "abc-def" });
    expect(parseCallbackData("p:40")).toEqual({ kind: "paginate", offset: 40 });
    expect(parseCallbackData("p:0")).toEqual({ kind: "paginate", offset: 0 });
    expect(parseCallbackData("x:bad")).toBeNull();
    expect(parseCallbackData("s:")).toBeNull();
    expect(parseCallbackData("p:-1")).toBeNull();
    expect(parseCallbackData("p:nan")).toBeNull();
    expect(parseCallbackData(null)).toBeNull();
    expect(parseCallbackData(undefined)).toBeNull();
    expect(parseCallbackData("s:" + "x".repeat(70))).toBeNull(); // >64 bytes
  });

  test("snapOffsetToPage clamps and snaps", () => {
    expect(snapOffsetToPage(0, 100)).toBe(0);
    expect(snapOffsetToPage(20, 100)).toBe(20);
    expect(snapOffsetToPage(25, 100)).toBe(20);
    expect(snapOffsetToPage(999, 100)).toBe(80); // last page
    expect(snapOffsetToPage(-5, 100)).toBe(0);
    expect(snapOffsetToPage(40, 0)).toBe(0);
    expect(snapOffsetToPage(40, 30)).toBe(20);
  });

  test("buildSessionKeyboard: 20 sessions → 10 rows × 2, no nav row", () => {
    const rows = Array.from({ length: 20 }, (_, i) => mkSession(i));
    const kb = buildSessionKeyboard({ rows, offset: 0, defaultId: null });
    expect(kb.length).toBe(10);
    for (const r of kb) expect(r.length).toBe(2);
    // no nav row
    expect(kb.flat().every((b) => b.callback_data?.startsWith("s:"))).toBe(true);
  });

  test("buildSessionKeyboard: 70 sessions → first page has Next, no Prev", () => {
    const rows = Array.from({ length: 70 }, (_, i) => mkSession(i));
    const kb = buildSessionKeyboard({ rows, offset: 0, defaultId: null });
    const navRow = kb[kb.length - 1]!;
    expect(navRow.length).toBe(1);
    expect(navRow[0]!.callback_data).toBe("p:20");
    expect(navRow[0]!.text).toBe("Next »");
    // 10 session rows + 1 nav row
    expect(kb.length).toBe(11);
  });

  test("buildSessionKeyboard: middle page has both Prev and Next", () => {
    const rows = Array.from({ length: 70 }, (_, i) => mkSession(i));
    const kb = buildSessionKeyboard({ rows, offset: 20, defaultId: null });
    const navRow = kb[kb.length - 1]!;
    expect(navRow.length).toBe(2);
    expect(navRow[0]!.callback_data).toBe("p:0");
    expect(navRow[1]!.callback_data).toBe("p:40");
  });

  test("buildSessionKeyboard: last partial page has Prev only", () => {
    const rows = Array.from({ length: 70 }, (_, i) => mkSession(i));
    const kb = buildSessionKeyboard({ rows, offset: 60, defaultId: null });
    // 10 sessions on last page = 5 rows of 2, +1 nav = 6
    const navRow = kb[kb.length - 1]!;
    expect(navRow.length).toBe(1);
    expect(navRow[0]!.callback_data).toBe("p:40");
    expect(navRow[0]!.text).toBe("« Prev");
  });

  test("buildSessionKeyboard marks default session with ✓", () => {
    const rows = Array.from({ length: 5 }, (_, i) => mkSession(i));
    const defaultId = rows[2]!.id;
    const kb = buildSessionKeyboard({ rows, offset: 0, defaultId });
    const marked = kb.flat().filter((b) => b.text.startsWith("✓ "));
    expect(marked.length).toBe(1);
    expect(marked[0]!.callback_data).toBe(`s:${defaultId}`);
  });

  test("renderPickerText shows range and total", () => {
    const t = renderPickerText({ total: 70, offset: 20, defaultId: null });
    expect(t).toContain("21–40 of 70");
  });
});

// ── applySidebarParityFilter tests (Items 6 + Bug A + Bug C) ─────────────

import { applySidebarParityFilter } from "../src/telegram/session-picker.ts";

function mk(over: Partial<PickerSessionRow>): PickerSessionRow {
  return {
    id: over.id ?? "id-" + Math.random().toString(36).slice(2, 8),
    name: over.name ?? null,
    project_dir: over.project_dir ?? null,
    status: over.status ?? "offline",
    repo_key: over.repo_key ?? null,
    is_orchestrator: over.is_orchestrator ?? false,
    github_owner: over.github_owner ?? null,
    github_repo: over.github_repo ?? null,
    last_activity_ms: over.last_activity_ms ?? null,
  };
}

describe("applySidebarParityFilter", () => {
  test("drops offline rows with null repo_key (legacy local offline)", () => {
    const out = applySidebarParityFilter([
      mk({ id: "a", status: "offline", repo_key: null }),
      mk({ id: "b", status: "online", repo_key: null }),
      mk({ id: "c", status: "offline", repo_key: "github://x/y" }),
    ]);
    const ids = out.map((r) => r.id);
    expect(ids).not.toContain("a");
    expect(ids).toContain("b");
    expect(ids).toContain("c");
  });

  test("dedupes by repo_key keeping most-recently-active", () => {
    const out = applySidebarParityFilter([
      mk({ id: "old", status: "online", repo_key: "k1", last_activity_ms: 100 }),
      mk({ id: "new", status: "online", repo_key: "k1", last_activity_ms: 200 }),
    ]);
    expect(out.map((r) => r.id)).toEqual(["new"]);
  });

  test("pins orchestrator row to position 0", () => {
    const out = applySidebarParityFilter([
      mk({ id: "a", status: "online", repo_key: "k1" }),
      mk({ id: "b", status: "online", repo_key: "k2" }),
      mk({ id: "orch", status: "online", repo_key: "k3", is_orchestrator: true }),
    ]);
    expect(out[0]!.id).toBe("orch");
  });

  test("keeps + pins an OFFLINE, repo_key-less orchestrator (exempt from step-1 drop)", () => {
    // The root orchestrator has no repo_key and is frequently offline (lazy
    // launch). It must NOT be dropped like other offline+no-repo rows.
    const out = applySidebarParityFilter([
      mk({ id: "a", status: "online", repo_key: "k1" }),
      mk({ id: "orch", status: "offline", repo_key: null, is_orchestrator: true }),
    ]);
    expect(out.map((r) => r.id)).toContain("orch");
    expect(out[0]!.id).toBe("orch"); // pinned first
  });

  test("Bug A — one canonical + 3 worktrees → only canonical survives", () => {
    const rows: PickerSessionRow[] = [
      mk({ id: "canon", status: "online", repo_key: "k1", project_dir: "C:/g/remo-code", github_owner: "fd", github_repo: "remo-code", last_activity_ms: 100 }),
      mk({ id: "wt1", status: "online", repo_key: "k2", project_dir: "C:/g/remo-code-feat-x", github_owner: "fd", github_repo: "remo-code", last_activity_ms: 200 }),
      mk({ id: "wt2", status: "online", repo_key: "k3", project_dir: "C:/g/remo-code-fix-y", github_owner: "fd", github_repo: "remo-code", last_activity_ms: 300 }),
      mk({ id: "wt3", status: "online", repo_key: "k4", project_dir: "C:/g/remo-code-feat-z", github_owner: "fd", github_repo: "remo-code", last_activity_ms: 50 }),
    ];
    const out = applySidebarParityFilter(rows);
    expect(out.map((r) => r.id)).toEqual(["canon"]);
  });

  test("Bug A — no canonical, 3 worktrees → most-recently-active wins", () => {
    const rows: PickerSessionRow[] = [
      mk({ id: "wt1", status: "online", repo_key: "k1", project_dir: "C:/g/x-feat-a", github_owner: "fd", github_repo: "x", last_activity_ms: 100 }),
      mk({ id: "wt2", status: "online", repo_key: "k2", project_dir: "C:/g/x-feat-b", github_owner: "fd", github_repo: "x", last_activity_ms: 300 }),
      mk({ id: "wt3", status: "online", repo_key: "k3", project_dir: "C:/g/x-feat-c", github_owner: "fd", github_repo: "x", last_activity_ms: 200 }),
    ];
    const out = applySidebarParityFilter(rows);
    expect(out.map((r) => r.id)).toEqual(["wt2"]);
  });

  test("Bug A — two repos × 3 worktrees each → 2 survivors", () => {
    const rows: PickerSessionRow[] = [];
    for (const repo of ["one", "two"]) {
      for (let i = 0; i < 3; i++) {
        rows.push(mk({
          id: `${repo}-${i}`,
          status: "online",
          repo_key: `k-${repo}-${i}`,
          project_dir: i === 0 ? `C:/g/${repo}` : `C:/g/${repo}-feat-${i}`,
          github_owner: "fd",
          github_repo: repo,
          last_activity_ms: i * 100,
        }));
      }
    }
    const out = applySidebarParityFilter(rows);
    expect(out.length).toBe(2);
    expect(out.map((r) => r.id).sort()).toEqual(["one-0", "two-0"]);
  });

  test("Bug A — null github_repo rows untouched by worktree dedup", () => {
    const out = applySidebarParityFilter([
      mk({ id: "a", status: "online", repo_key: "k1", github_owner: null, github_repo: null }),
      mk({ id: "b", status: "online", repo_key: "k2", github_owner: null, github_repo: null }),
    ]);
    expect(out.map((r) => r.id).sort()).toEqual(["a", "b"]);
  });
});

describe("renderPickerText orchestrator + hint", () => {
  test("legend shows ⭐ when page contains orchestrator", () => {
    const rows = [
      mk({ id: "orch", status: "online", repo_key: "k1", is_orchestrator: true }),
      mk({ id: "b", status: "online", repo_key: "k2" }),
    ];
    const t = renderPickerText({ total: 2, offset: 0, defaultId: null, rows });
    expect(t).toContain("🧭 = orchestrator (root folder)");
  });

  test("Bug C — orchestrator hint shown when none exists in the user's list", () => {
    const rows = [
      mk({ id: "a", status: "online", repo_key: "k1" }),
      mk({ id: "b", status: "online", repo_key: "k2" }),
    ];
    const t = renderPickerText({ total: 2, offset: 0, defaultId: null, rows });
    expect(t).toContain("Pin a root orchestrator");
    expect(t).not.toContain("⭐ = orchestrator");
  });

  test("hint suppressed when orchestrator exists (even if not on current page)", () => {
    const rows = Array.from({ length: 25 }, (_, i) => mk({ id: `s${i}`, status: "online", repo_key: `k${i}` }));
    rows[24]!.is_orchestrator = true;
    const t = renderPickerText({ total: 25, offset: 0, defaultId: null, rows });
    // Page 0 (first 20) has no orchestrator, but the full list does → no hint, no ⭐ on this page.
    expect(t).not.toContain("Pin a root orchestrator");
    expect(t).not.toContain("⭐ = orchestrator");
  });
});

// ── Webhook integration tests ──────────────────────────────────────────────

const TEST_SECRET = "test-secret-must-be-at-least-16-chars";
const LINKED_CHAT = 555000111;
const UNLINKED_CHAT = 999000222;
const LINKED_USER_ID = "user-linked-uuid";
const FOREIGN_USER_ID = "user-foreign-uuid";

process.env.TELEGRAM_BOT_TOKEN = "fake-bot-token";
process.env.TELEGRAM_WEBHOOK_SECRET = TEST_SECRET;
process.env.TELEGRAM_BOT_USERNAME = "remocode_test_bot";

interface SessionRecord {
  id: string;
  user_id: string;
  name: string | null;
  project_dir: string | null;
  is_orchestrator?: boolean;
  status?: string;
  repo_key?: string | null;
}

const state: {
  user: { id: string; email: string; telegram_chat_id: number | null; telegram_default_session_id: string | null; telegram_default_explicit?: boolean } | null;
  sessions: SessionRecord[];
  insertedLogs: any[];
  dedupeOnUpdateId: Set<number>;
  sentMessages: Array<{ chat: number | string; text: string; keyboard?: any }>;
  callbackAnswers: Array<{ id: string; text?: string; show_alert?: boolean }>;
  editedMessages: Array<{ chat: number | string; messageId: number; text: string; keyboard?: any }>;
  editedReplyMarkups: Array<{ chat: number | string; messageId: number; keyboard: any }>;
  setDefaults: Array<{ userId: string; sessionId: string | null; explicit?: boolean }>;
  // orchestrator state: a row in `sessions` flagged is_orchestrator is what the
  // picker keys on; these toggle the synthetic-injection / enabled gates.
  orchEnabled: boolean;
  orchDisabledExplicitly: boolean;
  launchCalls: number;
  launchResult: any;
  // When true, editMessageText throws a non-'not modified' 400 (drives the
  // plain-text fallback path).
  editFails: boolean;
} = {
  user: null,
  sessions: [],
  insertedLogs: [],
  dedupeOnUpdateId: new Set(),
  sentMessages: [],
  callbackAnswers: [],
  editedMessages: [],
  editedReplyMarkups: [],
  setDefaults: [],
  orchEnabled: false,
  orchDisabledExplicitly: false,
  launchCalls: 0,
  launchResult: { ok: true, sessionId: "sess-orch-real", runId: "r1", supervisorId: "sup-1", cwd: "/root", reused: false },
  editFails: false,
};

const realDalTSP = await import(`../src/db/dal.ts?real=${Date.now()}`);
mock.module("../src/db/dal.ts", () => ({
  ...realDalTSP,
  getUserByTelegramChatId: async (chatId: number) => {
    if (state.user && state.user.telegram_chat_id === Number(chatId)) return state.user;
    return null;
  },
  getSession: async (sessionId: string, userId: string) => {
    return state.sessions.find((s) => s.id === sessionId && s.user_id === userId) ?? null;
  },
  setTelegramDefaultSession: async (userId: string, sid: string | null, explicit = false) => {
    state.setDefaults.push({ userId, sessionId: sid, explicit });
    if (state.user && state.user.id === userId) {
      state.user.telegram_default_session_id = sid;
      state.user.telegram_default_explicit = explicit;
    }
  },
  setTelegramChatId: async () => {},
  findUserByLinkCode: async () => null,
  logTelegramInbound: async (input: any) => {
    const uid = Number(input.update_id);
    if (state.dedupeOnUpdateId.has(uid)) return { inserted: false };
    state.dedupeOnUpdateId.add(uid);
    state.insertedLogs.push(input);
    return { inserted: true };
  },
}));

mock.module("../src/db/postgres.ts", () => ({
  sql: async (strings: TemplateStringsArray, ...values: any[]) => {
    const q = strings.join("?");
    // listUserSessionsForPicker query
    if (q.includes("FROM sessions") && q.includes("LIMIT 200")) {
      const uid = values[0];
      return state.sessions
        .filter((s) => s.user_id === uid)
        .map((s, i) => ({
          id: s.id,
          name: s.name,
          project_dir: s.project_dir,
          status: s.status ?? "online",
          repo_key: s.repo_key !== undefined ? s.repo_key : `test://${s.id}`,
          is_orchestrator: !!s.is_orchestrator,
          github_owner: null,
          github_repo: null,
          last_activity: new Date(Date.now() - i * 1000),
        }));
    }
    // getOrchestratorState query (SELECT ... FROM users WHERE id = ...)
    if (q.includes("orchestrator_enabled") && q.includes("FROM users")) {
      return [{
        orchestrator_enabled: state.orchEnabled,
        orchestrator_name: "Orchestrator",
        orchestrator_custom_instructions: null,
        orchestrator_disabled_explicitly: state.orchDisabledExplicitly,
      }];
    }
    // listUserSessions (LIMIT 25)
    if (q.includes("FROM sessions") && q.includes("LIMIT 25")) {
      const uid = values[0];
      return state.sessions
        .filter((s) => s.user_id === uid)
        .map(({ id, name, project_dir }) => ({ id, name, project_dir, last_activity: new Date() }));
    }
    // handleStart email lookup
    if (q.includes("FROM users WHERE id")) {
      return state.user ? [{ email: state.user.email }] : [];
    }
    return [];
  },
}));

mock.module("../src/telegram/client.ts", () => ({
  sendMessage: async (chatId: number | string, text: string) => {
    state.sentMessages.push({ chat: chatId, text });
  },
  sendMessageWithKeyboard: async (chatId: number | string, text: string, keyboard: any) => {
    state.sentMessages.push({ chat: chatId, text, keyboard });
  },
  answerCallbackQuery: async (id: string, opts: any = {}) => {
    state.callbackAnswers.push({ id, ...opts });
  },
  editMessageText: async (chatId: number | string, messageId: number, text: string, opts: any = {}) => {
    if (state.editFails) {
      const e: any = new Error("Bad Request: can't parse entities");
      e.status = 400;
      throw e;
    }
    state.editedMessages.push({ chat: chatId, messageId, text, keyboard: opts?.inline_keyboard });
  },
  editMessageReplyMarkup: async (chatId: number | string, messageId: number, keyboard: any) => {
    state.editedReplyMarkups.push({ chat: chatId, messageId, keyboard });
  },
  getFile: async (fileId: string) => ({ file_id: fileId, file_path: "photos/file.jpg", file_size: 1024 }),
  downloadFile: async () => new ArrayBuffer(8),
  escapeMarkdownV2: (s: string) => s,
  splitForTelegram: (s: string) => [s],
  TelegramClientError: class extends Error {},
}));

mock.module("../src/telegram/dispatch.ts", () => ({
  dispatchToSession: async () => ({ kind: "dispatched" }),
  isOverCostCap: async () => false,
  nextUtcResetIso: () => "2026-05-29T00:00:00.000Z",
}));

mock.module("../src/orchestrator/auto-launch.ts", () => ({
  launchOrchestrator: async () => {
    state.launchCalls += 1;
    return state.launchResult;
  },
  maybeAutoLaunchOrchestrator: async () => ({ launched: false }),
}));

let app: Hono;

beforeAll(async () => {
  const mod = await import("../src/api/telegram-webhook.ts");
  app = new Hono();
  app.route("/api/telegram", mod.telegramWebhookRoutes);
});

beforeEach(() => {
  state.user = null;
  state.sessions = [];
  state.insertedLogs = [];
  state.dedupeOnUpdateId = new Set();
  state.sentMessages = [];
  state.callbackAnswers = [];
  state.editedMessages = [];
  state.editedReplyMarkups = [];
  state.setDefaults = [];
  state.orchEnabled = false;
  state.orchDisabledExplicitly = false;
  state.launchCalls = 0;
  state.launchResult = { ok: true, sessionId: "sess-orch-real", runId: "r1", supervisorId: "sup-1", cwd: "/root", reused: false };
  state.editFails = false;
});

function post(path: string, body: any): Promise<Response> {
  return app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function mkCallback(opts: { update_id: number; chatId: number; data: string; messageId?: number }) {
  return {
    update_id: opts.update_id,
    callback_query: {
      id: `cbq-${opts.update_id}`,
      from: { id: opts.chatId },
      message: {
        message_id: opts.messageId ?? 42,
        chat: { id: opts.chatId },
      },
      data: opts.data,
    },
  };
}

function mkListMessage(opts: { update_id: number; chatId: number }) {
  return {
    update_id: opts.update_id,
    message: {
      message_id: 1,
      date: Math.floor(Date.now() / 1000),
      chat: { id: opts.chatId },
      from: { id: opts.chatId },
      text: "/list",
    },
  };
}

function linkUser(opts: { sessionCount: number; defaultId?: string | null }): void {
  state.user = {
    id: LINKED_USER_ID,
    email: "linked@example.com",
    telegram_chat_id: LINKED_CHAT,
    telegram_default_session_id: opts.defaultId ?? null,
  };
  state.sessions = Array.from({ length: opts.sessionCount }, (_, i) => ({
    id: `sess-${String(i).padStart(4, "0")}-uuid`,
    user_id: LINKED_USER_ID,
    name: null,
    project_dir: `/u/repo-${i}`,
  }));
}

describe("/list inline keyboard", () => {
  test("sends keyboard with first 20 sessions + Next nav when total > 20", async () => {
    linkUser({ sessionCount: 70 });
    const res = await post(`/api/telegram/webhook/${TEST_SECRET}`, mkListMessage({ update_id: 1, chatId: LINKED_CHAT }));
    expect(res.status).toBe(200);
    expect(state.sentMessages.length).toBe(1);
    const sent = state.sentMessages[0]!;
    expect(sent.keyboard).toBeDefined();
    // 10 session rows + 1 nav row
    expect(sent.keyboard.length).toBe(11);
    const lastRow = sent.keyboard[10];
    expect(lastRow.length).toBe(1);
    expect(lastRow[0].callback_data).toBe("p:20");
  });

  test("zero sessions → plain text reply (no keyboard)", async () => {
    linkUser({ sessionCount: 0 });
    const res = await post(`/api/telegram/webhook/${TEST_SECRET}`, mkListMessage({ update_id: 2, chatId: LINKED_CHAT }));
    expect(res.status).toBe(200);
    expect(state.sentMessages.length).toBe(1);
    expect(state.sentMessages[0]!.keyboard).toBeUndefined();
    expect(state.sentMessages[0]!.text).toContain("No sessions");
  });
});

describe("callback_query routing", () => {
  test("s:<owned-session> sets default + answers + edits message", async () => {
    linkUser({ sessionCount: 5 });
    const targetId = state.sessions[2]!.id;
    const res = await post(
      `/api/telegram/webhook/${TEST_SECRET}`,
      mkCallback({ update_id: 10, chatId: LINKED_CHAT, data: `s:${targetId}` }),
    );
    expect(res.status).toBe(200);
    expect(state.user!.telegram_default_session_id).toBe(targetId);
    expect(state.callbackAnswers.length).toBe(1);
    expect(state.callbackAnswers[0]!.text).toContain("set");
    // re-render
    expect(state.editedMessages.length).toBe(1);
  });

  test("s:<foreign-session> denies + no DB change", async () => {
    linkUser({ sessionCount: 3 });
    // Add a foreign session not owned by linked user.
    state.sessions.push({
      id: "foreign-session-id",
      user_id: FOREIGN_USER_ID,
      name: null,
      project_dir: "/foreign",
    });
    const res = await post(
      `/api/telegram/webhook/${TEST_SECRET}`,
      mkCallback({ update_id: 11, chatId: LINKED_CHAT, data: "s:foreign-session-id" }),
    );
    expect(res.status).toBe(200);
    expect(state.user!.telegram_default_session_id).toBeNull();
    expect(state.callbackAnswers.length).toBe(1);
    expect(state.callbackAnswers[0]!.show_alert).toBe(true);
    expect(state.callbackAnswers[0]!.text).toBe("Not allowed");
  });

  test("p:20 re-renders next page", async () => {
    linkUser({ sessionCount: 70 });
    const res = await post(
      `/api/telegram/webhook/${TEST_SECRET}`,
      mkCallback({ update_id: 12, chatId: LINKED_CHAT, data: "p:20" }),
    );
    expect(res.status).toBe(200);
    expect(state.editedMessages.length).toBe(1);
    const edited = state.editedMessages[0]!;
    expect(edited.text).toContain("21–40 of 70");
    // Last row should be the nav row with both Prev and Next.
    const navRow = edited.keyboard[edited.keyboard.length - 1];
    expect(navRow.length).toBe(2);
  });

  test("callback from unlinked chat → silent drop + audit", async () => {
    const res = await post(
      `/api/telegram/webhook/${TEST_SECRET}`,
      mkCallback({ update_id: 13, chatId: UNLINKED_CHAT, data: "s:any" }),
    );
    expect(res.status).toBe(200);
    // No DB writes, no edits, no user-facing toast (silent).
    expect(state.editedMessages.length).toBe(0);
    expect(state.sentMessages.length).toBe(0);
    // But we DO audit it.
    expect(state.insertedLogs.length).toBe(1);
    expect(state.insertedLogs[0]!.chat_id).toBe(UNLINKED_CHAT);
  });

  test("dedupe via (chat_id, update_id) for callback updates", async () => {
    linkUser({ sessionCount: 5 });
    const targetId = state.sessions[1]!.id;
    const payload = mkCallback({ update_id: 14, chatId: LINKED_CHAT, data: `s:${targetId}` });
    const r1 = await post(`/api/telegram/webhook/${TEST_SECRET}`, payload);
    const r2 = await post(`/api/telegram/webhook/${TEST_SECRET}`, payload);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    const body2 = (await r2.json()) as any;
    expect(body2.deduped).toBe(true);
    // Default-set + edit happen exactly once.
    expect(state.callbackAnswers.length).toBe(1);
    expect(state.editedMessages.length).toBe(1);
  });

  test("unknown callback data → unknown toast, no state change", async () => {
    linkUser({ sessionCount: 3 });
    const res = await post(
      `/api/telegram/webhook/${TEST_SECRET}`,
      mkCallback({ update_id: 15, chatId: LINKED_CHAT, data: "z:garbage" }),
    );
    expect(res.status).toBe(200);
    expect(state.callbackAnswers.length).toBe(1);
    expect(state.callbackAnswers[0]!.text).toBe("Unknown action");
    expect(state.user!.telegram_default_session_id).toBeNull();
  });

  test("button tap sets the default as EXPLICIT", async () => {
    linkUser({ sessionCount: 5 });
    const targetId = state.sessions[2]!.id;
    await post(`/api/telegram/webhook/${TEST_SECRET}`, mkCallback({ update_id: 16, chatId: LINKED_CHAT, data: `s:${targetId}` }));
    expect(state.setDefaults).toEqual([{ userId: LINKED_USER_ID, sessionId: targetId, explicit: true }]);
    expect(state.user!.telegram_default_explicit).toBe(true);
  });
});

describe("orchestrator visibility in /list", () => {
  test("offline, repo_key-less orchestrator row is shown + pinned FIRST", async () => {
    state.user = {
      id: LINKED_USER_ID,
      email: "linked@example.com",
      telegram_chat_id: LINKED_CHAT,
      telegram_default_session_id: null,
    };
    // One online repo session + an OFFLINE orchestrator with null repo_key.
    state.sessions = [
      { id: "repo-1", user_id: LINKED_USER_ID, name: null, project_dir: "/u/repo-1", status: "online", repo_key: "k1" },
      { id: "orch-real", user_id: LINKED_USER_ID, name: "Orchestrator", project_dir: "/root", status: "offline", repo_key: null, is_orchestrator: true },
    ];
    const res = await post(`/api/telegram/webhook/${TEST_SECRET}`, mkListMessage({ update_id: 20, chatId: LINKED_CHAT }));
    expect(res.status).toBe(200);
    const sent = state.sentMessages[0]!;
    expect(sent.keyboard).toBeDefined();
    // First button (row 0, col 0) is the orchestrator.
    expect(sent.keyboard[0][0].callback_data).toBe("s:orch-real");
    expect(sent.keyboard[0][0].text).toContain("🧭 Orchestrator");
  });

  test("zero sessions + orchestrator ENABLED → synthetic orchestrator row offered", async () => {
    state.user = {
      id: LINKED_USER_ID,
      email: "linked@example.com",
      telegram_chat_id: LINKED_CHAT,
      telegram_default_session_id: null,
    };
    state.sessions = [];
    state.orchEnabled = true;
    const res = await post(`/api/telegram/webhook/${TEST_SECRET}`, mkListMessage({ update_id: 21, chatId: LINKED_CHAT }));
    expect(res.status).toBe(200);
    const sent = state.sentMessages[0]!;
    // Keyboard present (not the "No sessions" plain text) with the synthetic row.
    expect(sent.keyboard).toBeDefined();
    expect(sent.keyboard[0][0].callback_data).toBe("s:__orchestrator__");
  });

  test("zero sessions + orchestrator DISABLED → plain 'No sessions' text", async () => {
    state.user = {
      id: LINKED_USER_ID,
      email: "linked@example.com",
      telegram_chat_id: LINKED_CHAT,
      telegram_default_session_id: null,
    };
    state.sessions = [];
    state.orchEnabled = false;
    const res = await post(`/api/telegram/webhook/${TEST_SECRET}`, mkListMessage({ update_id: 22, chatId: LINKED_CHAT }));
    expect(res.status).toBe(200);
    expect(state.sentMessages[0]!.keyboard).toBeUndefined();
    expect(state.sentMessages[0]!.text).toContain("No sessions");
  });

  test("tapping the synthetic orchestrator launches it + pins EXPLICITLY", async () => {
    state.user = {
      id: LINKED_USER_ID,
      email: "linked@example.com",
      telegram_chat_id: LINKED_CHAT,
      telegram_default_session_id: null,
    };
    state.sessions = [];
    state.orchEnabled = true;
    state.launchResult = { ok: true, sessionId: "sess-orch-real", runId: "r1", supervisorId: "sup-1", cwd: "/root", reused: false };
    const res = await post(
      `/api/telegram/webhook/${TEST_SECRET}`,
      mkCallback({ update_id: 23, chatId: LINKED_CHAT, data: "s:__orchestrator__" }),
    );
    expect(res.status).toBe(200);
    expect(state.launchCalls).toBe(1);
    // Pinned explicitly to the real launched session id.
    expect(state.setDefaults).toEqual([{ userId: LINKED_USER_ID, sessionId: "sess-orch-real", explicit: true }]);
    expect(state.user!.telegram_default_explicit).toBe(true);
  });

  test("tapping synthetic orchestrator with no online supervisor → friendly reply, no pin", async () => {
    state.user = {
      id: LINKED_USER_ID,
      email: "linked@example.com",
      telegram_chat_id: LINKED_CHAT,
      telegram_default_session_id: null,
    };
    state.sessions = [];
    state.orchEnabled = true;
    state.launchResult = { ok: false, reason: "no_online_supervisor" };
    const res = await post(
      `/api/telegram/webhook/${TEST_SECRET}`,
      mkCallback({ update_id: 24, chatId: LINKED_CHAT, data: "s:__orchestrator__" }),
    );
    expect(res.status).toBe(200);
    expect(state.launchCalls).toBe(1);
    expect(state.setDefaults.length).toBe(0); // no pin
    expect(state.sentMessages.some((m) => /no online supervisor/i.test(m.text))).toBe(true);
  });

  test("H-1: at_capacity → cost/concurrency reply, NOT a supervisor message, no pin", async () => {
    state.user = {
      id: LINKED_USER_ID,
      email: "linked@example.com",
      telegram_chat_id: LINKED_CHAT,
      telegram_default_session_id: null,
    };
    state.sessions = [];
    state.orchEnabled = true;
    state.launchResult = { ok: false, reason: "at_capacity", running: 5, cap: 5 };
    const res = await post(
      `/api/telegram/webhook/${TEST_SECRET}`,
      mkCallback({ update_id: 26, chatId: LINKED_CHAT, data: "s:__orchestrator__" }),
    );
    expect(res.status).toBe(200);
    expect(state.launchCalls).toBe(1);
    expect(state.setDefaults.length).toBe(0); // no pin
    const reply = state.sentMessages.find((m) => /daily limit reached|too many sessions/i.test(m.text));
    expect(reply).toBeDefined();
    // Must NOT blame the supervisor for a cap.
    expect(state.sentMessages.some((m) => /no online supervisor/i.test(m.text))).toBe(false);
  });
});

describe("pagination resilience", () => {
  test("editMessageText failure falls back to a fresh sendMessage (page still renders)", async () => {
    linkUser({ sessionCount: 70 });
    state.editFails = true; // editMessageText throws a non-'not modified' 400.
    const res = await post(
      `/api/telegram/webhook/${TEST_SECRET}`,
      mkCallback({ update_id: 25, chatId: LINKED_CHAT, data: "p:20" }),
    );
    expect(res.status).toBe(200);
    // Edit was attempted but recorded nothing (it threw).
    expect(state.editedMessages.length).toBe(0);
    // Fallback path: a NEW message was sent carrying the page-2 keyboard.
    const withKb = state.sentMessages.find((m) => m.keyboard);
    expect(withKb).toBeDefined();
    expect(withKb!.text).toContain("21–40 of 70");
    // Callback still answered (button doesn't spin).
    expect(state.callbackAnswers.length).toBe(1);
  });
});
