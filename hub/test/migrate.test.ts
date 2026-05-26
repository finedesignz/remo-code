/**
 * Unit tests for splitSqlStatements — the dollar-quote-aware SQL splitter
 * in hub/src/db/migrate.ts.
 *
 * Pure parser tests, no DB.
 */
import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { splitSqlStatements } from '../src/db/migrate.ts'

describe('splitSqlStatements', () => {
  test('splits two simple statements', () => {
    const out = splitSqlStatements('SELECT 1; SELECT 2;')
    expect(out).toEqual(['SELECT 1', 'SELECT 2'])
  })

  test('ignores trailing whitespace and empty trailing statement', () => {
    const out = splitSqlStatements('SELECT 1;   \n  ')
    expect(out).toEqual(['SELECT 1'])
  })

  test('DO block with EXCEPTION + inner semicolons → 1 statement', () => {
    const sql = `DO $$ BEGIN
      ALTER TABLE users ADD CONSTRAINT u_chk CHECK (x > 0);
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;`
    const out = splitSqlStatements(sql)
    expect(out.length).toBe(1)
    expect(out[0]).toContain('EXCEPTION WHEN duplicate_object')
    expect(out[0]).toContain('ALTER TABLE users')
  })

  test('CREATE TABLE → DO block → CREATE TABLE = 3 statements', () => {
    const sql = `CREATE TABLE a (id int);
DO $$ BEGIN
  ALTER TABLE a ADD CONSTRAINT a_chk CHECK (id > 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE TABLE b (id int);`
    const out = splitSqlStatements(sql)
    expect(out.length).toBe(3)
    expect(out[0]).toContain('CREATE TABLE a')
    expect(out[1]).toContain('DO $$')
    expect(out[1]).toContain('END $$')
    expect(out[2]).toContain('CREATE TABLE b')
  })

  test('tagged dollar quote $tag$ ... $tag$ respected', () => {
    const sql = `CREATE FUNCTION f() RETURNS void AS $body$
      BEGIN
        INSERT INTO t VALUES ('a;b;c');
        PERFORM 1;
      END;
    $body$ LANGUAGE plpgsql;
SELECT 1;`
    const out = splitSqlStatements(sql)
    expect(out.length).toBe(2)
    expect(out[0]).toContain('$body$')
    expect(out[0]).toContain("INSERT INTO t VALUES ('a;b;c')")
    expect(out[1]).toBe('SELECT 1')
  })

  test("single-quoted string with embedded semicolon is one statement", () => {
    const sql = `INSERT INTO t (v) VALUES ('foo;bar');\nSELECT 2;`
    const out = splitSqlStatements(sql)
    expect(out.length).toBe(2)
    expect(out[0]).toBe("INSERT INTO t (v) VALUES ('foo;bar')")
    expect(out[1]).toBe('SELECT 2')
  })

  test("escaped single quote '' inside string preserved", () => {
    const sql = `INSERT INTO t (v) VALUES ('it''s; fine');\nSELECT 2;`
    const out = splitSqlStatements(sql)
    expect(out.length).toBe(2)
    expect(out[0]).toContain("'it''s; fine'")
  })

  test('double-quoted identifier with semicolon (pathological) preserved', () => {
    const sql = `SELECT "weird;col" FROM t; SELECT 2;`
    const out = splitSqlStatements(sql)
    expect(out.length).toBe(2)
    expect(out[0]).toContain('"weird;col"')
  })

  test('block comment containing ; is ignored as a terminator', () => {
    const sql = `/* this; has; semicolons */ SELECT 1; SELECT 2;`
    const out = splitSqlStatements(sql)
    expect(out.length).toBe(2)
    expect(out[0]).toContain('SELECT 1')
    expect(out[1]).toBe('SELECT 2')
  })

  test('line comment with ; ignored as a terminator', () => {
    const sql = `SELECT 1 -- ignore; this; please\n; SELECT 2;`
    const out = splitSqlStatements(sql)
    expect(out.length).toBe(2)
    expect(out[1]).toBe('SELECT 2')
  })

  test('bare $1 positional param not treated as dollar quote', () => {
    const sql = `SELECT * FROM t WHERE id = $1; SELECT 2;`
    const out = splitSqlStatements(sql)
    expect(out.length).toBe(2)
    expect(out[0]).toContain('$1')
  })

  test('nested block comments', () => {
    const sql = `/* outer /* inner; */ still in outer; */ SELECT 1;`
    const out = splitSqlStatements(sql)
    expect(out.length).toBe(1)
    expect(out[0]).toContain('SELECT 1')
  })

  test('real schema.sql DO blocks each parse to a single statement', () => {
    // Validates the actual fix against the production schema file.
    const schemaPath = resolve(import.meta.dir, '../src/db/schema.sql')
    const ddl = readFileSync(schemaPath, 'utf-8')
    const stmts = splitSqlStatements(ddl)

    // Sanity: nothing was split mid-dollar-quote — i.e. no statement
    // contains an unmatched/odd count of $$ tokens.
    for (const s of stmts) {
      const dollarCount = (s.match(/\$\$/g) || []).length
      expect(dollarCount % 2).toBe(0)
    }

    // Each DO block should be a single statement that includes both
    // its opening "DO $$" and closing "END $$".
    const doBlocks = stmts.filter((s) => /\bDO\s+\$\$/i.test(s))
    expect(doBlocks.length).toBeGreaterThan(0)
    for (const s of doBlocks) {
      expect(s).toMatch(/END\s+\$\$/i)
    }
  })
})
