/**
 * CONCERNS item 7 — fence schema.sql.
 *
 * hub/src/db/schema.sql re-runs IN FULL on every hub boot (hub/src/db/migrate.ts).
 * A mutating statement in that file re-fires against PRODUCTION on every deploy
 * (incident #176). `tools/schema-sql-lint.ts` is the CI fence; these tests prove
 * the fence actually catches a planted mutation and that the REAL schema.sql is
 * clean (every mutating statement carries a reviewed `-- schema-lint: allow`).
 */
import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { lintSchemaSql, splitStatementsForTest } from '../../tools/schema-sql-lint.ts'
import { splitSqlStatements } from '../src/db/migrate.ts'

const SCHEMA_PATH = resolve(import.meta.dir, '../src/db/schema.sql')
const schemaText = readFileSync(SCHEMA_PATH, 'utf-8')

const violations = (sql: string) => lintSchemaSql(sql).filter((f) => f.allowedReason === null)

describe('schema.sql lint', () => {
  test('catches a planted UPDATE', () => {
    const found = violations(`CREATE TABLE IF NOT EXISTS t (id INT);\nUPDATE t SET id = 1;\n`)
    expect(found.length).toBe(1)
    expect(found[0].keyword).toBe('UPDATE')
    expect(found[0].line).toBe(2)
  })

  test('catches every banned keyword at statement start', () => {
    for (const kw of ['UPDATE t SET id=1', "INSERT INTO t VALUES (1)", 'DELETE FROM t', 'TRUNCATE t', 'DROP TABLE t']) {
      const found = violations(`${kw};\n`)
      expect(found.length).toBe(1)
    }
  })

  test('does not false-positive on comments, prose, or DDL that merely contains the words', () => {
    const sql = [
      '-- rows are INSERTED by the app; never UPDATE or DELETE here.',
      '/* DROP TABLE t; TRUNCATE t; — historical note, not a statement */',
      'CREATE TABLE IF NOT EXISTS t (id INT, deleted_at TIMESTAMPTZ);',
      'ALTER TABLE t DROP CONSTRAINT IF EXISTS t_chk;',
      'ALTER TABLE t ADD COLUMN IF NOT EXISTS u UUID REFERENCES users(id) ON DELETE CASCADE;',
      "INSERT INTO t VALUES (1) ON CONFLICT DO NOTHING; -- this one IS a mutation",
    ].join('\n')
    const found = violations(sql)
    expect(found.map((f) => f.keyword)).toEqual(['INSERT'])
  })

  test('a `-- schema-lint: allow` pragma exempts only the next statement', () => {
    const sql = ['-- schema-lint: allow convergent', 'UPDATE t SET id = 1;', 'UPDATE t SET id = 2;'].join('\n')
    const all = lintSchemaSql(sql)
    expect(all.length).toBe(2)
    expect(all[0].allowedReason).toBe('convergent')
    expect(all[1].allowedReason).toBeNull()
  })

  test('the REAL schema.sql has no un-pragma\'d mutating statement', () => {
    const found = violations(schemaText)
    expect(found).toEqual([])
  })
})

// ── dollar-quoting: semicolons inside $$ … $$ are NOT statement terminators ────

const DO_BLOCK = `DO $$
BEGIN
  PERFORM 1;
  PERFORM 2;
END
$$;`

const FUNC = `CREATE OR REPLACE FUNCTION touch() RETURNS trigger AS $func$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$func$ LANGUAGE plpgsql;`

describe('schema.sql lint — dollar-quoted bodies', () => {
  test('a DO $$ … $$ block with internal semicolons is ONE statement', () => {
    const stmts = splitStatementsForTest(DO_BLOCK)
    expect(stmts.length).toBe(1)
    expect(stmts[0].code).toContain('PERFORM 2')
  })

  test('a custom $func$ tag with internal semicolons is ONE statement', () => {
    const stmts = splitStatementsForTest(FUNC)
    expect(stmts.length).toBe(1)
    expect(stmts[0].code).toContain('RETURN NEW')
  })

  test('neither trips the lint (no mutating keyword in the body)', () => {
    expect(violations(DO_BLOCK)).toEqual([])
    expect(violations(FUNC)).toEqual([])
  })

  test('boundaries agree with migrate.ts splitSqlStatements (one splitter, one behavior)', () => {
    for (const src of [DO_BLOCK, FUNC, schemaText]) {
      expect(splitStatementsForTest(src).length).toBe(splitSqlStatements(src).length)
    }
  })
})

// ── evasions: a mutation is caught ANYWHERE in the statement body ──────────────

describe('schema.sql lint — evasions', () => {
  test('a mutation hidden in a DO $$ … $$ block is caught', () => {
    const sql = `DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM api_keys) THEN
    UPDATE api_keys SET capabilities = ARRAY['agent'];
  END IF;
END
$$;`
    const found = violations(sql)
    expect(found.length).toBe(1)
    expect(found[0].keyword).toBe('UPDATE')
  })

  test('a data-modifying CTE (WITH x AS (DELETE …)) is caught', () => {
    const found = violations(`WITH gone AS (DELETE FROM sessions WHERE deleted_at IS NOT NULL RETURNING id)\nSELECT count(*) FROM gone;`)
    expect(found.length).toBe(1)
    expect(found[0].keyword).toBe('DELETE')
  })

  test('legal DDL uses of the banned words are still not false positives', () => {
    const sql = [
      'CREATE TABLE IF NOT EXISTS t (id INT, u UUID REFERENCES users(id) ON DELETE CASCADE, deleted_at TIMESTAMPTZ);',
      'ALTER TABLE t DROP CONSTRAINT IF EXISTS t_chk;',
      'ALTER TABLE t ALTER COLUMN u DROP NOT NULL;',
      'CREATE INDEX IF NOT EXISTS i ON t(id) WHERE deleted_at IS NULL;',
    ].join('\n')
    expect(violations(sql)).toEqual([])
  })
})
