/**
 * PTYCAP-08 schema pin (DB-free, static over schema.sql source).
 * Additive + idempotent only: schema.sql re-runs in full on every hub boot.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { lintSchemaSql } from '../../tools/schema-sql-lint.ts'

const SCHEMA = readFileSync(join(import.meta.dir, '..', 'src', 'db', 'schema.sql'), 'utf8')
const LINES = SCHEMA.split(/\r?\n/)
const FLAT = LINES.map((l) => l.replace(/--.*$/, '')).join('\n')

function tableBlock(name: string): string {
  const start = LINES.findIndex((l) => l.startsWith(`CREATE TABLE IF NOT EXISTS ${name} (`))
  expect(start).toBeGreaterThanOrEqual(0)
  let end = start
  while (end < LINES.length && !LINES[end]!.startsWith(');')) end++
  return LINES.slice(start, end + 1)
    .map((l) => l.replace(/--.*$/, ''))
    .join('\n')
}

function statement(needle: string): string {
  const idx = FLAT.indexOf(needle)
  expect(idx).toBeGreaterThanOrEqual(0)
  return FLAT.slice(idx, FLAT.indexOf(';', idx) + 1).replace(/\s+/g, ' ')
}

describe('PTYCAP-08 task_qc schema', () => {
  test("'task_qc' is in the ONE task_type CHECK and no second constraint exists", () => {
    const adds = FLAT.match(/ADD CONSTRAINT scheduled_tasks_task_type_check/g) ?? []
    expect(adds.length).toBe(1)
    const check = statement('ADD CONSTRAINT scheduled_tasks_task_type_check')
    expect((check.match(/'task_qc'/g) ?? []).length).toBe(1)
  })

  test('per-user partial unique index for task_qc', () => {
    const idx = statement('CREATE UNIQUE INDEX IF NOT EXISTS idx_scheduled_tasks_task_qc_unique')
    expect(idx).toContain('ON scheduled_tasks(user_id)')
    expect(idx).toContain("WHERE task_type = 'task_qc'")
  })

  test('task_qc_findings table shape', () => {
    const t = tableBlock('task_qc_findings')
    expect(t).toMatch(/user_id\s+UUID NOT NULL REFERENCES users\(id\) ON DELETE CASCADE/)
    expect(t).toMatch(/task_id\s+TEXT NOT NULL/)
    expect(t).not.toMatch(/task_id[^,]*REFERENCES/i)
    expect(t).toContain(
      "CHECK (detector IN ('FAILING','SKIP_FOREVER','NEVER_FIRED','MISCONFIGURED','DEAD_SESSION','OPTIMIZE','ENGINE'))",
    )
    expect(t).toContain("CHECK (severity IN ('info','warn','high'))")
    expect(t).toMatch(/severity\s+TEXT NOT NULL DEFAULT 'info'/)
    expect(t).toContain("CHECK (disposition IN ('auto_fixed','proposed','skipped_in_flight'))")
    for (const col of ['fix_kind', 'before_json', 'after_json', 'rollback_sql', 'evidence', 'evidence_sig', 'day', 'created_at']) {
      expect(t).toContain(col)
    }
    expect(t).toMatch(/evidence_sig\s+TEXT NOT NULL/)
    expect(t).toMatch(/day\s+DATE NOT NULL/)
    expect(t).toMatch(/evidence\s+JSONB/)
  })

  test('findings indexes: two lookup indexes plus the idempotency unique key', () => {
    const idxs = FLAT.match(/CREATE (UNIQUE )?INDEX IF NOT EXISTS \w+\s+ON task_qc_findings/g) ?? []
    expect(idxs.length).toBe(3)
    const uniq = statement('CREATE UNIQUE INDEX IF NOT EXISTS idx_task_qc_findings_dedupe')
    expect(uniq).toContain('(user_id, task_id, detector, evidence_sig, day)')
  })

  test('nullability pins that justify the NULL-session seed row (F2-B2)', () => {
    expect(FLAT).toMatch(/ALTER TABLE scheduled_tasks ALTER COLUMN session_id DROP NOT NULL/)
    const runs = tableBlock('scheduled_task_runs')
    const line = runs.split('\n').find((l) => /^\s*session_id\b/.test(l))
    expect(line).toBeDefined()
    expect(line!).not.toMatch(/NOT NULL/)
    expect(line!).toMatch(/ON DELETE SET NULL/)
  })

  test('round 2 (codex new MAJOR 1): no trigger on scheduled_task_runs survives; existing DBs lose the round-1 trigger on boot', () => {
    // flag-OFF true no-op: nothing in the schema may add work to a run insert
    expect(FLAT).not.toMatch(/CREATE (OR REPLACE )?TRIGGER[^;]*scheduled_task_runs/i)
    expect(FLAT).not.toMatch(/CREATE (OR REPLACE )?FUNCTION scheduled_task_runs_session_lock/i)
    expect(FLAT).not.toContain('taskqc-session')
    // the retired trigger and function are dropped idempotently, trigger first, only if present
    const drop = FLAT.slice(FLAT.indexOf('trg_scheduled_task_runs_session_lock'))
    expect(drop).toContain('DROP TRIGGER trg_scheduled_task_runs_session_lock ON scheduled_task_runs')
    expect(drop).toContain('DROP FUNCTION IF EXISTS scheduled_task_runs_session_lock()')
    expect(drop.indexOf('DROP TRIGGER')).toBeLessThan(drop.indexOf('DROP FUNCTION'))
    expect(FLAT).toMatch(/IF EXISTS \(SELECT 1 FROM pg_trigger WHERE tgname = 'trg_scheduled_task_runs_session_lock'/)
    // the writer no longer spells the retired advisory key
    const writer = readFileSync(join(import.meta.dir, '..', 'src', 'task-qc', 'safe-fixes.ts'), 'utf8')
    expect(writer).not.toContain('taskqc-session')
    expect(writer).not.toContain('pg_advisory')
  })

  test('digest_sent_at is an additive nullable column (report-until-delivered)', () => {
    expect(FLAT).toMatch(/ALTER TABLE task_qc_findings ADD COLUMN IF NOT EXISTS digest_sent_at TIMESTAMPTZ;/)
    expect(tableBlock('task_qc_findings')).not.toContain('digest_sent_at')
  })

  test('schema-lint is clean (no un-pragmad mutating statement)', () => {
    const bad = lintSchemaSql(SCHEMA).filter((f) => f.allowedReason === null)
    expect(bad).toEqual([])
  })
})
