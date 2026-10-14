/**
 * PTYCAP-08-06 Task 1: the bounded, read-only audit read layer. DB-free: the
 * strict task-qc fake records every statement. The sender's app-uuid resolver
 * module is mocked (process-global; restored in afterAll) so the load layer is
 * exercised without the dispatcher import graph.
 */
import { describe, test, expect, beforeEach, afterAll, mock } from 'bun:test'
import { readFileSync } from 'node:fs'
import { createTaskQcFakeSql } from './fixtures/task-qc-fake-sql.ts'

const resolverCalls: string[] = []
let resolverImpl: (task: any, userId: string) => Promise<string | null> = async () => 'uuid-resolved'
mock.module('../src/scheduler/senders/coolify.ts', () => ({
  resolveAppUuid: async (task: any, userId: string) => {
    resolverCalls.push(task.id)
    return resolverImpl(task, userId)
  },
}))

const { loadAuditInputs, loadSiblingUuids, loadLiveSessionCandidates } = await import('../src/task-qc/load.ts')
const { TASK_QC_BOUNDS, clampBounds } = await import('../src/task-qc/flags.ts')
const { runDetectors } = await import('../src/task-qc/detectors.ts')

afterAll(() => mock.restore())

const USER = '00000000-0000-0000-0000-0000000000a1'
const NOW = new Date('2026-10-13T12:00:00.000Z')
const fake = createTaskQcFakeSql()

const taskRow = (over: Record<string, unknown> = {}) => ({
  id: 't1',
  user_id: USER,
  name: 'Nightly',
  task_type: 'dev',
  enabled: true,
  schedule_kind: 'cron',
  cron_expr: '0 3 * * *',
  cron_expression: '0 3 * * *',
  timezone: 'UTC',
  created_at: '2026-09-01T00:00:00.000Z',
  target_kind: 'session',
  target_id: 'sess-1',
  session_id: 'sess-1',
  payload: {},
  ...over,
})

let tasks: any[] = []
let runs: any[] = []
let sessions: any[] = []
let tzRows: any[] = []

beforeEach(() => {
  fake.reset()
  resolverCalls.length = 0
  resolverImpl = async () => 'uuid-resolved'
  tasks = [taskRow()]
  runs = []
  sessions = [{ id: 'sess-1', status: 'online', deleted_at: null, last_activity: null, created_at: null, repo_key: 'o/r' }]
  tzRows = [{ timezone: 'America/Los_Angeles' }]
  fake.onSelect(/FROM scheduled_tasks WHERE user_id/, () => tasks)
  fake.onSelect(/ROW_NUMBER/, () => runs)
  fake.onSelect(/FROM sessions WHERE user_id/, () => sessions)
  fake.onSelect(/FROM users/, () => tzRows)
})

const base = () => ({
  userId: USER,
  bounds: clampBounds(),
  now: NOW,
  clock: () => NOW.getTime(),
  deadline: NOW.getTime() + 60_000,
  runner: fake.sql,
})

const selects = (re: RegExp) => fake.state.statements.filter((s) => s.kind === 'select' && re.test(s.text))

describe('loadAuditInputs: audit set enforced in SQL', () => {
  test('the task statement carries every D-03 predicate and the user scope', async () => {
    await loadAuditInputs(base())
    const stmt = selects(/FROM scheduled_tasks WHERE user_id/)[0]!
    expect(stmt.text).toMatch(/user_id = \?/)
    expect(stmt.text).toContain('enabled = true')
    expect(stmt.text).toContain("task_type <> 'task_qc'")
    expect(stmt.text).toContain("task_type <> 'orchestrator'")
    expect(stmt.text).toMatch(/NOT starts_with\(name, '__internal_'\)/)
    expect(stmt.text).toContain("schedule_kind = 'cron'")
    expect(stmt.values[0]).toBe(USER)
    expect(stmt.values).toContain(TASK_QC_BOUNDS.maxAuditedTasks + 1)
  })

  test('an internal anchor a dishonest fake returns is still dropped by the detector-side predicate', async () => {
    tasks = [taskRow({ id: 'anchor', name: '__internal_anchor', cron_expr: 'not a cron', cron_expression: 'not a cron' })]
    const out = await loadAuditInputs(base())
    const findings = runDetectors(
      { tasks: out.tasks, runsByTask: out.runsByTask, sessionsById: out.sessionsById, now: NOW },
      { failStreak: 3 },
    )
    expect(findings).toHaveLength(0)
  })

  test('a foreign user row a dishonest fake returns is dropped in memory', async () => {
    tasks = [taskRow(), taskRow({ id: 'foreign', user_id: 'someone-else' })]
    const out = await loadAuditInputs(base())
    expect(out.tasks.map((t) => t.id)).toEqual(['t1'])
  })

  test('more than maxAuditedTasks audited tasks: exactly the cap is returned and truncated is true', async () => {
    const bounds = clampBounds({ maxAuditedTasks: 3 })
    tasks = [1, 2, 3, 4].map((n) => taskRow({ id: `t${n}` }))
    const out = await loadAuditInputs({ ...base(), bounds })
    expect(out.tasks.map((t) => t.id)).toEqual(['t1', 't2', 't3'])
    expect(out.truncated).toBe(true)
    const stmt = selects(/FROM scheduled_tasks WHERE user_id/)[0]!
    expect(stmt.values).toContain(4)
  })

  test('exactly the cap is not truncated', async () => {
    const bounds = clampBounds({ maxAuditedTasks: 2 })
    tasks = [1, 2].map((n) => taskRow({ id: `t${n}` }))
    const out = await loadAuditInputs({ ...base(), bounds })
    expect(out.tasks).toHaveLength(2)
    expect(out.truncated).toBe(false)
  })
})

describe('loadAuditInputs: scope narrows only', () => {
  test('taskIds becomes an id-in-list predicate AND user_id', async () => {
    await loadAuditInputs({ ...base(), scope: { taskIds: ['t1', 'foreign-id'] } })
    const stmt = selects(/FROM scheduled_tasks WHERE user_id/)[0]!
    expect(stmt.text).toMatch(/id = ANY\(\?::text\[\]\)/)
    expect(stmt.text).toMatch(/user_id = \?/)
    expect(stmt.values).toContainEqual(['t1', 'foreign-id'])
  })

  test('an empty taskIds list audits nothing and issues no task query', async () => {
    const out = await loadAuditInputs({ ...base(), scope: { taskIds: [] } })
    expect(out.tasks).toEqual([])
    expect(selects(/FROM scheduled_tasks/)).toHaveLength(0)
  })
})

describe('loadAuditInputs: history, sessions, timezone, resolver', () => {
  test('the history read is one windowed statement bounded by maxRunsPerTask', async () => {
    const bounds = clampBounds({ maxRunsPerTask: 7 })
    runs = [{ id: 'r1', task_id: 't1', status: 'failed', started_at: NOW }]
    const out = await loadAuditInputs({ ...base(), bounds })
    const hist = selects(/ROW_NUMBER/)
    expect(hist).toHaveLength(1)
    expect(hist[0]!.values).toContain(7)
    expect(hist[0]!.values).toContainEqual(['t1'])
    expect(out.runsByTask['t1']).toHaveLength(1)
  })

  test('the effective session row is loaded user-scoped; a missing row is null', async () => {
    tasks = [taskRow({ id: 'a', target_id: 'sess-1' }), taskRow({ id: 'b', target_id: 'gone', session_id: 'gone' })]
    const out = await loadAuditInputs(base())
    expect(out.sessionsById['sess-1']?.status).toBe('online')
    expect(out.sessionsById['gone']).toBeNull()
    expect(selects(/FROM sessions WHERE user_id/)[0]!.values[0]).toBe(USER)
  })

  test('the user timezone comes from users, UTC when absent', async () => {
    expect((await loadAuditInputs(base())).userTimezone).toBe('America/Los_Angeles')
    tzRows = []
    expect((await loadAuditInputs(base())).userTimezone).toBe('UTC')
  })

  test('resolvedAppUuid is computed by the sender resolver for log_check and log_pull only', async () => {
    tasks = [
      taskRow({ id: 'lc', task_type: 'log_check' }),
      taskRow({ id: 'lp', task_type: 'log_pull' }),
      taskRow({ id: 'dv', task_type: 'dev' }),
    ]
    resolverImpl = async (t) => (t.id === 'lc' ? 'uuid-1' : null)
    const out = await loadAuditInputs(base())
    const byId = Object.fromEntries(out.tasks.map((t) => [t.id, t]))
    expect(byId['lc']!.resolvedAppUuid).toBe('uuid-1')
    expect(byId['lp']!.resolvedAppUuid).toBeNull()
    expect(byId['dv']!.resolvedAppUuid).toBeUndefined()
    expect(resolverCalls.sort()).toEqual(['lc', 'lp'])
  })
})

describe('loadAuditInputs: read-only transaction, timeout, lock, deadline', () => {
  test('one read-only transaction that sets a local statement timeout and takes the per-user lock', async () => {
    await loadAuditInputs({ ...base(), lock: true })
    expect(fake.state.beginCalls).toBe(1)
    expect(fake.state.beginModes).toEqual(['read only'])
    expect(fake.state.setLocalCalls).toBe(1)
    const set = fake.state.statements.find((s) => s.kind === 'set_local')!
    expect(set.text).toMatch(/^SET LOCAL statement_timeout = \d+$/)
    expect(fake.state.lockCalls).toBe(1)
    const lock = fake.state.statements.find((s) => s.kind === 'lock')!
    expect(lock.values[0]).toBe(`taskqc:${USER}`)
    const order = fake.state.statements.map((s) => s.kind)
    expect(order.indexOf('lock')).toBeLessThan(order.indexOf('select'))
    expect(order.indexOf('set_local')).toBeLessThan(order.indexOf('select'))
  })

  test('the statement timeout is derived from the remaining wall-clock budget', async () => {
    await loadAuditInputs({ ...base(), deadline: NOW.getTime() + 4321 })
    const set = fake.state.statements.find((s) => s.kind === 'set_local')!
    expect(set.text).toBe('SET LOCAL statement_timeout = 4321')
  })

  test('without lock the advisory lock is not taken', async () => {
    await loadAuditInputs(base())
    expect(fake.state.lockCalls).toBe(0)
  })

  test('a passed deadline returns truncated with no tasks and issues no task query', async () => {
    const out = await loadAuditInputs({ ...base(), deadline: NOW.getTime() - 1 })
    expect(out.truncated).toBe(true)
    expect(out.tasks).toEqual([])
    expect(selects(/FROM scheduled_tasks/)).toHaveLength(0)
    expect(fake.state.statements).toHaveLength(0)
  })

  test('a deadline that passes after the task query stops cleanly with truncated true', async () => {
    // the clock jumps past the deadline as soon as the task statement has been issued
    const clock = () => (selects(/FROM scheduled_tasks WHERE user_id/).length > 0 ? NOW.getTime() + 120_000 : NOW.getTime())
    const out = await loadAuditInputs({ ...base(), clock })
    expect(out.truncated).toBe(true)
    expect(out.tasks).toEqual([])
    expect(selects(/ROW_NUMBER/)).toHaveLength(0)
  })

  test('no load issues a write statement', async () => {
    tasks = [taskRow({ id: 'lc', task_type: 'log_check' })]
    fake.onSelect(/FROM scheduled_tasks t/, [])
    await loadAuditInputs({ ...base(), lock: true })
    await loadSiblingUuids(fake.sql, USER, taskRow({ id: 'lc' }) as any)
    await loadLiveSessionCandidates(fake.sql, USER, { id: 'd', repo_key: 'o/r' })
    expect(fake.state.writes()).toHaveLength(0)
    fake.assertNoUnknown()
  })
})

describe('candidate loaders', () => {
  test('loadSiblingUuids returns distinct non-empty uuids, user-scoped, excluding the task itself', async () => {
    fake.onSelect(/FROM scheduled_tasks t/, [
      { application_uuid: 'u1' },
      { application_uuid: 'u1' },
      { application_uuid: '' },
      { application_uuid: null },
      { application_uuid: ' u2 ' },
    ])
    const got = await loadSiblingUuids(fake.sql, USER, taskRow({ id: 'self', task_type: 'log_check' }) as any)
    expect(got.sort()).toEqual(['u1', 'u2'])
    const stmt = selects(/FROM scheduled_tasks t/)[0]!
    expect(stmt.text).toMatch(/t\.user_id = \?/)
    expect(stmt.text).toMatch(/t\.id <> \?/)
    expect(stmt.text).toContain("t.task_type IN ('log_check', 'log_pull')")
    expect(stmt.text).toContain('t.enabled = true')
    expect(stmt.values).toContain('self')
    expect(stmt.values).toContain(USER)
  })

  test('loadSiblingUuids with no effective session returns [] without querying', async () => {
    const got = await loadSiblingUuids(fake.sql, USER, taskRow({ target_id: null, session_id: null }) as any)
    expect(got).toEqual([])
    expect(fake.state.statements).toHaveLength(0)
  })

  test('loadLiveSessionCandidates returns same-repo live, non-deleted sessions', async () => {
    sessions = [{ id: 'live-1' }]
    const got = await loadLiveSessionCandidates(fake.sql, USER, { id: 'dead', repo_key: 'o/r' })
    expect(got).toEqual(['live-1'])
    const stmt = selects(/FROM sessions WHERE user_id/)[0]!
    expect(stmt.text).toContain('deleted_at IS NULL')
    expect(stmt.text).toContain("status IN ('online', 'thinking')")
    expect(stmt.text).toMatch(/id <> \?/)
    expect(stmt.values).toEqual([USER, 'o/r', 'dead', expect.any(Number)])
  })

  test('a dead session with NULL repo_key returns [] without querying', async () => {
    expect(await loadLiveSessionCandidates(fake.sql, USER, { id: 'dead', repo_key: null })).toEqual([])
    expect(await loadLiveSessionCandidates(fake.sql, USER, null)).toEqual([])
    expect(fake.state.statements).toHaveLength(0)
  })
})

describe('resolveAppUuid export', () => {
  test('the sender exports its own resolver (not re-implemented here)', () => {
    const src = readFileSync(new URL('../src/scheduler/senders/coolify.ts', import.meta.url), 'utf8')
    expect(src).toContain('export async function resolveAppUuid(')
    const load = readFileSync(new URL('../src/task-qc/load.ts', import.meta.url), 'utf8')
    expect(load).toMatch(/import\('\.\.\/scheduler\/senders\/coolify\.ts'\)/)
  })
})
