/**
 * PTYCAP-08 plan 04: the frozen allowlist, the unlisted-kind guard, the literal
 * quoter and the rollback builder. Transaction behaviour is in the second half
 * of this file. DB-free: the recording fake stands in for the sql tag. Real
 * concurrency (two overlapping fixes serialising on the FOR UPDATE row lock)
 * cannot be shown with a fake and is proven against a real database in plan 09.
 */
import { afterAll, describe, expect, mock, test } from 'bun:test'
import { createTaskQcFakeSql } from './fixtures/task-qc-fake-sql.ts'

afterAll(() => {
  mock.restore()
})

const mod = (await import(`../src/task-qc/safe-fixes.ts?sf=${Date.now()}`)) as typeof import('../src/task-qc/safe-fixes.ts')
const { SAFE_FIXES, applyFix, sqlLiteral, buildRollbackSql } = mod

const FINDING: any = {
  detector: 'NEVER_FIRED',
  taskId: 't1',
  taskName: 'n',
  taskType: 'dev',
  severity: 'warn',
  evidence: { reasons: ['timezone_invalid'] },
  proposal: { kind: 'fix_timezone', params: { taskId: 't1' } },
  fixCandidate: 'normalize_timezone',
}
const CTX: any = { userId: 'u1', taskId: 't1', day: '2026-10-13', finding: FINDING }

describe('SAFE_FIXES allowlist', () => {
  test('exactly the three listed kinds, no more', () => {
    expect([...SAFE_FIXES].sort()).toEqual(['backfill_payload_from_sibling', 'normalize_timezone', 'rebind_dead_session'])
    expect(SAFE_FIXES.size).toBe(3)
    for (const k of ['normalize_timezone', 'backfill_payload_from_sibling', 'rebind_dead_session']) expect(SAFE_FIXES.has(k as any)).toBe(true)
    expect(SAFE_FIXES.has('recompute_next_run_at' as any)).toBe(false)
  })

  test('add, delete and clear throw, and the prototype route is not available', () => {
    const s: any = SAFE_FIXES
    expect(() => s.add('disable_task')).toThrow()
    expect(() => s.delete('normalize_timezone')).toThrow()
    expect(() => s.clear()).toThrow()
    expect(() => Set.prototype.add.call(s, 'disable_task')).toThrow()
    expect(Object.isFrozen(SAFE_FIXES)).toBe(true)
    expect(SAFE_FIXES.size).toBe(3)
  })
})

describe('unlisted fix kinds', () => {
  const hostile: unknown[] = [
    'disable_task',
    'enable_task',
    'set_enabled',
    'edit_prompt',
    'change_cadence',
    'delete_task',
    'create_task',
    'raise_cap',
    'set_env',
    'recompute_next_run_at',
    '',
    undefined,
    null,
    42,
    ['normalize_timezone'],
    'normalize_timezone ',
    ' normalize_timezone',
    'NORMALIZE_TIMEZONE',
    'constructor',
    '__proto__',
    'toString',
    'hasOwnProperty',
  ]
  test.each(hostile.map((k) => [String(k), k]))('applyFix(%s) throws unlisted_fix_kind with zero statements and zero begin', async (_n, kind) => {
    const fake = createTaskQcFakeSql()
    let err: any
    try {
      await applyFix(fake.sql, { kind } as any, CTX)
    } catch (e) {
      err = e
    }
    expect(err?.code).toBe('unlisted_fix_kind')
    expect(fake.state.statements.length).toBe(0)
    expect(fake.state.beginCalls).toBe(0)
  })

  test('a missing fix object also throws before any statement', async () => {
    const fake = createTaskQcFakeSql()
    await expect(applyFix(fake.sql, undefined as any, CTX)).rejects.toMatchObject({ code: 'unlisted_fix_kind' })
    expect(fake.state.statements.length).toBe(0)
  })
})

describe('sqlLiteral', () => {
  test('strings are quoted with embedded quotes doubled; backslashes and unicode untouched', () => {
    expect(sqlLiteral('abc')).toBe("'abc'")
    expect(sqlLiteral("o'brien")).toBe("'o''brien'")
    expect(sqlLiteral("''")).toBe("''''''")
    expect(sqlLiteral('a\\b')).toBe("'a\\b'")
    expect(sqlLiteral('café ☃')).toBe("'café ☃'")
  })
  test('null, undefined, numbers and booleans', () => {
    expect(sqlLiteral(null)).toBe('NULL')
    expect(sqlLiteral(undefined)).toBe('NULL')
    expect(sqlLiteral(7)).toBe('7')
    expect(sqlLiteral(-1.5)).toBe('-1.5')
    expect(sqlLiteral(true)).toBe('true')
    expect(sqlLiteral(false)).toBe('false')
    expect(() => sqlLiteral(Number.NaN)).toThrow()
    expect(() => sqlLiteral(Infinity)).toThrow()
  })
  test('objects and arrays become quoted jsonb with quotes doubled', () => {
    expect(sqlLiteral({ a: 1 })).toBe(`'{"a":1}'::jsonb`)
    expect(sqlLiteral({ a: "x'y" })).toBe(`'{"a":"x''y"}'::jsonb`)
    expect(sqlLiteral([1, 'b'])).toBe(`'[1,"b"]'::jsonb`)
  })
  test('a NUL byte throws, in a string or inside json', () => {
    expect(() => sqlLiteral('a\u0000b')).toThrow()
    expect(() => sqlLiteral({ a: 'a\u0000b' })).toThrow()
  })
  test('a function or symbol is rejected', () => {
    expect(() => sqlLiteral(() => 1)).toThrow()
    expect(() => sqlLiteral(Symbol('x'))).toThrow()
  })
})

describe('buildRollbackSql', () => {
  test('timezone restores the before value, guarded by the after value', () => {
    const sql = buildRollbackSql('normalize_timezone', 't1', { timezone: 'Mars/Base' }, { timezone: 'UTC' })
    expect(sql).toBe(`UPDATE scheduled_tasks SET timezone = 'Mars/Base' WHERE id = 't1' AND timezone IS NOT DISTINCT FROM 'UTC'`)
  })
  test('payload fix removes only application_uuid, guarded by the backfilled value', () => {
    const sql = buildRollbackSql('backfill_payload_from_sibling', 't1', { application_uuid: null }, { application_uuid: 'abc' })
    expect(sql).toBe(
      `UPDATE scheduled_tasks SET payload = payload - 'application_uuid' WHERE id = 't1' AND payload->>'application_uuid' IS NOT DISTINCT FROM 'abc'`,
    )
  })
  test('payload fix with a prior empty value restores that value instead of deleting the key', () => {
    const sql = buildRollbackSql('backfill_payload_from_sibling', 't1', { application_uuid: '' }, { application_uuid: 'abc' })
    expect(sql).toContain(`jsonb_build_object('application_uuid', ''::text)`)
    expect(sql).not.toContain('payload - ')
  })
  test('session rebind restores both columns, guarded by both after values', () => {
    const sql = buildRollbackSql('rebind_dead_session', 't1', { session_id: 'old', target_id: null }, { session_id: 'new', target_id: null })
    expect(sql).toBe(
      `UPDATE scheduled_tasks SET session_id = 'old', target_id = NULL WHERE id = 't1' AND session_id IS NOT DISTINCT FROM 'new' AND target_id IS NOT DISTINCT FROM NULL`,
    )
  })
  test('hostile data lands only inside quoted literals; column names never come from data', () => {
    const evil = "x'; UPDATE scheduled_tasks SET enabled = false; --"
    const sql = buildRollbackSql('normalize_timezone', evil, { timezone: evil }, { timezone: 'UTC' })
    expect(sql).toContain(`'x''; UPDATE scheduled_tasks SET enabled = false; --'`)
    // stripping every quoted literal leaves only the fixed template
    const skeleton = sql.replace(/'(?:[^']|'')*'/g, "''")
    expect(skeleton).toBe(`UPDATE scheduled_tasks SET timezone = '' WHERE id = '' AND timezone IS NOT DISTINCT FROM ''`)
  })
  test('an unlisted kind throws', () => {
    expect(() => buildRollbackSql('disable_task' as any, 't1', {}, {})).toThrow()
  })
})
