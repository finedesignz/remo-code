/**
 * Milestone OEE — Phase OEE-09: legacy-wave rollback parity (e2e).
 *
 * SMOKE-PROVES the documented rollback lever `REMO_ORCHESTRATOR_LEGACY_WAVES=1`
 * against REAL Postgres (never prod). The DEFAULT cycle path is the TMAC macro
 * path (`runMacroCycle`); the LEGACY per-micro-command-row wave engine is preserved
 * ONLY behind this env flag. This file proves the lever still works end-to-end:
 *
 *   - With `REMO_ORCHESTRATOR_LEGACY_WAVES=1`, the REAL cycle-runner
 *     (`makeCycleRunner`) routes through the LEGACY wave path
 *     (`runWavesFromDueRows` / `runWavePlan`), NOT `runMacroCycle`: it executes a
 *     seeded task's DUE command rows through the real legacy wave engine against
 *     real PG and records one `routine_run_log` row per command. The macro path,
 *     by contrast, writes NO wave run-log rows (it injects ONE macro prompt and
 *     reconciles sentinels from a prior reply, of which there is none here).
 *
 *   - The path selector (`useMacroPath`) actually flips with the flag (contrast).
 *
 * Gating mirrors hub/test/phase-08.e2e.test.ts / orchestrator-due-waves.e2e.test.ts:
 *   - `describe.skip` without REMO_E2E_DB_URL (CI stays green / import-skips cleanly).
 *   - `process.env.DATABASE_URL = REMO_E2E_DB_URL` set BEFORE the first DAL import
 *     (the shared `sql` binds at import time), via lazy `await import(...)`.
 *   - `REMO_ORCHESTRATOR_LEGACY_WAVES` is read at CALL time by `useMacroPath()`, so
 *     we toggle it per-test and DELETE it in afterEach/afterAll (no env pollution;
 *     check-baseline runs each file in its own process so this is also isolated).
 *
 * PURE VALIDATION: drives the REAL controller entrypoint with STUB_SEAMS (no live
 * `claude` subprocess, no network, no merge, no PR). No hub/src change, no schema
 * change, no cost-cap bypass. `REMO_ORCHESTRATOR_ENABLED` is NEVER flipped — we
 * call the cycle-runner directly, bypassing the flag-gated registration entirely.
 *
 * Run with:
 *   REMO_E2E_DB_URL=postgres://... bun test hub/test/e2e/orchestrator-legacy-wave-parity.e2e.test.ts
 */
import { describe, test, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import postgres from 'postgres';
import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const HAS_TEST_DB = !!process.env.REMO_E2E_DB_URL;
const maybe = HAS_TEST_DB ? describe : describe.skip;

// Fixed reference instant so a "fire now" minutes rule is deterministically due.
const NOW = new Date('2026-06-15T12:00:00.000Z');

maybe('OEE-09 e2e — legacy-wave rollback parity (REMO_ORCHESTRATOR_LEGACY_WAVES=1)', () => {
  let controllerMod: typeof import('../../src/orchestrator/controller');
  let wavesMod: typeof import('../../src/orchestrator/waves');
  let waveRunnerMod: typeof import('../../src/orchestrator/wave-runner');
  let rowsDal: typeof import('../../src/db/orchestrator-rows-dal');
  let sql: ReturnType<typeof postgres>;

  let userId: string;
  let sessionId: string;
  let taskId: string;

  // Minimal RoutineQueueEntry shape the CycleRunner consumes (only session_id is
  // load-bearing — resolveCycleContext fans it out to user/task/stage via the DB).
  function queueEntry(sid: string) {
    return {
      id: `q-${randomUUID()}`,
      session_id: sid,
      priority: 0,
      status: 'running',
      enqueued_at: '',
      started_at: null,
    } as any;
  }

  // A "fire now" minutes rule that started before NOW → always eligible.
  function fireNowRule() {
    return {
      interval: 1,
      unit: 'minutes' as const,
      start_at: '2026-06-01T00:00:00.000Z',
    };
  }

  beforeAll(async () => {
    // Bind the shared hub `sql` to the disposable DB BEFORE importing any DAL.
    process.env.DATABASE_URL = process.env.REMO_E2E_DB_URL!;
    // Ensure a clean selector baseline; each test sets the flag it needs.
    delete process.env.REMO_ORCHESTRATOR_LEGACY_WAVES;

    sql = postgres(process.env.REMO_E2E_DB_URL!, { max: 4, idle_timeout: 5 });

    // Boot the REAL schema.sql (idempotent DDL; safe to re-run) statement-by-statement.
    const migrate = await import('../../src/db/migrate.ts');
    const ddl = readFileSync(resolve(import.meta.dir, '../../src/db/schema.sql'), 'utf-8');
    for (const stmt of migrate.splitSqlStatements(ddl)) {
      try {
        await sql.unsafe(stmt);
      } catch {
        /* idempotent re-run — benign conflict */
      }
    }

    controllerMod = await import('../../src/orchestrator/controller');
    wavesMod = await import('../../src/orchestrator/waves');
    waveRunnerMod = await import('../../src/orchestrator/wave-runner');
    rowsDal = await import('../../src/db/orchestrator-rows-dal');

    // Synthetic user + session (FK targets; cascade-deleted on teardown).
    const u = await sql<{ id: string }[]>`
      INSERT INTO users (email, password_hash, role)
      VALUES (${`e2e-oee09-${randomUUID()}@invalid.local`}, 'x', 'user')
      RETURNING id
    `;
    userId = u[0].id;

    const s = await sql<{ id: string }[]>`
      INSERT INTO sessions (user_id, name, project_dir, token_hash)
      VALUES (${userId}, 'oee09', '/tmp/oee09', ${'th-' + randomUUID()})
      RETURNING id
    `;
    sessionId = s[0].id;

    // The one orchestrator task for this session (uses the real DAL). Stage
    // 'development' keeps the macro path silent (matters only for the contrast test).
    const task = await rowsDal.createOrchestratorTaskForSession(userId, sessionId, {
      stage: 'development',
    });
    taskId = task.id;

    // Seed ONE due 'plan' command row (independent — single wave, single run-log row).
    await rowsDal.insertOrchestratorRow({
      task_id: taskId,
      command: 'plan',
      schedule_rule: fireNowRule(),
      sort_order: 0,
    });
  });

  afterEach(() => {
    // The selector reads the env at CALL time — never leave it set between tests.
    delete process.env.REMO_ORCHESTRATOR_LEGACY_WAVES;
  });

  afterAll(async () => {
    delete process.env.REMO_ORCHESTRATOR_LEGACY_WAVES;
    if (userId) await sql`DELETE FROM users WHERE id = ${userId}`;
    await sql.end({ timeout: 5 });
  });

  test('flag flips the selector: legacy wave path selected when set, macro path when unset', () => {
    delete process.env.REMO_ORCHESTRATOR_LEGACY_WAVES;
    expect(controllerMod.useMacroPath()).toBe(true); // default → macro path

    process.env.REMO_ORCHESTRATOR_LEGACY_WAVES = '1';
    expect(controllerMod.useMacroPath()).toBe(false); // rollback → legacy wave path
  });

  test('REMO_ORCHESTRATOR_LEGACY_WAVES=1: REAL cycle-runner drives the legacy wave engine → run-log row per command', async () => {
    process.env.REMO_ORCHESTRATOR_LEGACY_WAVES = '1';
    expect(controllerMod.useMacroPath()).toBe(false);

    // Sanity: the seeded 'plan' row is DUE at NOW and the wave planner keeps it.
    const due = await controllerMod.buildControllerContext({
      userId,
      sessionId,
      taskId,
      stage: 'development',
      now: NOW,
      tz: 'UTC',
    });
    expect(due.dueRows.map((d) => d.row.command)).toContain('plan');
    expect(wavesMod.planWaves(['plan']).waves.flat().map((u) => u.command)).toEqual(['plan']);

    // Build the REAL cycle-runner with the DEFAULT resolve deps (real DB reads) but
    // STUB_SEAMS so the wave engine writes placeholder run-log rows WITHOUT a live
    // `claude` subprocess / network / PR. `buildControllerContext` inside resolve
    // uses `new Date()` for the due-scan, but the seeded minutes rule is "fire now"
    // (eligible at any instant after start_at), so 'plan' is due regardless.
    const runner = controllerMod.makeCycleRunner(undefined, waveRunnerMod.STUB_SEAMS);
    await runner(queueEntry(sessionId));

    // The legacy wave engine wrote a routine_run_log row for the seeded 'plan'
    // command. Scope to THIS test's own session and assert CONTAINMENT of the
    // expected legacy 'plan' row carrying the STUB_SEAMS placeholder outcome —
    // robust to extra wave/verify rows (e.g. a 'deploy-verify' verify-tail row)
    // that the wave engine may also emit. The macro path would write NEITHER.
    const logged = await sql<{ command: string; outcome: string | null }[]>`
      SELECT command, outcome FROM routine_run_log WHERE session_id = ${sessionId}
    `;
    expect(logged.map((r) => r.command)).toContain('plan');
    // STUB_SEAMS reports its placeholder outcome on the 'plan' row — proves the
    // WAVE engine ran (the macro path would never write this row).
    const planRow = logged.find((r) => r.command === 'plan');
    expect(planRow?.outcome).toBe('skipped_phase25_stub');
  });

  test('contrast — default (flag unset) macro path writes NO wave run-log row', async () => {
    delete process.env.REMO_ORCHESTRATOR_LEGACY_WAVES;
    expect(controllerMod.useMacroPath()).toBe(true);

    // Fresh session+task so the legacy-test's run-log row does not bleed in.
    const s2 = (
      await sql<{ id: string }[]>`
        INSERT INTO sessions (user_id, name, project_dir, token_hash)
        VALUES (${userId}, 'oee09-macro', '/tmp/oee09-macro', ${'th-' + randomUUID()})
        RETURNING id
      `
    )[0].id;
    const task2 = await rowsDal.createOrchestratorTaskForSession(userId, s2, {
      stage: 'development',
    });
    await rowsDal.insertOrchestratorRow({
      task_id: task2.id,
      command: 'plan',
      schedule_rule: fireNowRule(),
      sort_order: 0,
    });

    // Same REAL cycle-runner; with the flag UNSET it routes through runMacroCycle.
    // No agent reply is scripted into this DB session, so the macro cycle injects a
    // prompt (which finds no live agent socket → no_session) and writes NO wave
    // run-log row — i.e. it is NOT the legacy wave engine.
    const runner = controllerMod.makeCycleRunner(undefined, waveRunnerMod.STUB_SEAMS);
    await runner(queueEntry(s2));

    const logged = await sql<{ command: string; outcome: string | null }[]>`
      SELECT command, outcome FROM routine_run_log WHERE session_id = ${s2}
    `;
    // The macro path did not write a 'skipped_phase25_stub' wave row. (It may write
    // its own macro run-log rows in other configs, but never the WAVE placeholder.)
    expect(logged.map((r) => r.outcome)).not.toContain('skipped_phase25_stub');
  });
});

// Always-on sanity test so the file always reports to `bun test`.
describe('OEE-09 e2e — harness sanity', () => {
  test('e2e is gated on REMO_E2E_DB_URL', () => {
    expect(typeof HAS_TEST_DB).toBe('boolean');
    if (!HAS_TEST_DB) {
      console.log(
        '[e2e] REMO_E2E_DB_URL not set — OEE-09 legacy-wave parity e2e is SKIPPED. ' +
          'Set REMO_E2E_DB_URL to a disposable Postgres URL to run it.',
      );
    }
  });
});
