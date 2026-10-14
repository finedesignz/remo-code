/**
 * PTYCAP-04 schema pin (DB-free, static over schema.sql source).
 * The DB-backed proof lives in test/e2e/automation-controls-checks.ts.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SCHEMA = readFileSync(join(import.meta.dir, '..', 'src', 'db', 'schema.sql'), 'utf8')
const LINES = SCHEMA.split(/\r?\n/)

/** Statement text (comments stripped) of one CREATE TABLE IF NOT EXISTS block. */
function tableBlock(name: string): string {
  const start = LINES.findIndex((l) => l.startsWith(`CREATE TABLE IF NOT EXISTS ${name} (`))
  expect(start).toBeGreaterThanOrEqual(0)
  let end = start
  while (end < LINES.length && !LINES[end]!.startsWith(');')) end++
  return LINES.slice(start, end + 1)
    .map((l) => l.replace(/--.*$/, ''))
    .join('\n')
}

function statementContaining(needle: string): string {
  const flat = LINES.map((l) => l.replace(/--.*$/, '')).join('\n')
  const idx = flat.indexOf(needle)
  expect(idx).toBeGreaterThanOrEqual(0)
  const semi = flat.indexOf(';', idx)
  return flat.slice(idx, semi + 1).replace(/\s+/g, ' ')
}

describe('PTYCAP-04 schema', () => {
  test('the three tables and the run-log column statement exist', () => {
    expect(SCHEMA).toContain('CREATE TABLE IF NOT EXISTS automation_inject_ledger')
    expect(SCHEMA).toContain('CREATE TABLE IF NOT EXISTS automation_kill_switch')
    expect(SCHEMA).toContain('CREATE TABLE IF NOT EXISTS token_cap_alarms')
    expect(SCHEMA).toContain('ALTER TABLE routine_run_log ADD COLUMN IF NOT EXISTS inject_token TEXT')
  })

  test('the new tables carry no foreign keys', () => {
    for (const t of ['automation_inject_ledger', 'automation_kill_switch', 'token_cap_alarms']) {
      expect(tableBlock(t)).not.toMatch(/REFERENCES/i)
    }
  })

  test('ledger kind CHECK literal is exactly inject, reset, page', () => {
    expect(tableBlock('automation_inject_ledger')).toContain("CHECK (kind IN ('inject','reset','page'))")
  })

  test('kill switch scope CHECK literal is exactly global, user, session', () => {
    expect(tableBlock('automation_kill_switch')).toContain("CHECK (scope IN ('global','user','session'))")
  })

  test('three PARTIAL unique indexes carry their predicates', () => {
    expect(statementContaining('CREATE UNIQUE INDEX IF NOT EXISTS idx_automation_kill_switch_global')).toContain(
      "WHERE scope = 'global' AND engaged",
    )
    expect(statementContaining('CREATE UNIQUE INDEX IF NOT EXISTS idx_automation_kill_switch_user')).toContain(
      "(user_id) WHERE scope = 'user' AND engaged",
    )
    expect(statementContaining('CREATE UNIQUE INDEX IF NOT EXISTS idx_automation_kill_switch_session')).toContain(
      "(session_id, engaged_by) WHERE scope = 'session' AND engaged",
    )
  })

  test('ledger unique index is (counter_key, token); alarm unique is (user_id, local_date)', () => {
    expect(statementContaining('CREATE UNIQUE INDEX IF NOT EXISTS idx_automation_inject_ledger_key_token')).toContain(
      'automation_inject_ledger(counter_key, token)',
    )
    expect(statementContaining('CREATE UNIQUE INDEX IF NOT EXISTS idx_token_cap_alarms_user_date')).toContain(
      'token_cap_alarms(user_id, local_date)',
    )
  })

  test('ledger has a monotonic seq and the supporting indexes', () => {
    expect(tableBlock('automation_inject_ledger')).toContain('seq         BIGSERIAL')
    expect(SCHEMA).toContain('automation_inject_ledger(counter_key, seq DESC)')
    expect(SCHEMA).toContain('automation_inject_ledger(session_id, created_at)')
  })
})
