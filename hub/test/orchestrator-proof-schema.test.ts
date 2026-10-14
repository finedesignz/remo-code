/**
 * PTYCAP-05: static pin of the orchestrator_proof_runs DDL in schema.sql (additive,
 * idempotent, DB-enforced single-flight + budget CHECKs). Pure source scan, no DB.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const schema = readFileSync(join(import.meta.dir, '../src/db/schema.sql'), 'utf8').replace(/\r\n/g, '\n')
const start = schema.indexOf('-- ── PTYCAP-05 (throwaway-repo due->PR proof)')
const block = start >= 0 ? schema.slice(start) : ''

describe('orchestrator_proof_runs DDL', () => {
  test('the PTYCAP-05 block exists and creates the table idempotently', () => {
    expect(start).toBeGreaterThan(0)
    expect(block).toContain('CREATE TABLE IF NOT EXISTS orchestrator_proof_runs (')
  })

  test('six named constraints, each in a guarded duplicate_object DO block', () => {
    const names = [
      'orchestrator_proof_runs_status_check',
      'orchestrator_proof_runs_max_injects_check',
      'orchestrator_proof_runs_max_tokens_check',
      'orchestrator_proof_runs_max_wall_ms_check',
      'orchestrator_proof_runs_tokens_hwm_check',
      'orchestrator_proof_runs_terminal_at_check',
    ]
    for (const n of names) {
      const i = block.indexOf(`ADD CONSTRAINT ${n}`)
      expect(i).toBeGreaterThan(0)
      const stmt = block.slice(block.lastIndexOf('DO $$', i), block.indexOf('END $$;', i))
      expect(stmt).toContain('EXCEPTION WHEN duplicate_object THEN NULL')
    }
    expect(block).toContain("CHECK (status IN ('armed','running','succeeded','nothing','terminated','disarmed'))")
    // codex #6: the repo identity is stored canonical (lowercase), so the plain unique index over
    // repo_ident IS the single-flight over the canonical value.
    expect(block).toContain('CHECK (repo_ident = lower(repo_ident))')
    expect(block).toContain('CHECK (max_injects > 0)')
    // adversary MINOR 6: DB-level ceilings mirror proof-arm.ts so a hand-written row cannot be unbounded
    expect(block).toContain('CHECK (max_injects <= 50) NOT VALID')
    expect(block).toContain('CHECK (max_tokens <= 50000000) NOT VALID')
    expect(block).toContain('CHECK (max_wall_ms <= 86400000) NOT VALID')
    expect(block).toContain('CHECK (max_tokens > 0)')
    expect(block).toContain('CHECK (max_wall_ms > 0)')
    expect(block).toContain('CHECK (tokens_hwm >= 0)')
    expect(block).toContain("CHECK ((status IN ('armed','running')) = (terminal_at IS NULL))")
  })

  test('three partial unique indexes WHERE status IN (armed,running): user, repo, task', () => {
    for (const col of ['user_id', 'repo_ident', 'task_id']) {
      expect(block).toMatch(
        new RegExp(`CREATE UNIQUE INDEX IF NOT EXISTS idx_orchestrator_proof_runs_active_\\w+\\s+ON orchestrator_proof_runs\\(${col}\\) WHERE status IN \\('armed','running'\\);`),
      )
    }
    expect((block.match(/CREATE UNIQUE INDEX IF NOT EXISTS/g) ?? []).length).toBe(3)
  })

  test('session_id and task_id carry no foreign key (history survives deletion)', () => {
    const table = block.slice(block.indexOf('CREATE TABLE IF NOT EXISTS orchestrator_proof_runs ('), block.indexOf(');'))
    expect(table).toMatch(/task_id\s+TEXT NOT NULL,/)
    expect(table).toMatch(/session_id\s+TEXT NOT NULL,/)
    expect(table.match(/REFERENCES/g)?.length).toBe(1) // only users(id)
  })

  test('QC r1: the proof_owned marker column is additive + idempotent and sits just before the block', () => {
    const ddl = 'ALTER TABLE scheduled_tasks ADD COLUMN IF NOT EXISTS proof_owned BOOLEAN NOT NULL DEFAULT false;'
    expect(schema).toContain(ddl)
    expect(schema.indexOf(ddl)).toBeLessThan(start)
    expect(schema.indexOf(ddl)).toBeGreaterThan(start - 600)
  })

  test('no mutating statement in the block (additive DDL only)', () => {
    const code = block
      .split('\n')
      .filter((l) => !l.trim().startsWith('--'))
      .join('\n')
    expect(code).not.toMatch(/^\s*(UPDATE|INSERT|DELETE|DROP|TRUNCATE)\b/im)
    expect(code).not.toMatch(/\bALTER TABLE (?!orchestrator_proof_runs ADD CONSTRAINT)/)
  })
})
