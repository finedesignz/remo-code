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

// ---------------------------------------------------------------------------
// Transaction behaviour (Task 2)
// ---------------------------------------------------------------------------
const baseRow = (over: Record<string, unknown> = {}) => ({
  id: 't1',
  user_id: 'u1',
  name: 'nightly',
  task_type: 'dev',
  enabled: true,
  schedule_kind: 'cron',
  timezone: 'Mars/Base',
  payload: {},
  session_id: 's-old',
  target_kind: 'session',
  target_id: 's-old',
  ...over,
})

function setup(row: Record<string, unknown> | null, opts: { ownOpen?: boolean; sharedOpen?: boolean } = {}) {
  const fake = createTaskQcFakeSql()
  fake.on(/FROM scheduled_tasks WHERE id = \? AND user_id = \? FOR UPDATE/, row ? [row] : [])
  fake.on(/FROM sessions WHERE id = \? FOR UPDATE/, [{ id: 's1' }])
  fake.on(/FROM scheduled_task_runs WHERE task_id/, opts.ownOpen ? [{ open: 1 }] : [])
  fake.on(/FROM scheduled_task_runs WHERE session_id/, opts.sharedOpen ? [{ open: 1 }] : [])
  fake.on(/UPDATE scheduled_tasks SET timezone/, (v) => [{ timezone: v[0] }])
  fake.on(/UPDATE scheduled_tasks SET payload/, (v) => [{ payload: { ...((row?.payload as object) ?? {}), application_uuid: v[0] } }])
  fake.on(/UPDATE scheduled_tasks SET session_id/, (v) => [
    {
      session_id: row?.session_id === v[0] ? v[1] : row?.session_id,
      target_id: row?.target_id === v[0] ? v[1] : row?.target_id,
    },
  ])
  fake.on('INSERT INTO task_qc_findings', [{ id: 'f1' }])
  return fake
}

const kinds = (fake: ReturnType<typeof createTaskQcFakeSql>) => fake.state.statements.map((s) => s.kind + (s.forUpdate ? ':forupdate' : ''))

describe('applyFix transaction', () => {
  test('timezone fix: one begin, lock then in-flight then update then insert, all in tx 1', async () => {
    const fake = setup(baseRow())
    const r = await applyFix(fake.sql, { kind: 'normalize_timezone', timezone: 'UTC' }, CTX)
    expect(r.status).toBe('applied')
    expect(fake.state.beginCalls).toBe(1)
    expect(kinds(fake)).toEqual(['select:forupdate', 'select:forupdate', 'select', 'select', 'update', 'insert'])
    expect(fake.state.statements.every((s) => s.tx === 1)).toBe(true)
    // lock is scoped by id AND user
    expect(fake.state.statements[0]!.text).toContain('id = ? AND user_id = ?')
    expect(fake.state.statements[0]!.values).toEqual(['t1', 'u1'])
    fake.assertNoUnknown()
  })

  test('applied result: rowsWritten 2, before/after over the changed column, guarded rollback, audit row fields', async () => {
    const fake = setup(baseRow())
    const r: any = await applyFix(fake.sql, { kind: 'normalize_timezone', timezone: 'UTC' }, CTX)
    expect(r.rowsWritten).toBe(2)
    expect(r.before).toEqual({ timezone: 'Mars/Base' })
    expect(r.after).toEqual({ timezone: 'UTC' })
    expect(r.rollbackSql).toBe(`UPDATE scheduled_tasks SET timezone = 'Mars/Base' WHERE id = 't1' AND timezone IS NOT DISTINCT FROM 'UTC'`)
    const ins = fake.state.statements.find((s) => s.kind === 'insert')!
    expect(ins.values).toContain('auto_fixed')
    expect(ins.values).toContain('normalize_timezone')
    expect(ins.values).toContain(r.rollbackSql)
    expect(ins.values).toContain('{"timezone":"Mars/Base"}')
    expect(ins.values).toContain('{"timezone":"UTC"}')
    expect(fake.state.updatesTo('scheduled_tasks').length).toBe(1)
  })

  test('payload backfill writes only application_uuid and records a null before', async () => {
    const fake = setup(baseRow({ task_type: 'log_check', payload: { keep: 1 }, timezone: 'UTC' }))
    const r: any = await applyFix(fake.sql, { kind: 'backfill_payload_from_sibling', applicationUuid: 'abc' }, CTX)
    expect(r.status).toBe('applied')
    expect(r.before).toEqual({ application_uuid: null })
    expect(r.after).toEqual({ application_uuid: 'abc' })
    expect(r.rollbackSql).toContain("payload - 'application_uuid'")
    const upd = fake.state.updatesTo('scheduled_tasks')[0]!
    expect(upd.text).toContain("jsonb_build_object('application_uuid'")
    expect(upd.values).toEqual(['abc', 't1', 'u1'])
  })

  test('session rebind rewrites session_id and target_id only where they equal the old id', async () => {
    const fake = setup(baseRow({ timezone: 'UTC', target_id: 's-old', session_id: 's-old' }))
    const r: any = await applyFix(fake.sql, { kind: 'rebind_dead_session', oldSessionId: 's-old', newSessionId: 's-new' }, CTX)
    expect(r.status).toBe('applied')
    expect(r.after).toEqual({ session_id: 's-new', target_id: 's-new' })
    expect(r.before).toEqual({ session_id: 's-old', target_id: 's-old' })
    expect(r.rollbackSql).toContain("SET session_id = 's-old', target_id = 's-old'")
    const upd = fake.state.updatesTo('scheduled_tasks')[0]!
    expect(upd.text).toContain('CASE WHEN session_id = ? THEN ? ELSE session_id END')
  })

  test.each([
    ['disabled row', baseRow({ enabled: false })],
    ['internal anchor', baseRow({ name: '__internal_nightly' })],
    ['task_qc row', baseRow({ task_type: 'task_qc' })],
    ['orchestrator row', baseRow({ task_type: 'orchestrator' })],
    ['once schedule', baseRow({ schedule_kind: 'once' })],
    ['vanished row', null],
  ])('%s is refused_not_auditable: no update, no finding row', async (_n, row) => {
    const fake = setup(row as any)
    const r = await applyFix(fake.sql, { kind: 'normalize_timezone', timezone: 'UTC' }, CTX)
    expect(r.status).toBe('refused_not_auditable')
    expect(r.rowsWritten).toBe(0)
    expect(fake.state.writes().length).toBe(0)
    expect(kinds(fake)).toEqual(['select:forupdate'])
  })

  test.each([
    ['timezone now valid', baseRow({ timezone: 'America/Los_Angeles' }), { kind: 'normalize_timezone', timezone: 'UTC' }],
    ['payload now has a uuid', baseRow({ task_type: 'log_check', payload: { application_uuid: 'zzz' } }), { kind: 'backfill_payload_from_sibling', applicationUuid: 'abc' }],
    ['session id moved on', baseRow({ session_id: 's-other', target_id: 's-other' }), { kind: 'rebind_dead_session', oldSessionId: 's-old', newSessionId: 's-new' }],
    ['payload fix on a non log task', baseRow({ task_type: 'dev' }), { kind: 'backfill_payload_from_sibling', applicationUuid: 'abc' }],
  ])('precondition changed (%s) is noop_changed with no write', async (_n, row, fix) => {
    const fake = setup(row as any)
    const r = await applyFix(fake.sql, fix as any, CTX)
    expect(r.status).toBe('noop_changed')
    expect(fake.state.writes().length).toBe(0)
  })

  test('a throw from the UPDATE propagates, the finding insert never runs, no retry', async () => {
    const fake = setup(baseRow())
    fake.failOn(/UPDATE scheduled_tasks SET timezone/, new Error('boom'))
    await expect(applyFix(fake.sql, { kind: 'normalize_timezone', timezone: 'UTC' }, CTX)).rejects.toThrow('boom')
    expect(fake.state.statements.filter((s) => s.kind === 'insert').length).toBe(0)
    expect(fake.state.updatesTo('scheduled_tasks').length).toBe(1)
    expect(fake.state.beginCalls).toBe(1)
  })

  test('a throw from the finding insert propagates out of the transaction', async () => {
    const fake = setup(baseRow())
    fake.failOn('INSERT INTO task_qc_findings', new Error('insert failed'))
    await expect(applyFix(fake.sql, { kind: 'normalize_timezone', timezone: 'UTC' }, CTX)).rejects.toThrow('insert failed')
    expect(fake.state.beginCalls).toBe(1)
  })

  test('an audit insert that conflicts aborts the transaction instead of leaving an unaudited write', async () => {
    const fake = createTaskQcFakeSql()
    fake.on(/FROM scheduled_tasks WHERE id = \? AND user_id = \? FOR UPDATE/, [baseRow()])
    fake.on(/FROM scheduled_task_runs/, [])
    fake.on(/UPDATE scheduled_tasks SET timezone/, [{ timezone: 'UTC' }])
    fake.on('INSERT INTO task_qc_findings', [])
    await expect(applyFix(fake.sql, { kind: 'normalize_timezone', timezone: 'UTC' }, CTX)).rejects.toThrow('audit row not inserted')
  })

  test('invalid fix arguments throw before the transaction opens', async () => {
    const fake = setup(baseRow())
    await expect(applyFix(fake.sql, { kind: 'normalize_timezone', timezone: 'Not/AZone' }, CTX)).rejects.toThrow('invalid fix arguments')
    await expect(applyFix(fake.sql, { kind: 'rebind_dead_session', oldSessionId: 'a', newSessionId: 'a' }, CTX)).rejects.toThrow('invalid fix arguments')
    await expect(applyFix(fake.sql, { kind: 'backfill_payload_from_sibling', applicationUuid: '' }, CTX)).rejects.toThrow('invalid fix arguments')
    expect(fake.state.statements.length).toBe(0)
    expect(fake.state.beginCalls).toBe(0)
  })

  test('two fixes for one task: each begins its own transaction and its statements are contiguous', async () => {
    const fake = setup(baseRow())
    await applyFix(fake.sql, { kind: 'normalize_timezone', timezone: 'UTC' }, CTX)
    await applyFix(fake.sql, { kind: 'normalize_timezone', timezone: 'UTC' }, CTX)
    expect(fake.state.beginCalls).toBe(2)
    expect(fake.state.statements.map((s) => s.tx)).toEqual([1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2])
  })
})
