/**
 * Phase 32 (auto-dev-orchestrator) — legacy-task migration planner.
 *
 * The DB-touching `main()` is not unit-tested (it needs Postgres); the PURE
 * command-mapping planner is, which is the migration's actual logic. Idempotency
 * + dry-run are properties of the planner + the insert-only-when-absent loop:
 * the planner is deterministic (same legacy set → same command set), and a
 * re-run with the commands already seeded produces an empty delta.
 */
import { describe, test, expect } from 'bun:test'
import {
  commandsForLegacyTasks,
  LEGACY_TYPE_TO_COMMANDS,
  MIGRATABLE_LEGACY_TYPES,
} from '../scripts/migrate-legacy-tasks-to-orchestrator.ts'

describe('commandsForLegacyTasks', () => {
  test('dev → plan + execute', () => {
    expect(commandsForLegacyTasks([{ task_type: 'dev' }])).toEqual([
      'gsd-plan-phase',
      'gsd-execute-phase',
    ])
  })

  test('qc → audit-fix + code-review + verify-work', () => {
    expect(commandsForLegacyTasks([{ task_type: 'qc' }])).toEqual([
      'gsd-audit-fix',
      'gsd-code-review',
      'gsd-verify-work',
    ])
  })

  test('dedupes across multiple tasks (idempotent command set)', () => {
    const cmds = commandsForLegacyTasks([
      { task_type: 'dev' },
      { task_type: 'dev' },
      { task_type: 'continue_dev' },
    ])
    expect(cmds).toEqual(['gsd-plan-phase', 'gsd-execute-phase'])
  })

  test('union across dev + qc, stable order, no dupes', () => {
    const cmds = commandsForLegacyTasks([{ task_type: 'dev' }, { task_type: 'qc' }])
    expect(cmds).toEqual([
      'gsd-plan-phase',
      'gsd-execute-phase',
      'gsd-audit-fix',
      'gsd-code-review',
      'gsd-verify-work',
    ])
    expect(new Set(cmds).size).toBe(cmds.length)
  })

  test('unknown / unmappable legacy type → no commands', () => {
    expect(commandsForLegacyTasks([{ task_type: 'triage' }])).toEqual([])
    expect(commandsForLegacyTasks([{ task_type: 'orchestrator' }])).toEqual([])
  })

  test('deterministic: same input → same output (re-run safe)', () => {
    const input = [{ task_type: 'dev' }, { task_type: 'security' }]
    expect(commandsForLegacyTasks(input)).toEqual(commandsForLegacyTasks(input))
  })

  test('orchestrator is NOT a migratable legacy type (never folds into itself)', () => {
    expect(MIGRATABLE_LEGACY_TYPES).not.toContain('orchestrator')
    expect(LEGACY_TYPE_TO_COMMANDS['orchestrator']).toBeUndefined()
  })
})

// ── Env-gated e2e: real Postgres — migration applies + is idempotent on re-run ─
// Drives the DB-touching main() against a disposable Postgres: seeds legacy dev+qc
// tasks for a session, runs main() (apply), asserts ONE orchestrator task + the
// union of command rows seeded (parked: enabled=false / 'Never') and the legacy
// tasks disabled; then runs main() AGAIN and asserts a ZERO delta (idempotent).
// Mirrors the gating in orchestrator-data-model.test.ts.
import { beforeAll, afterAll } from 'bun:test'

const HAS_TEST_DB = !!process.env.REMO_E2E_DB_URL
const maybe = HAS_TEST_DB ? describe : describe.skip

if (!HAS_TEST_DB) {
  console.log(
    '[e2e] REMO_E2E_DB_URL not set — migrate-legacy-tasks e2e SKIPPED. ' +
      'Set REMO_E2E_DB_URL to a disposable Postgres URL to run them.',
  )
}

maybe('migrate-legacy-tasks — e2e (REMO_E2E_DB_URL)', () => {
  let sql: any
  let runMigration: () => Promise<number>
  let userId: string
  let sessionId: string

  beforeAll(async () => {
    process.env.DATABASE_URL = process.env.REMO_E2E_DB_URL!
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'x'.repeat(32)
    const pg = await import('../src/db/postgres.ts')
    sql = pg.sql
    const SCHEMA = await Bun.file(new URL('../src/db/schema.sql', import.meta.url)).text()
    await sql.unsafe(SCHEMA)
    runMigration = (await import('../scripts/migrate-legacy-tasks-to-orchestrator.ts')).main

    const u = await sql`
      INSERT INTO users (email, password_hash)
      VALUES (${`adomig-${Date.now()}@e2e.local`}, 'x') RETURNING id
    `
    userId = u[0].id
    const s = await sql`
      INSERT INTO sessions (user_id, name, project_dir, token_hash)
      VALUES (${userId}, 'mig', '/tmp/mig', ${`h-mig-${Date.now()}`}) RETURNING id
    `
    sessionId = s[0].id
    // Seed legacy enabled dev + qc root tasks bound to the session.
    for (const tt of ['dev', 'qc']) {
      await sql`
        INSERT INTO scheduled_tasks (user_id, session_id, name, cron_expression, prompt, task_type, enabled)
        VALUES (${userId}, ${sessionId}, ${`legacy-${tt}`}, '0 * * * *', 'p', ${tt}, true)
      `
    }
  })

  afterAll(async () => {
    if (sql && userId) await sql`DELETE FROM users WHERE id = ${userId}`
  })

  async function snapshot() {
    const task = await sql`
      SELECT id, enabled FROM scheduled_tasks
      WHERE session_id = ${sessionId} AND task_type = 'orchestrator' LIMIT 1
    `
    const rows = task[0]
      ? await sql`SELECT command, enabled, frequency_label FROM orchestrator_rows WHERE task_id = ${task[0].id} ORDER BY sort_order`
      : []
    const legacyEnabled = await sql`
      SELECT count(*)::int AS n FROM scheduled_tasks
      WHERE session_id = ${sessionId} AND task_type IN ('dev','qc') AND enabled = true
    `
    return { taskId: task[0]?.id ?? null, rows, legacyEnabledCount: legacyEnabled[0].n }
  }

  test('apply: creates one orchestrator task + parked command rows, disables legacy', async () => {
    const code = await runMigration()
    expect(code).toBe(0)
    const snap = await snapshot()
    expect(snap.taskId).toBeTruthy()
    // dev → plan+execute, qc → audit-fix+code-review+verify-work (union, deduped).
    expect(snap.rows.map((r: any) => r.command)).toEqual([
      'gsd-plan-phase',
      'gsd-execute-phase',
      'gsd-audit-fix',
      'gsd-code-review',
      'gsd-verify-work',
    ])
    // Seeded PARKED so migration never silently starts firing.
    for (const r of snap.rows) {
      expect(r.enabled).toBe(false)
      expect(r.frequency_label).toBe('Never')
    }
    // Legacy dev/qc tasks disabled so the legacy engine stops firing them.
    expect(snap.legacyEnabledCount).toBe(0)
  })

  test('idempotent: a 2nd run produces a ZERO delta', async () => {
    const before = await snapshot()
    const code = await runMigration()
    expect(code).toBe(0)
    const after = await snapshot()
    expect(after.taskId).toBe(before.taskId) // no new orchestrator task
    expect(after.rows.length).toBe(before.rows.length) // no new rows
    expect(after.rows.map((r: any) => r.command)).toEqual(
      before.rows.map((r: any) => r.command),
    )
  })
})
