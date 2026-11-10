/** PTYCAP-08 idempotent findings DAL (DB-free via the strict fake sql). */
import { describe, expect, test } from 'bun:test'
import { createTaskQcFakeSql } from './fixtures/task-qc-fake-sql.ts'
import { claimEngineFailure, evidenceSig, insertFinding, userDay } from '../src/task-qc/findings.ts'

const base = {
  userId: '00000000-0000-0000-0000-000000000001',
  taskId: 'task-1',
  detector: 'FAILING',
  disposition: 'proposed',
  evidence: { streak: 3, last: 'failed' },
  day: '2026-10-13',
} as const

describe('evidenceSig', () => {
  test('sha256 hex, key-order independent, detector-sensitive', () => {
    const a = evidenceSig('FAILING', { a: 1, b: { x: 1, y: 2 } })
    const b = evidenceSig('FAILING', { b: { y: 2, x: 1 }, a: 1 })
    expect(a).toMatch(/^[0-9a-f]{64}$/)
    expect(a).toBe(b)
    expect(evidenceSig('SKIP_FOREVER', { a: 1, b: { x: 1, y: 2 } })).not.toBe(a)
    expect(evidenceSig('FAILING', { a: 2 })).not.toBe(evidenceSig('FAILING', { a: 1 }))
  })
})

describe('insertFinding', () => {
  test('rejects unknown detector / disposition / severity before any SQL', async () => {
    const f = createTaskQcFakeSql()
    await expect(insertFinding(f.sql, { ...base, detector: 'BOGUS' as any })).rejects.toThrow(/detector/)
    await expect(insertFinding(f.sql, { ...base, disposition: 'nope' as any })).rejects.toThrow(/disposition/)
    await expect(insertFinding(f.sql, { ...base, severity: 'critical' as any })).rejects.toThrow(/severity/)
    expect(f.state.statements.length).toBe(0)
  })

  test('issues exactly one INSERT ... ON CONFLICT DO NOTHING RETURNING id and reports inserted', async () => {
    const f = createTaskQcFakeSql()
    f.onInsert('INSERT INTO task_qc_findings', [{ id: 'f-1' }])
    const r = await insertFinding(f.sql, base)
    expect(r).toEqual({ inserted: true, id: 'f-1' })
    expect(f.state.statements.length).toBe(1)
    const s = f.state.statements[0]!
    expect(s.kind).toBe('insert')
    expect(s.text).toContain('ON CONFLICT (user_id, task_id, detector, evidence_sig, day) DO NOTHING RETURNING id')
    expect(s.values).toContain(evidenceSig('FAILING', base.evidence))
    expect(s.values).toContain('2026-10-13')
    f.assertNoUnknown()
  })

  test('conflict (no row returned) reports inserted false', async () => {
    const f = createTaskQcFakeSql()
    f.onInsert('INSERT INTO task_qc_findings', [])
    expect(await insertFinding(f.sql, base)).toEqual({ inserted: false })
  })

  test('re-run of an unchanged condition computes the same idempotency key', async () => {
    const f = createTaskQcFakeSql()
    f.onInsert('INSERT INTO task_qc_findings', [])
    await insertFinding(f.sql, base)
    await insertFinding(f.sql, { ...base, evidence: { last: 'failed', streak: 3 } })
    const [a, b] = f.state.statements
    expect(a!.values).toEqual(b!.values)
  })

  test('works through a tx runner and contains no UPDATE', async () => {
    const f = createTaskQcFakeSql()
    f.onInsert('INSERT INTO task_qc_findings', [{ id: 'f-2' }])
    const out = await f.sql.begin((tx: any) => insertFinding(tx, base))
    expect(out.inserted).toBe(true)
    expect(f.state.statements.every((s) => s.tx === 1)).toBe(true)
    expect(f.state.statements.some((s) => s.kind === 'update')).toBe(false)
  })
})

describe('claimEngineFailure', () => {
  test('true on first call of a UTC day, false after', async () => {
    const f = createTaskQcFakeSql()
    let seen = 0
    f.onInsert('INSERT INTO task_qc_findings', () => (seen++ === 0 ? [{ id: 'e-1' }] : []))
    const args = { userId: base.userId, taskId: 'task-qc', utcDay: '2026-10-13' }
    expect(await claimEngineFailure(f.sql, args)).toBe(true)
    expect(await claimEngineFailure(f.sql, args)).toBe(false)
    const s = f.state.statements[0]!
    expect(s.values).toContain('ENGINE')
    expect(s.values).toContain('proposed')
    // evidence_sig is constant across calls
    expect(f.state.statements[1]!.values).toEqual(s.values)
  })
})

describe('userDay', () => {
  test('calendar date in the given timezone', () => {
    const now = new Date('2026-10-13T02:30:00Z')
    expect(userDay('UTC', now)).toBe('2026-10-13')
    expect(userDay('America/Los_Angeles', now)).toBe('2026-10-12')
    expect(userDay('Asia/Tokyo', now)).toBe('2026-10-13')
  })
  test('invalid timezone falls back to UTC', () => {
    expect(userDay('Not/AZone', new Date('2026-10-13T23:59:00Z'))).toBe('2026-10-13')
  })
})
