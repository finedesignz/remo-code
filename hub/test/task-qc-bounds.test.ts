/**
 * PTYCAP-08-06 Task 3 (F1-A3): the deterministic bounds that replace the dropped
 * token ceiling are ENFORCED, one test per bound. DB-free over the strict fake.
 */
import { describe, test, expect, beforeEach, afterAll, mock } from 'bun:test'
import { makeEngineWorld, mk, okRun, failRuns, haltOk, baseDeps, USER, NOW } from './fixtures/task-qc-engine-fixture.ts'

const { world, reset } = makeEngineWorld()
const fake = world.fake
mock.module('../src/db/postgres.ts', () => ({ sql: fake.sql }))
afterAll(() => mock.restore())

const { runTaskQcPass } = await import('../src/task-qc/engine.ts')
const { TASK_QC_BOUNDS, clampBounds } = await import('../src/task-qc/flags.ts')

beforeEach(reset)

const run = (over: Record<string, unknown> = {}) =>
  runTaskQcPass({ userId: USER, origin: 'schedule', deps: baseDeps(fake, over) as any })
const updates = () => fake.state.updatesTo('scheduled_tasks')
const findingInserts = () => fake.state.statements.filter((s) => s.kind === 'insert' && /task_qc_findings/.test(s.text))

const seedBadTz = (n: number) => {
  for (let i = 0; i < n; i++) {
    const id = `tz${String(i).padStart(2, '0')}`
    world.store[id] = mk(id, { timezone: 'Mars/Phobos' })
    world.runs.push(okRun(id))
  }
}

describe('bounds (each enforced, not documented)', () => {
  test('maxAuditedTasks: more audited tasks than the cap audits exactly the cap and reports truncated', async () => {
    for (let i = 0; i < 5; i++) {
      world.store[`f${i}`] = mk(`f${i}`)
      world.runs.push(...failRuns(`f${i}`, 3))
    }
    const res = await run({ bounds: { maxAuditedTasks: 3 } })
    expect(res.truncated).toBe(true)
    expect(new Set(res.findings.map((f) => f.taskId)).size).toBe(3)
  })

  test('maxAuditedTasks can never be raised above the constant through the engine', async () => {
    for (let i = 0; i < TASK_QC_BOUNDS.maxAuditedTasks + 1; i++) world.store[`t${i}`] = mk(`t${i}`)
    const res = await run({ bounds: { maxAuditedTasks: TASK_QC_BOUNDS.maxAuditedTasks * 10 } })
    expect(res.truncated).toBe(true)
    const stmt = fake.state.statements.find((s) => /FROM scheduled_tasks WHERE user_id/.test(s.text))!
    expect(stmt.values).toContain(TASK_QC_BOUNDS.maxAuditedTasks + 1)
  })

  test('maxRunsPerTask: the history statement parameter equals the bound', async () => {
    world.store['a'] = mk('a')
    await run({ bounds: { maxRunsPerTask: 7 } })
    expect(fake.state.statements.find((s) => /ROW_NUMBER/.test(s.text))!.values).toContain(7)
    reset()
    world.store['a'] = mk('a')
    await run()
    expect(fake.state.statements.find((s) => /ROW_NUMBER/.test(s.text))!.values).toContain(TASK_QC_BOUNDS.maxRunsPerTask)
  })

  test('maxAutoFixesPerPass: 30 fixable findings apply exactly 25; 5 become fix_cap_reached proposals', async () => {
    seedBadTz(30)
    const res = await run({ autofix: true, haltCheck: haltOk })
    expect(res.applied).toHaveLength(25)
    expect(updates()).toHaveLength(25)
    const capped = res.proposals.filter((p) => p.proposal.params.reason === 'fix_cap_reached')
    expect(capped).toHaveLength(5)
    expect(res.proposals).toHaveLength(5)
    // the cap overflow is persisted as proposals, not applied
    expect(findingInserts().filter((s) => s.values.includes('proposed'))).toHaveLength(5)
  })

  test('maxRowsWrittenPerRun: past the budget findings are still returned, flagged unpersisted, and nothing more is written', async () => {
    for (let i = 0; i < 6; i++) {
      world.store[`f${i}`] = mk(`f${i}`)
      world.runs.push(...failRuns(`f${i}`, 3))
    }
    const res = await run({ bounds: { maxRowsWrittenPerRun: 3 } })
    expect(res.findings).toHaveLength(6)
    expect(res.truncated).toBe(true)
    expect(fake.state.writes()).toHaveLength(3)
    const unpersisted = res.proposals.filter((p) => p.proposal.params.persisted === false)
    expect(unpersisted).toHaveLength(3)
    for (const p of unpersisted) expect(p.proposal.params.reason).toBe('rows_budget_exhausted')
  })

  test('the row budget also stops fixes (a fix writes two rows)', async () => {
    seedBadTz(4)
    const res = await run({ autofix: true, haltCheck: haltOk, bounds: { maxRowsWrittenPerRun: 5 } })
    expect(res.applied).toHaveLength(2) // 2 fixes = 4 rows; a third would need 6
    expect(updates()).toHaveLength(2)
    expect(res.truncated).toBe(true)
  })

  test('passTimeoutMs: a deadline passing between phases stops cleanly, truncated, no partial fix', async () => {
    seedBadTz(5)
    // the clock jumps past the deadline once two fix UPDATEs have been issued
    const clock = () => (updates().length >= 2 ? NOW.getTime() + 10 * TASK_QC_BOUNDS.passTimeoutMs : NOW.getTime())
    const res = await run({ autofix: true, haltCheck: haltOk, clock })
    expect(res.truncated).toBe(true)
    expect(res.applied).toHaveLength(2)
    expect(updates()).toHaveLength(2)
    // each applied fix is whole: one UPDATE paired with one auto_fixed audit row in the same transaction
    expect(fake.state.statements.filter((s) => s.kind === 'insert' && s.values.includes('auto_fixed'))).toHaveLength(2)
    expect(res.proposals.filter((p) => p.proposal.params.reason === 'deadline')).toHaveLength(3)
  })

  test('wall clock: the read transaction is read-only with a local statement timeout', async () => {
    world.store['a'] = mk('a')
    await run()
    expect(fake.state.beginModes).toEqual(['read only'])
    expect(fake.state.setLocalCalls).toBeGreaterThanOrEqual(1) // re-armed before every statement
    const set = fake.state.statements.find((s) => s.kind === 'set_local')!
    expect(set.text).toBe(`SET LOCAL statement_timeout = ${TASK_QC_BOUNDS.passTimeoutMs}`)
  })

  test('clampBounds can lower any bound and can never raise one above the constant', () => {
    expect(clampBounds({ maxAutoFixesPerPass: 3 }).maxAutoFixesPerPass).toBe(3)
    for (const k of Object.keys(TASK_QC_BOUNDS) as Array<keyof typeof TASK_QC_BOUNDS>) {
      expect(clampBounds({ [k]: TASK_QC_BOUNDS[k] * 10 })[k]).toBe(TASK_QC_BOUNDS[k])
      expect(clampBounds({ [k]: Number.POSITIVE_INFINITY })[k]).toBe(TASK_QC_BOUNDS[k])
      expect(clampBounds({ [k]: -5 })[k]).toBe(TASK_QC_BOUNDS[k])
    }
  })
})
