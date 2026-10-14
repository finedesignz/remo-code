/**
 * PTYCAP-04-06 (panel F-4): rearmOnceTask is the exact inverse of claimOnceTask.
 *
 * A fake `sql` tag emulates only the two scheduled_tasks UPDATE statements
 * (recognised by their SET clause) over in-memory rows, applying their WHERE guards.
 * The real SQL runs against Postgres in CI (the e2e leg); this proves the guard
 * semantics and the claim -> rearm round trip, and pins the SQL text it emulates.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-chars-long-aaaaaaaa'

import { describe, test, expect, beforeEach, afterAll, mock } from 'bun:test'

interface Row {
  id: string
  schedule_kind: string
  enabled: boolean
  run_at: string | null
  next_fire_at: string | null
  next_run_at: string | null
  payload: Record<string, any>
}
let rows: Row[] = []
const texts: string[] = []

const sqlFake: any = (strings: TemplateStringsArray, ...values: any[]) => {
  const text = strings.join('?')
  texts.push(text)
  if (text.includes('UPDATE scheduled_tasks') && text.includes('SET enabled = false')) {
    // claim: values = [reason, taskId]
    const [reason, taskId] = values
    const hit = rows.filter((r) => r.id === taskId && r.schedule_kind === 'once' && r.enabled === true)
    for (const r of hit) {
      r.enabled = false
      r.next_fire_at = null
      r.next_run_at = null
      r.payload = { ...r.payload, completed_reason: reason, completed_at: 'now' }
    }
    return Promise.resolve(hit.map((r) => ({ id: r.id })))
  }
  if (text.includes('UPDATE scheduled_tasks') && text.includes('SET enabled = true')) {
    // rearm: values = [taskId, reason]
    const [taskId, reason] = values
    const hit = rows.filter(
      (r) => r.id === taskId && r.schedule_kind === 'once' && r.enabled === false && r.payload.completed_reason === reason,
    )
    for (const r of hit) {
      r.enabled = true
      r.next_fire_at = r.run_at
      r.next_run_at = r.run_at
      const { completed_reason: _a, completed_at: _b, ...rest } = r.payload
      r.payload = rest
    }
    return Promise.resolve(hit.map((r) => ({ id: r.id })))
  }
  return Promise.resolve([])
}
sqlFake.begin = async (fn: any) => fn(sqlFake)

mock.module('../src/db/postgres.ts', () => ({ sql: sqlFake }))
afterAll(() => mock.restore())

const { claimOnceTask, rearmOnceTask } = await import('../src/db/scheduled-tasks-dal.ts')

const RUN_AT = '2026-10-13T10:00:00.000Z'
const onceRow = (over: Partial<Row> = {}): Row => ({
  id: 't1',
  schedule_kind: 'once',
  enabled: true,
  run_at: RUN_AT,
  next_fire_at: RUN_AT,
  next_run_at: RUN_AT,
  payload: { work_id: 'w1' },
  ...over,
})

beforeEach(() => {
  rows = [onceRow()]
  texts.length = 0
})

describe('rearmOnceTask', () => {
  test('claim then rearm restores enabled, next_fire_at and next_run_at from run_at and strips the completion keys', async () => {
    expect(await claimOnceTask('t1')).toBe(true)
    expect(rows[0].enabled).toBe(false)
    expect(rows[0].next_fire_at).toBeNull()
    expect(rows[0].payload.completed_reason).toBe('once_completed')

    expect(await rearmOnceTask('t1')).toBe(true)
    expect(rows[0].enabled).toBe(true)
    expect(rows[0].next_fire_at).toBe(RUN_AT)
    expect(rows[0].next_run_at).toBe(RUN_AT)
    expect(rows[0].payload).toEqual({ work_id: 'w1' }) // original payload, no completed_* keys
  })

  test('after a rearm the same task can be claimed again (the sweep re-fire path)', async () => {
    await claimOnceTask('t1')
    await rearmOnceTask('t1')
    expect(await claimOnceTask('t1')).toBe(true)
  })

  test('an already-enabled once row is untouched (returns false)', async () => {
    expect(await rearmOnceTask('t1')).toBe(false)
    expect(rows[0].enabled).toBe(true)
  })

  test('a non-once row is untouched even if disabled with the completed reason', async () => {
    rows = [onceRow({ schedule_kind: 'cron', enabled: false, payload: { completed_reason: 'once_completed' } })]
    expect(await rearmOnceTask('t1')).toBe(false)
    expect(rows[0].enabled).toBe(false)
  })

  test('a once row disabled for a DIFFERENT reason (e.g. user disabled / bound reached) is not resurrected', async () => {
    rows = [onceRow({ enabled: false, payload: { completed_reason: 'max_runs' } })]
    expect(await rearmOnceTask('t1')).toBe(false)
    rows = [onceRow({ enabled: false, payload: {} })]
    expect(await rearmOnceTask('t1')).toBe(false)
    expect(rows[0].enabled).toBe(false)
  })

  test('the emulated SQL carries every guard (pins the statement the fake mirrors)', async () => {
    await rearmOnceTask('t1')
    const stmt = texts.find((t) => t.includes('SET enabled = true'))!
    expect(stmt).toContain("schedule_kind = 'once'")
    expect(stmt).toContain('enabled = false')
    expect(stmt).toContain("payload->>'completed_reason'")
    expect(stmt).toContain('next_fire_at = run_at')
    expect(stmt).toContain("- 'completed_reason' - 'completed_at'")
  })
})
