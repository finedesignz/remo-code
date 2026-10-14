/**
 * PTYCAP-08-08 Task 1: idempotent boot seed (D-02, D-05, D-06, A-05, A-08, F2-B2).
 * DB-free: strict fake sql. Flag off => zero statements.
 */
import { describe, test, expect, beforeEach, afterEach, afterAll, mock, spyOn } from 'bun:test'
import { createTaskQcFakeSql } from './fixtures/task-qc-fake-sql.ts'

const fake = createTaskQcFakeSql()
mock.module('../src/db/postgres.ts', () => ({ sql: fake.sql }))
const { seedTaskQcTasks } = await import('../src/task-qc/seed.ts?seed-test')

const ENV_KEYS = ['REMO_TASK_QC_ENABLED', 'REMO_TASK_QC_AUTOFIX', 'REMO_TASK_QC_CADENCE']
let saved: Record<string, string | undefined> = {}
let logs: string[] = []
let errors: string[] = []
let logSpy: any
let errSpy: any

const U1 = '00000000-0000-0000-0000-0000000000a1'
const U2 = '00000000-0000-0000-0000-0000000000a2'

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
  for (const k of ENV_KEYS) delete process.env[k]
  fake.reset()
  logs = []
  errors = []
  logSpy = spyOn(console, 'log').mockImplementation((...a: any[]) => { logs.push(a.join(' ')) })
  errSpy = spyOn(console, 'error').mockImplementation((...a: any[]) => { errors.push(a.join(' ')) })
})
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  logSpy.mockRestore()
  errSpy.mockRestore()
})
afterAll(() => mock.restore())

const inserts = () => fake.state.statements.filter((s) => s.kind === 'insert')

describe('seedTaskQcTasks', () => {
  test('flag OFF: zero database calls', async () => {
    fake.onSelect('FROM users', [{ id: U1, timezone: 'UTC' }])
    const r = await seedTaskQcTasks()
    expect(fake.state.statements.length).toBe(0)
    expect(r.seeded).toBe(0)
    expect(logs.length).toBe(0)
  })

  test('flag ON: one INSERT per eligible user with the D-02 / A-08 values', async () => {
    process.env.REMO_TASK_QC_ENABLED = '1'
    fake.onSelect('FROM users', [{ id: U1, timezone: 'America/Los_Angeles' }])
    fake.onInsert('INSERT INTO scheduled_tasks', () => [{ id: 'qc-1' }])
    const r = await seedTaskQcTasks()
    expect(r.seeded).toBe(1)
    const ins = inserts()
    expect(ins.length).toBe(1)
    const s = ins[0]!
    // literal columns pinned in the statement text
    expect(s.text).toContain("'task_qc'")
    expect(s.text).toMatch(/session_id/)
    expect(s.text).toContain("'{}'::jsonb")
    expect(s.text).toMatch(/\bNULL\b/)
    expect(s.text).toContain("''")
    expect(s.text).toContain("'skip'")
    expect(s.text).toContain("'cron'")
    expect(s.text).toContain("'session'")
    // bound values: user, name, cadence (legacy + new column), timezone
    expect(s.values).toContain(U1)
    expect(s.values.filter((v) => v === '0 9 * * *').length).toBe(2)
    expect(s.values).toContain('America/Los_Angeles')
    const name = s.values.find((v) => typeof v === 'string' && /audit/i.test(v)) as string
    expect(name).toBeTruthy()
    expect(name.startsWith('__internal_')).toBe(false)
    // email_summary false, enabled true
    expect(s.values).toContain(false)
    expect(s.values).toContain(true)
    // never mutates anything else
    expect(fake.state.statements.filter((x) => x.kind === 'update' || x.kind === 'delete').length).toBe(0)
  })

  test('cadence comes from the validated env cadence', async () => {
    process.env.REMO_TASK_QC_ENABLED = '1'
    process.env.REMO_TASK_QC_CADENCE = '0 */6 * * *'
    fake.onSelect('FROM users', [{ id: U1, timezone: 'UTC' }])
    fake.onInsert('INSERT INTO scheduled_tasks', () => [{ id: 'qc-1' }])
    await seedTaskQcTasks()
    expect(inserts()[0]!.values.filter((v) => v === '0 */6 * * *').length).toBe(2)
  })

  test('invalid user timezone falls back to UTC', async () => {
    process.env.REMO_TASK_QC_ENABLED = '1'
    fake.onSelect('FROM users', [{ id: U1, timezone: 'Not/AZone' }])
    fake.onInsert('INSERT INTO scheduled_tasks', () => [{ id: 'qc-1' }])
    await seedTaskQcTasks()
    const v = inserts()[0]!.values
    expect(v).toContain('UTC')
    expect(v).not.toContain('Not/AZone')
  })

  test('eligibility is decided in SQL: audit-set predicate and no existing task_qc row', async () => {
    process.env.REMO_TASK_QC_ENABLED = '1'
    fake.onSelect('FROM users', [])
    await seedTaskQcTasks()
    const sel = fake.state.statements.find((s) => s.kind === 'select')!
    expect(sel.text).toContain('EXISTS')
    expect(sel.text).toContain("task_type <> 'task_qc'")
    expect(sel.text).toContain("task_type <> 'orchestrator'")
    expect(sel.text).toContain("__internal_")
    expect(sel.text).toContain("schedule_kind = 'cron'")
    expect(sel.text).toContain('enabled = true')
    expect(sel.text).toContain('NOT EXISTS')
    expect(inserts().length).toBe(0)
  })

  test('idempotent: INSERT carries ON CONFLICT DO NOTHING on the per-user partial index; a conflict inserts nothing and does not throw', async () => {
    process.env.REMO_TASK_QC_ENABLED = '1'
    fake.onSelect('FROM users', [{ id: U1, timezone: 'UTC' }])
    fake.onInsert('INSERT INTO scheduled_tasks', () => [])
    const r1 = await seedTaskQcTasks()
    const r2 = await seedTaskQcTasks()
    expect(r1.seeded).toBe(0)
    expect(r2.seeded).toBe(0)
    for (const s of inserts()) {
      expect(s.text).toMatch(/ON CONFLICT \(user_id\) WHERE task_type = 'task_qc' DO NOTHING/)
    }
    expect(errors.length).toBe(0)
  })

  test('two eligible users get two independent rows; none for users with zero audited tasks (SQL returns none)', async () => {
    process.env.REMO_TASK_QC_ENABLED = '1'
    fake.onSelect('FROM users', [{ id: U1, timezone: 'UTC' }, { id: U2, timezone: 'UTC' }])
    fake.onInsert('INSERT INTO scheduled_tasks', () => [{ id: 'x' }])
    const r = await seedTaskQcTasks()
    expect(r.seeded).toBe(2)
    const users = inserts().map((s) => s.values.find((v) => v === U1 || v === U2))
    expect(users).toEqual([U1, U2])
  })

  test('a failing user is logged with its id and the remaining users are still attempted', async () => {
    process.env.REMO_TASK_QC_ENABLED = '1'
    fake.onSelect('FROM users', [{ id: U1, timezone: 'UTC' }, { id: U2, timezone: 'UTC' }])
    let n = 0
    fake.onInsert('INSERT INTO scheduled_tasks', () => {
      n++
      if (n === 1) throw new Error('db down')
      return [{ id: 'x' }]
    })
    const r = await seedTaskQcTasks()
    expect(r.seeded).toBe(1)
    expect(inserts().length).toBe(2)
    expect(errors.some((e) => e.includes(U1) && e.includes('db down'))).toBe(true)
  })

  test('a failing eligibility query is logged and does not throw', async () => {
    process.env.REMO_TASK_QC_ENABLED = '1'
    fake.failOn('FROM users', new Error('select failed'))
    const r = await seedTaskQcTasks()
    expect(r.seeded).toBe(0)
    expect(errors.some((e) => e.includes('select failed'))).toBe(true)
  })

  test('AUTOFIX off: exactly one report-only soak line at seed time', async () => {
    process.env.REMO_TASK_QC_ENABLED = '1'
    fake.onSelect('FROM users', [])
    await seedTaskQcTasks()
    expect(logs.filter((l) => /report-only/i.test(l)).length).toBe(1)
  })

  test('AUTOFIX on: no soak line', async () => {
    process.env.REMO_TASK_QC_ENABLED = '1'
    process.env.REMO_TASK_QC_AUTOFIX = '1'
    fake.onSelect('FROM users', [])
    await seedTaskQcTasks()
    expect(logs.filter((l) => /report-only/i.test(l)).length).toBe(0)
  })
})
