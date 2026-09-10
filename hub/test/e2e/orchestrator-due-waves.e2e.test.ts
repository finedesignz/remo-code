/**
 * Milestone OEE — Phase OEE-04: due-rows → controller → dependency-aware waves (e2e).
 *
 * PROVES, against REAL Postgres (never prod), that real `orchestrator_rows` +
 * `schedule_rule` windows flow through the DB-backed due-scan
 * (`computeDueRowsForTask`) into the controller's dependency-aware wave ordering
 * (`runWavesFromDueRows` / `planWaves`), and that an off-hours `merge-to-main` row
 * is DUE only inside its `schedule_rule.active_window`.
 *
 * Gating mirrors hub/test/phase-08.e2e.test.ts EXACTLY:
 *   - `describe.skip` without REMO_E2E_DB_URL (CI stays green / import-skips cleanly).
 *   - `process.env.DATABASE_URL = REMO_E2E_DB_URL` is set BEFORE the first DAL import
 *     (the shared `sql` in hub/src/db/postgres.ts binds at import time), via a lazy
 *     `await import(...)` inside `beforeAll`.
 *
 * This is PURE VALIDATION: it drives the REAL controller entrypoints with the
 * default STUB_SEAMS (no live `claude` subprocess, no network, no merge), so the
 * wave runner only writes placeholder run-log rows. No hub/src change, no schema
 * change, no cost-cap bypass, no flag flip.
 *
 * Run with:
 *   REMO_E2E_DB_URL=postgres://... bun test hub/test/e2e/orchestrator-due-waves.e2e.test.ts
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import postgres from 'postgres';
import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const HAS_TEST_DB = !!process.env.REMO_E2E_DB_URL;
const maybe = HAS_TEST_DB ? describe : describe.skip;

// A fixed reference instant so active_window math is deterministic. We build the
// merge row's window AROUND this instant's UTC wall-clock (tz='UTC' throughout),
// so "inside" vs "outside" the window is a controlled choice, not wall-clock luck.
const NOW = new Date('2026-06-15T12:00:00.000Z'); // 12:00 UTC

maybe('OEE-04 e2e — due-rows → controller → dependency-aware waves', () => {
  let dueRowsMod: typeof import('../../src/orchestrator/due-rows');
  let controllerMod: typeof import('../../src/orchestrator/controller');
  let wavesMod: typeof import('../../src/orchestrator/waves');
  let rowsDal: typeof import('../../src/db/orchestrator-rows-dal');
  let sql: ReturnType<typeof postgres>;

  let userId: string;
  let sessionId: string;
  let taskId: string;

  beforeAll(async () => {
    // Bind the shared hub `sql` to the disposable DB BEFORE importing any DAL.
    process.env.DATABASE_URL = process.env.REMO_E2E_DB_URL!;

    sql = postgres(process.env.REMO_E2E_DB_URL!, { max: 4, idle_timeout: 5 });

    // Boot the REAL schema.sql (idempotent DDL; safe to re-run) statement-by-statement.
    const migrate = await import('../../src/db/migrate.ts');
    const ddl = readFileSync(
      resolve(import.meta.dir, '../../src/db/schema.sql'),
      'utf-8',
    );
    for (const stmt of migrate.splitSqlStatements(ddl)) {
      try {
        await sql.unsafe(stmt);
      } catch {
        /* idempotent re-run — benign conflict */
      }
    }

    dueRowsMod = await import('../../src/orchestrator/due-rows');
    controllerMod = await import('../../src/orchestrator/controller');
    wavesMod = await import('../../src/orchestrator/waves');
    rowsDal = await import('../../src/db/orchestrator-rows-dal');

    // Synthetic user + session (FK targets; cascade-deleted on teardown).
    const u = await sql<{ id: string }[]>`
      INSERT INTO users (email, password_hash, role)
      VALUES (${`e2e-oee04-${randomUUID()}@invalid.local`}, 'x', 'user')
      RETURNING id
    `;
    userId = u[0].id;

    const s = await sql<{ id: string }[]>`
      INSERT INTO sessions (user_id, name, project_dir, token_hash)
      VALUES (${userId}, 'oee04', '/tmp/oee04', ${'th-' + randomUUID()})
      RETURNING id
    `;
    sessionId = s[0].id;

    // The one orchestrator task for this session (uses the real DAL).
    const task = await rowsDal.createOrchestratorTaskForSession(userId, sessionId, {
      stage: 'development',
    });
    taskId = task.id;
  }, 30_000);

  afterAll(async () => {
    if (userId) await sql`DELETE FROM users WHERE id = ${userId}`;
    await sql.end({ timeout: 5 });
  });

  // Build a "fire now" minutes rule that started before NOW (always eligible,
  // no window unless one is supplied).
  function fireNowRule(window?: { from: string; to: string }) {
    return {
      interval: 1,
      unit: 'minutes' as const,
      start_at: '2026-06-01T00:00:00.000Z',
      ...(window ? { active_window: window } : {}),
    };
  }

  test('plan→execute→ship chain sequences across dependency waves (real due-scan → planWaves)', async () => {
    // Seed the dependent chain (intentionally out of dependency order in sort_order
    // to prove the planner sequences by DEPENDENCY, not insertion order).
    await rowsDal.insertOrchestratorRow({
      task_id: taskId, command: 'ship', schedule_rule: fireNowRule(), sort_order: 0,
    });
    await rowsDal.insertOrchestratorRow({
      task_id: taskId, command: 'execute', schedule_rule: fireNowRule(), sort_order: 1,
    });
    await rowsDal.insertOrchestratorRow({
      task_id: taskId, command: 'plan', schedule_rule: fireNowRule(), sort_order: 2,
    });

    // REAL DB-backed due-scan (loads orchestrator_rows + run-log counts, applies
    // schedule eligibility via shouldSkipFire/isWithinActiveWindow).
    const due = await dueRowsMod.computeDueRowsForTask(taskId, {
      sessionId, now: NOW, tz: 'UTC',
    });
    const dueCommands = due.map((d) => d.row.command).sort();
    expect(dueCommands).toEqual(['execute', 'plan', 'ship']);

    // The controller's wave planner: plan(0) → execute(1) → ship(2).
    const plan = wavesMod.planWaves(due.map((d) => d.row.command));
    const waveCommands = plan.waves.map((w) => w.map((u) => u.command));
    expect(waveCommands).toEqual([['plan'], ['execute'], ['ship']]);
    expect(plan.dropped).not.toContain('plan');

    // Drive the REAL controller wave entrypoint end-to-end with STUB_SEAMS (no live
    // claude). It writes one placeholder routine_run_log row per command.
    const summary = await controllerMod.runWavesFromDueRows(due, {
      sessionId, repoKey: null, userId, decisionRationale: 'oee04-chain',
    });
    expect(summary.units).toBe(3);

    const logged = await sql<{ command: string }[]>`
      SELECT command FROM routine_run_log WHERE session_id = ${sessionId}
    `;
    const loggedCmds = logged.map((r) => r.command).sort();
    expect(loggedCmds).toEqual(['execute', 'plan', 'ship']);
  });

  test('merge-to-main row is EXCLUDED outside its active_window, eligible inside it', async () => {
    // Fresh task so the chain rows above do not interfere.
    const task2 = await rowsDal.createOrchestratorTaskForSession(
      userId,
      // reuse the same session is blocked by one-per-session; create a 2nd session.
      (await sql<{ id: string }[]>`
        INSERT INTO sessions (user_id, name, project_dir, token_hash)
        VALUES (${userId}, 'oee04-merge', '/tmp/oee04-merge', ${'th-' + randomUUID()})
        RETURNING id
      `)[0].id,
      { stage: 'production-maintenance' },
    );

    // Off-hours window 02:00–04:00 UTC. NOW is 12:00 UTC → OUTSIDE the window.
    await rowsDal.insertOrchestratorRow({
      task_id: task2.id,
      command: 'merge-to-main',
      schedule_rule: fireNowRule({ from: '02:00', to: '04:00' }),
      sort_order: 0,
    });

    // OUTSIDE the window → not due.
    const outside = await dueRowsMod.computeDueRowsForTask(task2.id, {
      sessionId: task2.session_id!, now: NOW, tz: 'UTC',
    });
    expect(outside.map((d) => d.row.command)).not.toContain('merge-to-main');

    // INSIDE the window (03:00 UTC) → due. Same row, same DB, only the clock moves.
    const insideNow = new Date('2026-06-15T03:00:00.000Z');
    const inside = await dueRowsMod.computeDueRowsForTask(task2.id, {
      sessionId: task2.session_id!, now: insideNow, tz: 'UTC',
    });
    expect(inside.map((d) => d.row.command)).toContain('merge-to-main');

    // Even when DUE, merge-to-main is EXCLUDED from the wave planner (off-hours
    // special path), so the dependency-aware waves never carry it.
    const plan = wavesMod.planWaves(inside.map((d) => d.row.command));
    const planned = plan.waves.flat().map((u) => u.command);
    expect(planned).not.toContain('merge-to-main');
    expect(plan.dropped).toContain('merge-to-main');
  });

  test('scanAndEnqueueDueCycles enqueues a session with a due window-active row (real routine_queue)', async () => {
    // The enabled orchestrator task for `sessionId` (enabled by toggling the row)
    // has the plan/execute/ship rows from test 1, all due at NOW → the scan should
    // enqueue this session into the REAL routine_queue.
    await sql`UPDATE scheduled_tasks SET enabled = true WHERE id = ${taskId}`;

    const enqueued = await controllerMod.scanAndEnqueueDueCycles(NOW);
    expect(enqueued).toContain(sessionId);

    const q = await sql<{ session_id: string; status: string }[]>`
      SELECT session_id, status FROM routine_queue WHERE session_id = ${sessionId}
    `;
    expect(q.length).toBeGreaterThanOrEqual(1);
    expect(q[0].status).toBe('pending');
  });
});

// Always-on sanity test so the file always reports to `bun test`.
describe('OEE-04 e2e — harness sanity', () => {
  test('e2e is gated on REMO_E2E_DB_URL', () => {
    expect(typeof HAS_TEST_DB).toBe('boolean');
    if (!HAS_TEST_DB) {
      console.log(
        '[e2e] REMO_E2E_DB_URL not set — OEE-04 due-waves e2e is SKIPPED. ' +
          'Set REMO_E2E_DB_URL to a disposable Postgres URL to run it.',
      );
    }
  });
});
