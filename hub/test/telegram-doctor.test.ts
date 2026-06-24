/**
 * Phase 12 Wave 4 — /doctor command + launchSessionForUser tests.
 *
 * No DB, no network. Mocks db/postgres, db/supervisor-dal, sessions/budget,
 * ws/registry, ws/supervisor-registry, telegram/client.
 */
import { describe, test, expect, beforeEach, mock } from "bun:test";

process.env.TELEGRAM_BOT_TOKEN = "fake-bot-token-doctor";
process.env.TELEGRAM_WEBHOOK_SECRET = "test-secret-must-be-at-least-16-chars";
process.env.TELEGRAM_BOT_USERNAME = "remocode_test_bot";

// ── Mutable state ──────────────────────────────────────────────────────────

const state: {
  sessions: Map<string, { id: string; user_id: string; name: string | null; project_dir: string | null; hostname: string | null; deleted_at: string | null }>;
  supervisors: Array<{ id: string; user_id: string; hostname: string; last_seen_at: Date; online: boolean }>;
  channels: Map<string, { ws: any; userId: string; sessionId: string }>;
  reserveOutcome: { ok: true } | { ok: false; reason: "at_capacity"; running: number; cap: number } | { ok: false; reason: "supervisor_not_found" };
  runIdCounter: number;
  sends: Array<{ chat: number | string; text: string }>;
  sentToSupervisor: Array<{ supervisorId: string; msg: any }>;
  stateUpdates: Array<{ supervisorId: string; state: string; runId: string | null }>;
  sendToSupervisorThrows: boolean;
} = {
  sessions: new Map(),
  supervisors: [],
  channels: new Map(),
  reserveOutcome: { ok: true },
  runIdCounter: 0,
  sends: [],
  sentToSupervisor: [],
  stateUpdates: [],
  sendToSupervisorThrows: false,
};

// ── Mocks ──────────────────────────────────────────────────────────────────

// Tagged-template sql that pattern-matches the session SELECT. Both doctor.ts
// and launch.ts issue that query.
mock.module("../src/db/postgres.ts", () => ({
  sql: async (strings: TemplateStringsArray, ...values: any[]) => {
    const text = strings.join("?");
    if (text.includes("FROM sessions")) {
      const sessionId = values.find((v) => typeof v === "string" && state.sessions.has(v));
      if (sessionId) {
        const row = state.sessions.get(sessionId)!;
        return [row];
      }
      return [];
    }
    return [];
  },
}));

mock.module("../src/db/supervisor-dal.ts", () => ({
  listSupervisorsForUser: async (userId: string) =>
    state.supervisors.filter((s) => s.user_id === userId).map((s) => ({
      id: s.id,
      hostname: s.hostname,
      last_seen_at: s.last_seen_at,
    })),
  createRun: async (_args: any) => {
    state.runIdCounter++;
    return { id: `run_${state.runIdCounter}` };
  },
}));

mock.module("../src/sessions/budget.ts", () => ({
  // Run row is consumed inside the reservation tx now (atomic gate): a granted
  // reservation given runFields carries the created run.
  reserveSessionSlot: async (_uid: string, _sid: string, runFields?: any) => {
    const o: any = state.reserveOutcome;
    if (o.ok && runFields) {
      state.runIdCounter++;
      return { ...o, running: o.running ?? 0, cap: o.cap ?? 1, run: { id: `run_${state.runIdCounter}` } };
    }
    return o;
  },
}));

mock.module("../src/ws/registry.ts", () => ({
  getChannel: (sid: string) => state.channels.get(sid),
}));

mock.module("../src/ws/supervisor-registry.ts", () => ({
  isSupervisorOnline: (sid: string) => {
    const s = state.supervisors.find((x) => x.id === sid);
    return !!s?.online;
  },
  sendToSupervisor: (supervisorId: string, msg: any) => {
    if (state.sendToSupervisorThrows) throw new Error("supervisor offline");
    state.sentToSupervisor.push({ supervisorId, msg });
  },
  updateSupervisorState: async (supervisorId: string, st: string, runId: string | null) => {
    state.stateUpdates.push({ supervisorId, state: st, runId });
  },
}));

mock.module("../src/telegram/client.ts", () => ({
  sendMessage: async (chatId: number | string, text: string) => {
    state.sends.push({ chat: chatId, text });
  },
}));

// Dispatch mock — used by the auto-replay branch in runDoctor.
const dispatchCalls: any[] = [];
let dispatchKind: "dispatched" | "cost_capped" | "session_busy" | "agent_offline" | "no_session" | "failed" = "dispatched";
mock.module("../src/telegram/dispatch.ts", () => ({
  dispatchToSession: async (input: any) => {
    dispatchCalls.push(input);
    switch (dispatchKind) {
      case "dispatched": return { kind: "dispatched" };
      case "cost_capped": return { kind: "cost_capped", resumesAtUtc: "2026-05-29T00:00:00.000Z" };
      case "session_busy": return { kind: "session_busy" };
      case "agent_offline": return { kind: "agent_offline" };
      case "no_session": return { kind: "no_session" };
      case "failed": return { kind: "failed", reason: "test" };
    }
  },
}));

// Imports AFTER mocks.
const { runDoctor, bufferReplay, _resetReplayBufferForTests, hasBufferedReplay } = await import("../src/telegram/doctor.ts");
const { launchSessionForUser } = await import("../src/telegram/launch.ts");

// ── Fixtures ───────────────────────────────────────────────────────────────

const USER_ID = "user-1";
const CHAT_ID = 555;
const SESSION_ID = "sess-abc";
const SUPERVISOR_ID = "sup-1";
const HOSTNAME = "devbox";

function freshUser(over: Partial<{ chat: number | null; defaultSession: string | null }> = {}) {
  return {
    id: USER_ID,
    email: "u@example.com",
    telegram_chat_id: over.chat === undefined ? CHAT_ID : over.chat,
    telegram_default_session_id: over.defaultSession === undefined ? SESSION_ID : over.defaultSession,
  } as any;
}

function fakeChannel(): any {
  return { ws: { send: () => {} }, userId: USER_ID, sessionId: SESSION_ID };
}

beforeEach(() => {
  state.sessions.clear();
  state.supervisors.length = 0;
  state.channels.clear();
  state.reserveOutcome = { ok: true };
  state.runIdCounter = 0;
  state.sends.length = 0;
  state.sentToSupervisor.length = 0;
  state.stateUpdates.length = 0;
  state.sendToSupervisorThrows = false;
  dispatchCalls.length = 0;
  dispatchKind = "dispatched";
  _resetReplayBufferForTests();
  state.sessions.set(SESSION_ID, {
    id: SESSION_ID,
    user_id: USER_ID,
    name: "kh-hub",
    project_dir: "C:/repos/kh-hub",
    hostname: HOSTNAME,
    deleted_at: null,
  });
  state.supervisors.push({
    id: SUPERVISOR_ID,
    user_id: USER_ID,
    hostname: HOSTNAME,
    last_seen_at: new Date(),
    online: true,
  });
});

// ── /doctor tests ─────────────────────────────────────────────────────────

describe("runDoctor", () => {
  test("fails check 1 when telegram_chat_id is missing", async () => {
    const user = freshUser({ chat: null });
    const r = await runDoctor({ user, chatId: CHAT_ID });
    expect(r.outcome).toBe("cmd_doctor_no_chat");
    expect(state.sends.length).toBeGreaterThanOrEqual(2);
    expect(state.sends[1]!.text).toContain("Check 1/6");
    expect(state.sends[1]!.text).toContain("not linked");
  });

  test("fails check 2 when default session missing", async () => {
    const user = freshUser({ defaultSession: null });
    const r = await runDoctor({ user, chatId: CHAT_ID });
    expect(r.outcome).toBe("cmd_doctor_no_session");
    const join = state.sends.map((s) => s.text).join("\n");
    expect(join).toContain("✅ Check 1/6");
    expect(join).toContain("❌ Check 2/6");
    expect(join).toContain("/list");
  });

  test("fails check 3 when session deleted", async () => {
    state.sessions.get(SESSION_ID)!.deleted_at = new Date().toISOString();
    const r = await runDoctor({ user: freshUser(), chatId: CHAT_ID });
    expect(r.outcome).toBe("cmd_doctor_session_gone");
  });

  test("fails check 4 when supervisor stale", async () => {
    state.supervisors[0]!.online = false; // simulate offline (or stale)
    const r = await runDoctor({ user: freshUser(), chatId: CHAT_ID });
    expect(r.outcome).toBe("cmd_doctor_supervisor_offline");
    expect(state.sends.find((s) => s.text.includes("Check 4/6") && s.text.includes("isn't connected"))).toBeDefined();
  });

  test("green path: channel present → everything looks good", async () => {
    state.channels.set(SESSION_ID, fakeChannel());
    const r = await runDoctor({ user: freshUser(), chatId: CHAT_ID });
    expect(r.outcome).toBe("cmd_doctor_ok");
    const last = state.sends[state.sends.length - 1]!.text;
    expect(last).toContain("Everything looks good");
  });

  test("auto-fix: no channel → launches + deferred-poll fires success when channel appears", async () => {
    let cb: (() => void) | null = null;
    const r = await runDoctor({
      user: freshUser(),
      chatId: CHAT_ID,
      scheduleDelayed: (fn) => { cb = fn; },
      pollWindowMs: 100,
    });
    expect(r.outcome).toBe("cmd_doctor_launched");
    // session.start was sent + state updated to 'starting'
    expect(state.sentToSupervisor.length).toBe(1);
    expect(state.sentToSupervisor[0]!.msg.type).toBe("session.start");
    expect(state.sentToSupervisor[0]!.msg.api_key).toBe("__use_local__");
    expect(state.stateUpdates[0]!.state).toBe("starting");
    expect(state.sends.find((s) => s.text.includes("Launching"))).toBeDefined();

    // Simulate the runner coming online before the deferred check fires.
    state.channels.set(SESSION_ID, fakeChannel());
    cb!();
    // Yield once so the safeSay promise's microtask runs.
    await new Promise((r2) => setTimeout(r2, 5));
    expect(state.sends.find((s) => s.text.includes("Launch complete"))).toBeDefined();
  });

  test("auto-fix: deferred poll → timeout reply when channel never appears", async () => {
    let cb: (() => void) | null = null;
    await runDoctor({
      user: freshUser(),
      chatId: CHAT_ID,
      scheduleDelayed: (fn) => { cb = fn; },
      pollWindowMs: 100,
    });
    cb!();
    await new Promise((r2) => setTimeout(r2, 5));
    expect(state.sends.find((s) => s.text.includes("taking longer than expected"))).toBeDefined();
  });

  test("at-capacity blocks launch — no run created", async () => {
    state.reserveOutcome = { ok: false, reason: "at_capacity", running: 3, cap: 3 };
    const r = await runDoctor({
      user: freshUser(),
      chatId: CHAT_ID,
      scheduleDelayed: () => {},
    });
    expect(r.outcome).toBe("cmd_doctor_at_capacity");
    expect(state.sentToSupervisor.length).toBe(0);
    expect(state.runIdCounter).toBe(0);
    expect(state.sends.find((s) => s.text.includes("concurrency cap"))).toBeDefined();
  });
});

// ── launchSessionForUser direct tests ─────────────────────────────────────

describe("launchSessionForUser", () => {
  test("happy path returns ok with run id + sends session.start", async () => {
    const r = await launchSessionForUser({ userId: USER_ID, sessionId: SESSION_ID });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.runId).toBe("run_1");
      expect(r.hostname).toBe(HOSTNAME);
      expect(r.repoPath).toBe("C:/repos/kh-hub");
    }
    expect(state.sentToSupervisor[0]!.msg.type).toBe("session.start");
  });

  test("session not found", async () => {
    const r = await launchSessionForUser({ userId: USER_ID, sessionId: "missing" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("session_not_found");
  });

  test("at capacity returns at_capacity with running/cap", async () => {
    state.reserveOutcome = { ok: false, reason: "at_capacity", running: 2, cap: 2 };
    const r = await launchSessionForUser({ userId: USER_ID, sessionId: SESSION_ID });
    expect(r.ok).toBe(false);
    if (!r.ok && r.reason === "at_capacity") {
      expect(r.running).toBe(2);
      expect(r.cap).toBe(2);
    }
  });

  test("no online supervisor matches session hostname", async () => {
    state.supervisors[0]!.online = false;
    const r = await launchSessionForUser({ userId: USER_ID, sessionId: SESSION_ID });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("no_online_supervisor");
  });
});

// ── Auto-replay buffer tests ──────────────────────────────────────────────

describe("auto-replay buffer", () => {
  test("autoheal opener differs from manual /doctor opener", async () => {
    state.channels.set(SESSION_ID, fakeChannel());
    await runDoctor({ user: freshUser(), chatId: CHAT_ID, autoheal: true });
    expect(state.sends[0]!.text).toContain("Hold on");
    expect(state.sends[0]!.text).toContain("diagnosing");
  });

  test("auto-replay fires on successful launch when buffer present", async () => {
    bufferReplay(CHAT_ID, { text: "hello buffered", originalUpdateId: 777 });
    expect(hasBufferedReplay(CHAT_ID)).toBe(true);

    let cb: (() => void) | null = null;
    await runDoctor({
      user: freshUser(),
      chatId: CHAT_ID,
      autoheal: true,
      scheduleDelayed: (fn) => { cb = fn; },
      pollWindowMs: 50,
    });
    // Channel comes online before the deferred fires.
    state.channels.set(SESSION_ID, fakeChannel());
    cb!();
    // Yield enough turns for the deferred-async chain.
    await new Promise((r) => setTimeout(r, 10));
    expect(dispatchCalls.length).toBe(1);
    expect(dispatchCalls[0].text).toBe("hello buffered");
    // updateId is negated so audit UNIQUE can't collide.
    expect(dispatchCalls[0].updateId).toBe(-777);
    // Buffer cleared after consumption.
    expect(hasBufferedReplay(CHAT_ID)).toBe(false);
    expect(state.sends.find((s) => s.text.includes("sent your message"))).toBeDefined();
  });

  test("auto-replay skipped + buffer dropped on launch timeout", async () => {
    bufferReplay(CHAT_ID, { text: "stale", originalUpdateId: 1 });
    let cb: (() => void) | null = null;
    await runDoctor({
      user: freshUser(),
      chatId: CHAT_ID,
      autoheal: true,
      scheduleDelayed: (fn) => { cb = fn; },
      pollWindowMs: 50,
    });
    // No channel — timeout path.
    cb!();
    await new Promise((r) => setTimeout(r, 10));
    expect(dispatchCalls.length).toBe(0);
    expect(hasBufferedReplay(CHAT_ID)).toBe(false);
    expect(state.sends.find((s) => s.text.includes("taking longer"))).toBeDefined();
  });

  test("second buffer call overwrites the first (most-recent-wins)", async () => {
    bufferReplay(CHAT_ID, { text: "first", originalUpdateId: 1 });
    const r = bufferReplay(CHAT_ID, { text: "second", originalUpdateId: 2 });
    expect(r.replaced).toBe(true);

    let cb: (() => void) | null = null;
    await runDoctor({
      user: freshUser(),
      chatId: CHAT_ID,
      autoheal: true,
      scheduleDelayed: (fn) => { cb = fn; },
      pollWindowMs: 50,
    });
    state.channels.set(SESSION_ID, fakeChannel());
    cb!();
    await new Promise((r) => setTimeout(r, 10));
    expect(dispatchCalls.length).toBe(1);
    expect(dispatchCalls[0].text).toBe("second");
  });

  test("cost-cap on auto-replay → reports it, no loop into doctor", async () => {
    bufferReplay(CHAT_ID, { text: "expensive", originalUpdateId: 9 });
    dispatchKind = "cost_capped";
    let cb: (() => void) | null = null;
    await runDoctor({
      user: freshUser(),
      chatId: CHAT_ID,
      autoheal: true,
      scheduleDelayed: (fn) => { cb = fn; },
      pollWindowMs: 50,
    });
    state.channels.set(SESSION_ID, fakeChannel());
    cb!();
    await new Promise((r) => setTimeout(r, 10));
    expect(state.sends.find((s) => s.text.toLowerCase().includes("cost cap"))).toBeDefined();
  });
});
