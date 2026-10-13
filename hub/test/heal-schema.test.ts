/**
 * PTYCAP-07 plan 02 task 1 - heal_events DDL is additive, idempotent, lint-clean.
 * schema.sql re-runs in full every hub boot: no mutating statements allowed (D-14).
 */
import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { lintSchemaSql } from '../../tools/schema-sql-lint.ts'

const SCHEMA_PATH = resolve(import.meta.dir, '../src/db/schema.sql')
const schema = readFileSync(SCHEMA_PATH, 'utf-8')

const tableBlock = (() => {
  const m = schema.match(/CREATE TABLE IF NOT EXISTS heal_events \(([\s\S]*?)\n\);/)
  return m ? m[1] : ''
})()

describe('heal_events DDL', () => {
  test('table block exists with every column', () => {
    expect(tableBlock.length).toBeGreaterThan(0)
    for (const col of [
      'id', 'user_id', 'source', 'repo_ident', 'dedupe_key', 'window_bucket',
      'trigger_run_id', 'dispatch_run_id', 'metadata_run_id', 'session_id',
      'outcome', 'notification_claimed_at', 'created_at', 'updated_at',
    ]) {
      expect(new RegExp(`^\\s*${col}\\s`, 'm').test(tableBlock)).toBe(true)
    }
  })

  test('no foreign key on the run id columns', () => {
    for (const col of ['trigger_run_id', 'dispatch_run_id', 'metadata_run_id']) {
      const line = tableBlock.split('\n').find((l) => new RegExp(`^\\s*${col}\\s`).test(l)) ?? ''
      expect(/REFERENCES/i.test(line)).toBe(false)
    }
  })

  test('unique bucket index, partial unique trigger index, supporting indexes', () => {
    expect(/CREATE UNIQUE INDEX IF NOT EXISTS idx_heal_events_bucket\s+ON heal_events\(user_id, source, dedupe_key, window_bucket\)/.test(schema)).toBe(true)
    expect(/CREATE UNIQUE INDEX IF NOT EXISTS idx_heal_events_trigger\s+ON heal_events\(source, trigger_run_id\)\s+WHERE trigger_run_id IS NOT NULL/.test(schema)).toBe(true)
    expect(/ON heal_events\(user_id, dedupe_key, created_at DESC\)/.test(schema)).toBe(true)
    expect(/ON heal_events\(dispatch_run_id\)/.test(schema)).toBe(true)
    expect(/ON heal_events\(metadata_run_id\)/.test(schema)).toBe(true)
    expect(/ON heal_events\(user_id, repo_ident, created_at DESC\)/.test(schema)).toBe(true)
  })

  test('scheduled_tasks.is_internal additive column', () => {
    expect(/ALTER TABLE scheduled_tasks ADD COLUMN IF NOT EXISTS is_internal BOOLEAN NOT NULL DEFAULT false/.test(schema)).toBe(true)
  })

  test('schema-sql-lint reports zero un-pragmad findings', () => {
    const bad = lintSchemaSql(schema).filter((f) => f.allowedReason === null)
    expect(bad).toEqual([])
  })

  test('diff adds no UPDATE/INSERT/DELETE/DROP/TRUNCATE line and removes nothing', () => {
    const base = process.env.HEAL_PLAN_BASE ?? '60c06112e1ee13870c1ec16f237fb5758a797439'
    let diff = ''
    try {
      diff = execFileSync('git', ['diff', base, '--', 'hub/src/db/schema.sql'], {
        cwd: resolve(import.meta.dir, '../..'),
        encoding: 'utf-8',
      })
    } catch {
      return // base unavailable (shallow clone): lint test above still guards
    }
    const added = diff.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++'))
    const removed = diff.split('\n').filter((l) => l.startsWith('-') && !l.startsWith('---'))
    expect(removed).toEqual([])
    const mutating = added.filter((l) => !/^\+\s*--/.test(l) && /^\+\s*(UPDATE|INSERT|DELETE|DROP|TRUNCATE)\b/i.test(l))
    expect(mutating).toEqual([])
  })
})
