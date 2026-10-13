/** PTYCAP-08 self-test for the strict fake sql fixture (no src/task-qc imports). */
import { describe, expect, test } from 'bun:test'
import { createTaskQcFakeSql } from './fixtures/task-qc-fake-sql.ts'

describe('task-qc fake sql fixture', () => {
  test('records normalised statements with kinds', async () => {
    const f = createTaskQcFakeSql()
    f.on('FROM t', [{ a: 1 }])
    f.on('INSERT INTO t', [{ id: 'x' }])
    f.on('UPDATE scheduled_tasks', [])
    f.on('DELETE FROM t', [])
    f.on('other_thing', [])
    await f.sql`SELECT   *
      FROM t`
    await f.sql`INSERT INTO t (a) VALUES (${1})`
    await f.sql`UPDATE scheduled_tasks SET enabled = ${true}`
    await f.sql`DELETE FROM t`
    await f.sql`VACUUM other_thing`
    const kinds = f.state.statements.map((s) => s.kind)
    expect(kinds).toEqual(['select', 'insert', 'update', 'delete', 'other'])
    expect(f.state.statements[0]!.text).toBe('SELECT * FROM t')
    expect(f.state.statements[1]!.values).toEqual([1])
  })

  test('responder may be rows or a function of the bound values', async () => {
    const f = createTaskQcFakeSql()
    f.on('FROM a', [{ n: 1 }])
    f.on('FROM b', (values) => [{ n: values[0] }])
    expect(await f.sql`SELECT n FROM a`).toEqual([{ n: 1 }])
    expect(await f.sql`SELECT n FROM b WHERE x = ${42}`).toEqual([{ n: 42 }])
    f.assertNoUnknown()
  })

  test('unmatched statement lands in unknown and assertNoUnknown throws', async () => {
    const f = createTaskQcFakeSql()
    await f.sql`SELECT 1 FROM nowhere`
    expect(f.state.unknown).toEqual(['SELECT 1 FROM nowhere'])
    expect(() => f.assertNoUnknown()).toThrow(/unanticipated/)
  })

  test('writes() and updatesTo() expose the write spy', async () => {
    const f = createTaskQcFakeSql()
    f.on('SELECT', [])
    f.on('INSERT', [])
    f.on('UPDATE', [])
    await f.sql`SELECT 1`
    expect(f.state.writes()).toEqual([])
    await f.sql`INSERT INTO task_qc_findings (a) VALUES (${1})`
    await f.sql`UPDATE scheduled_tasks SET enabled = false`
    await f.sql`UPDATE other_table SET x = 1`
    expect(f.state.writes().length).toBe(3)
    expect(f.state.updatesTo('scheduled_tasks').length).toBe(1)
  })

  test('begin() hands a tx with the same shape and counts begin and advisory locks', async () => {
    const f = createTaskQcFakeSql()
    f.on('FROM t', [{ ok: true }])
    const out = await f.sql.begin(async (tx: any) => {
      await tx`SELECT pg_advisory_xact_lock(${7})`
      await tx`SET LOCAL statement_timeout = 5000`
      return tx`SELECT ok FROM t`
    })
    expect(out).toEqual([{ ok: true }])
    expect(f.state.beginCalls).toBe(1)
    expect(f.state.lockCalls).toBe(1)
    expect(f.state.setLocalCalls).toBe(1)
    expect(f.state.statements.map((s) => s.kind)).toEqual(['lock', 'set_local', 'select'])
    expect(f.state.statements.every((s) => s.tx === 1)).toBe(true)
    f.assertNoUnknown()
  })

  test('FOR UPDATE is flagged so a test can assert lock precedes write in a tx', async () => {
    const f = createTaskQcFakeSql()
    f.on('FOR UPDATE', [{ id: 'a' }])
    f.on('UPDATE scheduled_tasks', [])
    await f.sql.begin(async (tx: any) => {
      await tx`SELECT id FROM scheduled_tasks WHERE id = ${'a'} FOR UPDATE`
      await tx`UPDATE scheduled_tasks SET enabled = false WHERE id = ${'a'}`
    })
    const s = f.state.statements
    expect(s[0]!.forUpdate).toBe(true)
    expect(s[1]!.forUpdate).toBe(false)
    expect(s.findIndex((x) => x.forUpdate)).toBeLessThan(s.findIndex((x) => x.kind === 'update'))
  })

  test('failOn throws as a rejected promise and the statement is still recorded', async () => {
    const f = createTaskQcFakeSql()
    f.failOn('INSERT INTO boom', new Error('kaput'))
    await expect(f.sql`INSERT INTO boom (a) VALUES (${1})`).rejects.toThrow('kaput')
    expect(f.state.statements.length).toBe(1)
  })

  test('reset() clears recorded state and responders', async () => {
    const f = createTaskQcFakeSql()
    f.on('SELECT', [{ a: 1 }])
    await f.sql`SELECT 1`
    f.reset()
    expect(f.state.statements.length).toBe(0)
    await f.sql`SELECT 1`
    expect(f.state.unknown.length).toBe(1)
  })
})
