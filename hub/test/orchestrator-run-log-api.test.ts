// hub/test/orchestrator-run-log-api.test.ts
// OBSRV-01 / RUNLOG-01/02 — GET /api/orchestrator/run-log
//
// Run in isolation (Bun per-file process) via check-baseline.
// Mocks: hub/src/orchestrator/run-log (listRunLog) + the auth middleware shim.

import { describe, test, expect, mock, beforeAll, afterAll } from 'bun:test';
import type { RoutineRunLogEntry } from '../src/orchestrator/run-log';

// ── Fixtures ─────────────────────────────────────────────────────────────────

const SESSION_A = 'aaaa0000-0000-0000-0000-000000000001';
const SESSION_B = 'bbbb0000-0000-0000-0000-000000000002';
const USER_A    = 'user-aaaa-0000-0000-0000-000000000001';
const USER_B    = 'user-bbbb-0000-0000-0000-000000000002';

function makeRow(overrides: Partial<RoutineRunLogEntry> = {}): RoutineRunLogEntry {
  return {
    id: 'row-0001-0000-0000-0000-000000000001',
    session_id: SESSION_A,
    repo_key: 'github://finedesignz/remo-code',
    command: 'run tests',
    decision_rationale: 'CI gate requires passing tests',
    outcome: 'success',
    gap_dimension: null,
    pr_url: 'https://github.com/finedesignz/remo-code/pull/1',
    reviewer_verdict: 'LGTM',
    deploy_verify_result: 'ok',
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

// ── Module mocks (must be before any dynamic import of the app) ───────────────

// 1. Auth middleware — expose userId via request header; bypasses Titanium
mock.module('../src/middleware/auth', () => ({
  authMiddleware: (c: any, next: () => Promise<void>) => {
    const userId = c.req.header('x-test-user-id') ?? USER_A;
    c.set('userId', userId);
    return next();
  },
  requireRecentAuth: () => (_c: any, next: () => Promise<void>) => next(),
}));

// 2. orchestratorStepUp — pass-through
mock.module('../src/middleware/orchestrator-step-up', () => ({
  orchestratorStepUp: (_opts: any) => (_c: any, next: () => Promise<void>) => next(),
}));

// 3. The run-log module — we control what listRunLog returns
const listRunLogMock = mock(async (_opts: any): Promise<RoutineRunLogEntry[]> => []);

mock.module('../src/orchestrator/run-log', () => ({
  listRunLog: listRunLogMock,
  appendRunLog: mock(async () => makeRow()),
  recentRunLog: mock(async () => []),
}));

// 4. Stub any DB/orchestrator deps that the orchestrator.ts route file imports
mock.module('../src/db/orchestrator-dal', () => ({
  getOrchestratorState: mock(async () => ({ orchestrator_enabled: false, orchestrator_name: 'Orchestrator', orchestrator_custom_instructions: null })),
  updateOrchestratorState: mock(async () => {}),
  findOpenOrchestratorSession: mock(async () => null),
}));

mock.module('../src/orchestrator/auto-launch', () => ({
  launchOrchestrator: mock(async () => ({ ok: false, reason: 'disabled' })),
}));

mock.module('../src/ws/supervisor-registry', () => ({
  sendToSupervisor: mock(() => {}),
  listOnlineSupervisorIdsForUser: mock(() => []),
}));

// ── App bootstrap ─────────────────────────────────────────────────────────────

let app: any;

beforeAll(async () => {
  // Import after mocks are installed
  const { orchestrator } = await import('../src/api/orchestrator');
  const { Hono } = await import('hono');

  const testApp = new Hono();
  // Inject userId from test header (mirrors the real authMiddleware contract)
  testApp.use('/api/orchestrator/*', async (c, next) => {
    const userId = c.req.header('x-test-user-id') ?? USER_A;
    c.set('userId', userId);
    await next();
  });
  testApp.route('/api/orchestrator', orchestrator);
  app = testApp;
});

afterAll(() => {
  mock.restore();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('GET /api/orchestrator/run-log', () => {
  test('returns 200 with empty items when no rows', async () => {
    listRunLogMock.mockImplementation(async () => []);
    const res = await app.request('/api/orchestrator/run-log', {
      headers: { 'x-test-user-id': USER_A },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ items: [], limit: 50, offset: 0 });
  });

  test('returns rows for the authenticated user', async () => {
    const row = makeRow();
    listRunLogMock.mockImplementation(async () => [row]);
    const res = await app.request('/api/orchestrator/run-log', {
      headers: { 'x-test-user-id': USER_A },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0].id).toBe(row.id);
    expect(body.items[0].pr_url).toBe(row.pr_url);
    expect(body.items[0].reviewer_verdict).toBe(row.reviewer_verdict);
  });

  test('user-scoping: user B cannot see user A rows (DAL called with correct userId)', async () => {
    const captured: any[] = [];
    listRunLogMock.mockImplementation(async (opts) => { captured.push(opts); return []; });

    await app.request('/api/orchestrator/run-log', {
      headers: { 'x-test-user-id': USER_B },
    });

    expect(captured).toHaveLength(1);
    expect(captured[0].userId).toBe(USER_B);
    // Critically: NOT USER_A
    expect(captured[0].userId).not.toBe(USER_A);
  });

  test('session_id filter is forwarded to listRunLog', async () => {
    const captured: any[] = [];
    listRunLogMock.mockImplementation(async (opts) => { captured.push(opts); return []; });

    await app.request(`/api/orchestrator/run-log?session_id=${SESSION_A}`, {
      headers: { 'x-test-user-id': USER_A },
    });

    expect(captured).toHaveLength(1);
    expect(captured[0].sessionId).toBe(SESSION_A);
  });

  test('pagination params are forwarded correctly', async () => {
    const captured: any[] = [];
    listRunLogMock.mockImplementation(async (opts) => { captured.push(opts); return []; });

    const res = await app.request('/api/orchestrator/run-log?limit=10&offset=20', {
      headers: { 'x-test-user-id': USER_A },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.limit).toBe(10);
    expect(body.offset).toBe(20);
    expect(captured[0].limit).toBe(10);
    expect(captured[0].offset).toBe(20);
  });

  test('invalid limit returns 400', async () => {
    const res = await app.request('/api/orchestrator/run-log?limit=999', {
      headers: { 'x-test-user-id': USER_A },
    });
    expect(res.status).toBe(400);
  });

  test('invalid offset (negative) returns 400', async () => {
    const res = await app.request('/api/orchestrator/run-log?offset=-1', {
      headers: { 'x-test-user-id': USER_A },
    });
    expect(res.status).toBe(400);
  });

  test('response shape includes all run-log fields', async () => {
    const row = makeRow();
    listRunLogMock.mockImplementation(async () => [row]);

    const res = await app.request('/api/orchestrator/run-log', {
      headers: { 'x-test-user-id': USER_A },
    });
    const body = await res.json();
    const item = body.items[0];

    // RUNLOG-01: required fields
    expect(item).toHaveProperty('id');
    expect(item).toHaveProperty('session_id');
    expect(item).toHaveProperty('command');
    expect(item).toHaveProperty('decision_rationale');
    expect(item).toHaveProperty('outcome');
    expect(item).toHaveProperty('pr_url');
    expect(item).toHaveProperty('reviewer_verdict');
    expect(item).toHaveProperty('deploy_verify_result');
    expect(item).toHaveProperty('created_at');
  });
});
