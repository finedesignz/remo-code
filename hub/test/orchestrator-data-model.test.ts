/**
 * Phase 21 (auto-dev-orchestrator) — orchestrator data-model DDL tests.
 *
 * Two layers:
 *   1. Always-on (no DB): assert schema.sql declares the new objects (idempotent
 *      shapes: IF NOT EXISTS / DROP-or-guarded constraints). Keeps `bun test`
 *      green in CI where no Postgres is available.
 *   2. Env-gated e2e (REMO_E2E_DB_URL): boots schema.sql TWICE against a real
 *      Postgres (proves idempotency), then asserts the new tables/constraints
 *      exist and the one-orchestrator-per-session partial unique index rejects a
 *      second orchestrator row. Mirrors the gating in chat-tabs.test.ts.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test'

const SCHEMA = await Bun.file(new URL('../src/db/schema.sql', import.meta.url)).text()

// ── Always-on: schema.sql declares the Phase 21 objects (no DB) ───────────────

describe('orchestrator data model — schema.sql declarations', () => {
  test("task_type CHECK includes 'orchestrator'", () => {
    const m = SCHEMA.match(/scheduled_tasks_task_type_check[\s\S]*?\)\);/)
    expect(m).not.toBeNull()
    expect(m![0]).toContain("'orchestrator'")
  })

  test('one-orchestrator-per-session partial unique index is idempotent + partial', () => {
    expect(SCHEMA).toContain('CREATE UNIQUE INDEX IF NOT EXISTS idx_scheduled_tasks_orchestrator_unique')
    const m = SCHEMA.match(/CREATE UNIQUE INDEX IF NOT EXISTS idx_scheduled_tasks_orchestrator_unique[\s\S]*?;/)
    expect(m![0]).toContain('ON scheduled_tasks(session_id)')
    expect(m![0]).toContain("WHERE task_type = 'orchestrator'")
  })

  test('lifecycle_stage column + CHECK in {development,beta,production-maintenance}', () => {
    expect(SCHEMA).toContain("ADD COLUMN IF NOT EXISTS lifecycle_stage TEXT NOT NULL DEFAULT 'development'")
    const m = SCHEMA.match(/scheduled_tasks_lifecycle_stage_check[\s\S]*?;/)
    expect(m![0]).toContain("'development'")
    expect(m![0]).toContain("'beta'")
    expect(m![0]).toContain("'production-maintenance'")
  })

  test('orchestrator_rows / routine_run_log / routine_queue created idempotently', () => {
    expect(SCHEMA).toContain('CREATE TABLE IF NOT EXISTS orchestrator_rows')
    expect(SCHEMA).toContain('CREATE TABLE IF NOT EXISTS routine_run_log')
    expect(SCHEMA).toContain('CREATE TABLE IF NOT EXISTS routine_queue')
    expect(SCHEMA).toContain('idx_routine_run_log_session_created')
  })

  test('routine_queue per-session running lock is a partial unique index', () => {
    expect(SCHEMA).toContain('CREATE UNIQUE INDEX IF NOT EXISTS idx_routine_queue_session_running')
    const m = SCHEMA.match(/idx_routine_queue_session_running[\s\S]*?;/)
    expect(m![0]).toContain('ON routine_queue(session_id)')
    expect(m![0]).toContain("WHERE status = 'running'")
  })
})

// ── Env-gated e2e: real Postgres, schema boots twice, constraints enforced ────

const HAS_TEST_DB = !!process.env.REMO_E2E_DB_URL
const maybe = HAS_TEST_DB ? describe : describe.skip

describe('orchestrator data model — e2e harness sanity', () => {
  test('e2e is gated on REMO_E2E_DB_URL', () => {
    expect(typeof HAS_TEST_DB).toBe('boolean')
    if (!HAS_TEST_DB) {
      console.log(
        '[e2e] REMO_E2E_DB_URL not set — orchestrator-data-model e2e SKIPPED. ' +
          'Set REMO_E2E_DB_URL to a disposable Postgres URL to run them.',
      )
    }
  })
})

maybe('orchestrator data model — e2e', () => {
  let sql: any
  let userId: string
  let sessionId: string

  beforeAll(async () => {
    process.env.DATABASE_URL = process.env.REMO_E2E_DB_URL!
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'x'.repeat(32)
    const pg = await import('../src/db/postgres.ts')
    sql = pg.sql

    // Boot the schema TWICE — proves every Phase 21 statement is idempotent.
    await sql.unsafe(SCHEMA)
    await sql.unsafe(SCHEMA)

    const u = await sql`
      INSERT INTO users (email, password_hash)
      VALUES (${`ado-${Date.now()}@e2e.local`}, 'x')
      RETURNING id
    `
    userId = u[0].id
    const s = await sql`
      INSERT INTO sessions (user_id, name, project_dir, token_hash)
      VALUES (${userId}, 'ado-e2e', '/tmp/ado', ${`h-${Date.now()}`})
      RETURNING id
    `
    sessionId = s[0].id
  })

  afterAll(async () => {
    if (sql && userId) {
      await sql`DELETE FROM users WHERE id = ${userId}` // cascades sessions/tasks/rows/logs/queue
    }
  })

  test('new tables exist', async () => {
    const rows = await sql`
      SELECT table_name FROM information_schema.tables
      WHERE table_name IN ('orchestrator_rows','routine_run_log','routine_queue')
    `
    expect(rows.map((r: any) => r.table_name).sort()).toEqual([
      'orchestrator_rows',
      'routine_queue',
      'routine_run_log',
    ])
  })

  test('lifecycle_stage defaults to development and rejects bad values', async () => {
    const t = await sql`
      INSERT INTO scheduled_tasks (user_id, session_id, name, cron_expression, prompt, task_type)
      VALUES (${userId}, ${sessionId}, 'ls', '0 * * * *', 'p', 'orchestrator')
      RETURNING lifecycle_stage
    `
    expect(t[0].lifecycle_stage).toBe('development')

    let threw = false
    try {
      await sql`UPDATE scheduled_tasks SET lifecycle_stage = 'nope' WHERE session_id = ${sessionId}`
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
  })

  test('only one orchestrator task per session (partial unique index)', async () => {
    // First orchestrator task inserted above. A second must fail.
    let threw = false
    try {
      await sql`
        INSERT INTO scheduled_tasks (user_id, session_id, name, cron_expression, prompt, task_type)
        VALUES (${userId}, ${sessionId}, 'dup', '0 * * * *', 'p', 'orchestrator')
      `
    } catch {
      threw = true
    }
    expect(threw).toBe(true)

    // A non-orchestrator task on the SAME session is allowed (index is partial).
    const ok = await sql`
      INSERT INTO scheduled_tasks (user_id, session_id, name, cron_expression, prompt, task_type)
      VALUES (${userId}, ${sessionId}, 'dev', '0 * * * *', 'p', 'dev')
      RETURNING id
    `
    expect(ok[0].id).toBeTruthy()
  })

  test('routine_queue per-session running lock rejects 2nd running row', async () => {
    await sql`INSERT INTO routine_queue (session_id, status) VALUES (${sessionId}, 'running')`
    let threw = false
    try {
      await sql`INSERT INTO routine_queue (session_id, status) VALUES (${sessionId}, 'running')`
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
    // A pending row on the same session is fine (partial index only locks running).
    const p = await sql`
      INSERT INTO routine_queue (session_id, status) VALUES (${sessionId}, 'pending') RETURNING id
    `
    expect(p[0].id).toBeTruthy()
  })

  test('orchestrator_rows + routine_run_log DAL helpers round-trip', async () => {
    const dal = await import('../src/db/orchestrator-rows-dal.ts')
    const task = await sql`
      SELECT id FROM scheduled_tasks
      WHERE session_id = ${sessionId} AND task_type = 'orchestrator' LIMIT 1
    `
    const row = await dal.insertOrchestratorRow({
      task_id: task[0].id,
      command: 'continue-dev',
      schedule_rule: { interval: 4, unit: 'hours', start_at: new Date().toISOString() },
      frequency_label: 'every 4h',
    })
    expect(row.id).toBeTruthy()
    expect(row.schedule_rule?.interval).toBe(4)
    const list = await dal.listOrchestratorRows(task[0].id)
    expect(list.length).toBe(1)

    const log = await dal.insertRoutineRunLog({
      session_id: sessionId,
      command: 'continue-dev',
      outcome: 'pr_opened',
      pr_url: 'https://example/pr/1',
    })
    expect(log.id).toBeTruthy()
    const recent = await dal.recentRoutineRunLog(sessionId, 5)
    expect(recent.length).toBeGreaterThanOrEqual(1)
  })
})
