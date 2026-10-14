/**
 * PTYCAP-08-08 Task 2 (TQC-08, F2-B3): flag OFF is a true no-op across every
 * surface: registry load / register / replace, catchup, the fire path, the seed and
 * email - even for a task_qc row left behind from an earlier ON period.
 *
 * Real: registry (cache-busted import), catchup, dispatcher, seed. Mocked: the
 * fire-harness set plus a DAL superset that adds listEnabledTasks.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-chars-long-aaaaaaaa'

import { describe, test, expect, beforeEach, afterEach, afterAll, mock } from 'bun:test'
import { setupFireHarness, flush, qcTaskRow, controlTaskRow, QC_ID, CONTROL_ID, USER } from './fixtures/task-qc-fire-harness.ts'

const { h, reset } = setupFireHarness()
mock.module('../src/scheduler/post-run/dispatcher.ts', () => ({
  afterRun: async (input: any) => { h.afterRunCalls.push(input) },
}))
mock.module('../src/scheduler/senders/agent.ts', () => ({ sendAgentTask: async () => {} }))
mock.module('../src/scheduler/senders/supervisor.ts', () => ({ sendSupervisorTask: async () => {} }))

// The harness mocks scheduler/registry.ts for the dispatcher; load the REAL one by cache-bust.
// @ts-expect-error cache-bust query suffix is not a resolvable module specifier
const registry = await import('../src/scheduler/registry.ts?flag-off-real')
// @ts-expect-error cache-bust query suffix is not a resolvable module specifier
const catchup = await import('../src/scheduler/catchup.ts?flag-off-real')
const dispatcher = await import('../src/scheduler/dispatcher.ts')
// @ts-expect-error cache-bust query suffix is not a resolvable module specifier
const { seedTaskQcTasks } = await import('../src/task-qc/seed.ts?flag-off-real')

const DAY = 86_400_000
const cronFields = { cron_expr: '0 9 * * *', cron_expression: '0 9 * * *', catchup_policy: 'skip' }
const qcRow = () => qcTaskRow({ ...cronFields, last_fire_at: new Date(Date.now() - 3 * DAY).toISOString(), created_at: new Date(Date.now() - 9 * DAY).toISOString() })
const controlRow = () => controlTaskRow({ ...cronFields, last_fire_at: new Date(Date.now() - 3 * DAY).toISOString(), created_at: new Date(Date.now() - 9 * DAY).toISOString() })

beforeEach(() => {
  reset()
  delete process.env.REMO_TASK_QC_ENABLED
  h.tasks = { [QC_ID]: qcRow(), [CONTROL_ID]: controlRow() }
  h.enabledTasks = [h.tasks[QC_ID], h.tasks[CONTROL_ID]]
})
afterEach(() => {
  delete process.env.REMO_TASK_QC_ENABLED
  registry.unregister(QC_ID)
  registry.unregister(CONTROL_ID)
})
afterAll(() => mock.restore())

describe('flag OFF (unset): the left-behind task_qc row is inert', () => {
  test('registry loadAll arms nothing for it and stamps no fire timestamp, others armed as before', async () => {
    await registry.loadAll()
    expect(registry.get(QC_ID)).toBeUndefined()
    expect(h.timestampCalls).not.toContain(QC_ID)
    expect(registry.get(CONTROL_ID)).toBeDefined()
    expect(h.timestampCalls).toContain(CONTROL_ID)
  })

  test('registry register() leaves it unarmed', () => {
    registry.register(h.tasks[QC_ID])
    expect(registry.get(QC_ID)).toBeUndefined()
  })

  test('registry replace() after the owner sets enabled true still leaves it unarmed', async () => {
    h.tasks[QC_ID] = { ...h.tasks[QC_ID], enabled: true }
    await registry.replace(QC_ID)
    expect(registry.get(QC_ID)).toBeUndefined()
    expect(h.timestampCalls).not.toContain(QC_ID)
  })

  test('catchup skips it entirely (no consolidated skipped row, no runNow); the control still gets its skipped row', async () => {
    const r = await catchup.runOnce()
    const forQc = h.insertedRuns.filter((x) => x.task_id === QC_ID)
    expect(forQc).toHaveLength(0)
    expect(h.getTaskCalls).not.toContain(QC_ID)
    const forControl = h.insertedRuns.filter((x) => x.task_id === CONTROL_ID)
    expect(forControl).toHaveLength(1)
    expect(forControl[0].status).toBe('skipped')
    expect(r.skipped).toBeGreaterThan(0)
  })

  test('catchup run_once policy: still no runNow for it', async () => {
    h.tasks[QC_ID] = { ...h.tasks[QC_ID], catchup_policy: 'run_once' }
    h.enabledTasks = [h.tasks[QC_ID]]
    await catchup.runOnce()
    expect(h.getTaskCalls).not.toContain(QC_ID)
    expect(h.insertedRuns).toHaveLength(0)
    expect(h.claimed).toHaveLength(0)
  })

  test('the fire path inserts zero runs, reads no QC module, emails nothing - even with the kill switch engaged', async () => {
    h.halt = { halted: true, scope: 'global' }
    await dispatcher.fire(QC_ID)
    await dispatcher.runNow(QC_ID, USER, { isManual: true })
    await flush()
    expect(h.insertedRuns).toHaveLength(0)
    expect(h.claimed).toHaveLength(0)
    expect(h.finalized).toHaveLength(0)
    expect(h.emails).toHaveLength(0)
    expect(h.broadcasts).toHaveLength(0)
    expect(h.thresholdCalls + h.costCapCalls + h.resolveTargetsCalls).toBe(0)
    const qcStatements = h.fake.state.statements.filter((s) => /task_qc|taskqc/i.test(s.text) || /scheduled_tasks/i.test(s.text))
    expect(qcStatements).toHaveLength(0)
  })

  test('the seed performs zero database calls', async () => {
    const before = h.fake.state.statements.length
    const r = await seedTaskQcTasks()
    expect(r.seeded).toBe(0)
    expect(h.fake.state.statements.length).toBe(before)
  })

  test('nothing in the whole sequence sent an email', async () => {
    await registry.loadAll()
    await catchup.runOnce()
    await dispatcher.fire(QC_ID)
    await seedTaskQcTasks()
    await flush()
    expect(h.emails).toHaveLength(0)
  })
})

describe('flag ON: the same row is a normal citizen', () => {
  beforeEach(() => {
    process.env.REMO_TASK_QC_ENABLED = '1'
  })

  test('loadAll arms it', async () => {
    await registry.loadAll()
    expect(registry.get(QC_ID)).toBeDefined()
    expect(h.timestampCalls).toContain(QC_ID)
  })

  test('catchup applies its skip policy like any other task', async () => {
    await catchup.runOnce()
    const forQc = h.insertedRuns.filter((x) => x.task_id === QC_ID)
    expect(forQc).toHaveLength(1)
    expect(forQc[0].status).toBe('skipped')
  })

  test('a fire reaches the plan 03 branch (one claimed run)', async () => {
    await dispatcher.fire(QC_ID)
    await flush()
    expect(h.claimed).toHaveLength(1)
  })
})
