/**
 * PTYCAP-08-06 Task 2: the full engine pass over the strict recording fake.
 * Report-only default, auto-fix through the allowlisted writer, never disable,
 * halt re-check and idempotency. No database: responders model just enough of
 * the read layer and the writer's statements.
 */
import { describe, test, expect, beforeEach, afterEach, afterAll, mock } from 'bun:test'
import { createTaskQcFakeSql } from './fixtures/task-qc-fake-sql.ts'

const fake = createTaskQcFakeSql()
mock.module('../src/db/postgres.ts', () => ({ sql: fake.sql }))
afterAll(() => mock.restore())

const { runTaskQcPass } = await import('../src/task-qc/engine.ts')

const USER = '00000000-0000-0000-0000-0000000000a1'
const NOW = new Date('2026-10-13T12:00:00.000Z')
const fresh = () => ({
  last_fire_at: new Date(NOW.getTime() - 3_600_000).toISOString(),
  next_fire_at: new Date(NOW.getTime() + 3_600_000).toISOString(),
})
const mk = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  user_id: USER,
  name: `Task ${id}`,
  task_type: 'dev',
  enabled: true,
  schedule_kind: 'cron',
  cron_expr: '0 3 * * *',
  cron_expression: '0 3 * * *',
  timezone: 'UTC',
  created_at: '2026-09-01T00:00:00.000Z',
  target_kind: 'session',
  target_id: 'live-1',
  session_id: 'live-1',
  prompt: `prompt-${id}`,
  payload: {},
  teab_repo_ident: null,
  ...fresh(),
  ...over,
})
const okRun = (taskId: string) => ({ id: `ok-${taskId}`, task_id: taskId, status: 'success', error: null, started_at: new Date(NOW.getTime() - 3_600_000).toISOString() })
const failRuns = (taskId: string, n: number) =>
  Array.from({ length: n }, (_, i) => ({
    id: `f${i}`,
    task_id: taskId,
    status: 'failed',
    error: 'boom',
    started_at: new Date(NOW.getTime() - (i + 1) * 3_600_000).toISOString(),
  }))

let store: Record<string, any>
let runs: any[]
let sessions: any[]
let siblings: any[]
let live: any[]
let openRuns: Set<string>
let findingConflict: boolean

const flagEnv = ['REMO_TASK_QC_ENABLED', 'REMO_TASK_QC_AUTOFIX']
beforeEach(() => {
  fake.reset()
  for (const k of flagEnv) delete process.env[k]
  store = {}
  runs = []
  sessions = [{ id: 'live-1', status: 'online', deleted_at: null, last_activity: null, created_at: null, repo_key: 'o/r' }]
  siblings = []
  live = []
  openRuns = new Set()
  findingConflict = false

  fake.onSelect(/FROM scheduled_tasks WHERE user_id/, () => Object.values(store))
  fake.onSelect(/ROW_NUMBER/, () => runs)
  fake.onSelect(/FROM sessions WHERE user_id = \? AND id = ANY/, () => sessions)
  fake.onSelect(/FROM sessions WHERE user_id = \? AND repo_key/, () => live)
  fake.onSelect(/FROM users/, () => [{ timezone: 'America/Los_Angeles' }])
  fake.onSelect(/FROM scheduled_tasks t/, () => siblings)
  // writer
  fake.onSelect(/FROM scheduled_tasks WHERE id = \? AND user_id = \? FOR NO KEY UPDATE/, (v) => (store[v[0]] ? [store[v[0]]] : []))
  fake.onSelect(/FROM scheduled_task_runs WHERE task_id = \? AND status IN/, (v) => (openRuns.has(v[0]) ? [{ open: 1 }] : []))
  fake.onSelect(/FROM scheduled_task_runs WHERE session_id = \? AND status IN/, () => [])
  fake.on(/^UPDATE scheduled_tasks SET timezone/, (v) => [{ timezone: v[0] }])
  fake.on(/^UPDATE scheduled_tasks SET payload/, (v) => [{ payload: { application_uuid: v[0] } }])
  fake.on(/^UPDATE scheduled_tasks SET session_id/, (v) => [{ session_id: v[1], target_id: v[3] }])
  fake.onInsert(/INSERT INTO task_qc_findings/, () => (findingConflict ? [] : [{ id: `f-${fake.state.writes().length}` }]))
})
afterEach(() => {
  for (const k of flagEnv) delete process.env[k]
})

const haltOk = async () => ({ halted: false })
const deps = (over: Record<string, unknown> = {}) => ({
  now: NOW,
  q: fake.sql,
  clock: () => NOW.getTime(),
  resolveAppUuid: async () => null,
  ...over,
})
const run = (over: Record<string, unknown> = {}, scope?: any) => runTaskQcPass({ userId: USER, origin: 'run_now', scope, deps: deps(over) as any })
const taskUpdates = () => fake.state.updatesTo('scheduled_tasks')
const findingInserts = () => fake.state.statements.filter((s) => s.kind === 'insert' && /task_qc_findings/.test(s.text))

/** one task per fixable shape plus a failing and a never-fired task */
function seedBroken() {
  store = {
    badtz: mk('badtz', { timezone: 'Mars/Phobos' }),
    logs: mk('logs', { task_type: 'log_check' }),
    dead: mk('dead', { target_id: 'dead-sess', session_id: 'dead-sess' }),
    failing: mk('failing'),
    never: mk('never', { next_fire_at: null, last_fire_at: null }),
  }
  sessions.push({ id: 'dead-sess', status: 'online', deleted_at: '2026-10-01T00:00:00.000Z', last_activity: null, created_at: null, repo_key: 'o/r' })
  runs = [okRun('badtz'), okRun('logs'), okRun('dead'), ...failRuns('failing', 3), okRun('never')]
}
const byTask = (arr: any[], id: string) => arr.filter((f) => f.taskId === id)

describe('report-only (the default)', () => {
  test('a full pass over broken tasks issues zero UPDATE scheduled_tasks; would-be fixes are proposals', async () => {
    seedBroken()
    siblings = [{ application_uuid: 'sib-1' }]
    live = [{ id: 'live-1' }]
    const res = await run()
    expect(taskUpdates()).toHaveLength(0)
    expect(res.applied).toEqual([])
    for (const [id, would] of [
      ['badtz', 'normalize_timezone'],
      ['logs', 'backfill_payload_from_sibling'],
      ['dead', 'rebind_dead_session'],
    ] as const) {
      const f = byTask(res.proposals, id)[0]
      expect(f, id).toBeDefined()
      expect(f!.evidence.would_fix).toBe(would)
    }
    expect(byTask(res.proposals, 'failing')[0]!.proposal.kind).toBe('propose_disable')
    expect(res.proposals.length).toBe(res.findings.length)
    // each finding persisted once, as proposed
    expect(findingInserts()).toHaveLength(res.findings.length)
    for (const s of findingInserts()) expect(s.values).toContain('proposed')
    // the candidate loaders were not needed
    expect(fake.state.statements.filter((s) => /FROM scheduled_tasks t\b/.test(s.text))).toHaveLength(0)
    fake.assertNoUnknown()
  })

  test('AUTOFIX env without ENABLED is inert: no halt check required, still report-only', async () => {
    process.env.REMO_TASK_QC_AUTOFIX = '1'
    seedBroken()
    const res = await run()
    expect(taskUpdates()).toHaveLength(0)
    expect(res.applied).toEqual([])
  })

  test('a task_qc row and an orchestrator row are never audited or fixed', async () => {
    store = {
      qc: mk('qc', { task_type: 'task_qc', timezone: 'Mars/Phobos' }),
      orch: mk('orch', { task_type: 'orchestrator', timezone: 'Mars/Phobos' }),
      anchor: mk('anchor', { name: '__internal_anchor', timezone: 'Mars/Phobos' }),
    }
    const res = await run({ autofix: true, haltCheck: haltOk })
    expect(res.findings).toHaveLength(0)
    expect(fake.state.writes()).toHaveLength(0)
  })
})

describe('auto-fix on', () => {
  test('the three fixable fixtures are applied through the writer and not duplicated as proposals', async () => {
    seedBroken()
    siblings = [{ application_uuid: 'sib-1' }]
    live = [{ id: 'live-1' }]
    const res = await run({ autofix: true, haltCheck: haltOk })
    expect(res.applied.map((a) => [a.taskId, a.fix]).sort()).toEqual([
      ['badtz', 'normalize_timezone'],
      ['dead', 'rebind_dead_session'],
      ['logs', 'backfill_payload_from_sibling'],
    ])
    for (const a of res.applied) {
      expect(a.before).toBeDefined()
      expect(a.after).toBeDefined()
      expect(a.rollbackSql).toMatch(/^UPDATE scheduled_tasks SET /)
    }
    const fixedIds = new Set(res.applied.map((a) => a.taskId))
    expect(res.proposals.some((p) => fixedIds.has(p.taskId))).toBe(false)
    expect(res.proposals.map((p) => p.detector)).toContain('FAILING')
    expect(taskUpdates()).toHaveLength(3)
    // the timezone fix targets the owner's profile timezone
    expect(taskUpdates().find((u) => /SET timezone/.test(u.text))!.values[0]).toBe('America/Los_Angeles')
    expect(fake.state.statements.filter((s) => s.kind === 'insert' && s.values.includes('auto_fixed'))).toHaveLength(3)
    // the detection read takes the per-user lock when writes can follow, and each of the 3 fixes the per-session lock
    expect(fake.state.statements.filter((s) => s.kind === 'lock' && s.values[0] === `taskqc:${USER}`)).toHaveLength(1)
    expect(fake.state.lockCalls).toBe(4)
    fake.assertNoUnknown()
  })

  test('ambiguous or empty candidates stay proposals with zero writes', async () => {
    seedBroken()
    delete store.badtz
    siblings = [{ application_uuid: 'sib-1' }, { application_uuid: 'sib-2' }]
    live = [{ id: 'live-1' }, { id: 'live-2' }]
    const res = await run({ autofix: true, haltCheck: haltOk })
    expect(res.applied).toEqual([])
    expect(taskUpdates()).toHaveLength(0)
    expect(byTask(res.proposals, 'logs')[0]!.proposal.params.candidates).toBe(2)
    expect(byTask(res.proposals, 'dead')[0]!.proposal.params.candidates).toBe(2)
  })

  test('zero candidates stay proposals with zero writes', async () => {
    seedBroken()
    delete store.badtz
    siblings = []
    live = []
    const res = await run({ autofix: true, haltCheck: haltOk })
    expect(res.applied).toEqual([])
    expect(taskUpdates()).toHaveLength(0)
    expect(byTask(res.proposals, 'logs')).toHaveLength(1)
    expect(byTask(res.proposals, 'dead')).toHaveLength(1)
  })

  test('a fixable task with an open run is skipped_in_flight; the others still apply', async () => {
    seedBroken()
    siblings = [{ application_uuid: 'sib-1' }]
    live = [{ id: 'live-1' }]
    openRuns.add('logs')
    const res = await run({ autofix: true, haltCheck: haltOk })
    expect(res.applied.map((a) => a.taskId).sort()).toEqual(['badtz', 'dead'])
    const inflight = byTask(res.proposals, 'logs')[0]!
    expect(inflight.proposal.params.reason).toBe('in_flight')
    expect(taskUpdates().some((u) => /SET payload/.test(u.text))).toBe(false)
    expect(fake.state.statements.some((s) => s.kind === 'insert' && s.values.includes('skipped_in_flight'))).toBe(true)
  })
})

describe('never disables', () => {
  test('500 consecutive failures: high severity, propose_disable, zero UPDATE, task still enabled', async () => {
    store = { hot: mk('hot') }
    runs = failRuns('hot', 500)
    const res = await run({ autofix: true, haltCheck: haltOk })
    const f = res.findings.find((x) => x.detector === 'FAILING')!
    expect(f.severity).toBe('high')
    expect(f.proposal.kind).toBe('propose_disable')
    expect(res.proposals).toHaveLength(1)
    expect(taskUpdates()).toHaveLength(0)
    expect(store.hot.enabled).toBe(true)
    expect(fake.state.statements.some((s) => /\benabled\s*=/.test(s.text) && s.kind === 'update')).toBe(false)
    expect(findingInserts()[0]!.values).toContain('proposed')
  })
})

describe('halt re-check (D-21)', () => {
  test('halted before the first write: zero writes, every finding reported as halted_read_only', async () => {
    seedBroken()
    siblings = [{ application_uuid: 'sib-1' }]
    live = [{ id: 'live-1' }]
    let writesAtCheck = -1
    let calls = 0
    const res = await run({
      autofix: true,
      haltCheck: async () => {
        calls++
        writesAtCheck = fake.state.writes().length
        return { halted: true }
      },
    })
    expect(calls).toBe(1)
    expect(writesAtCheck).toBe(0)
    expect(fake.state.writes()).toHaveLength(0)
    expect(res.applied).toEqual([])
    expect(res.proposals).toHaveLength(res.findings.length)
    for (const p of res.proposals) expect(p.proposal.params.reason).toBe('halted_read_only')
    expect(res.truncated).toBe(false)
  })

  test('AUTOFIX on without a halt check throws before any statement', async () => {
    seedBroken()
    await expect(run({ autofix: true })).rejects.toThrow('halt_check_required')
    process.env.REMO_TASK_QC_ENABLED = '1'
    process.env.REMO_TASK_QC_AUTOFIX = '1'
    await expect(runTaskQcPass({ userId: USER, origin: 'schedule', deps: { now: NOW, q: fake.sql } as any })).rejects.toThrow('halt_check_required')
    expect(fake.state.statements).toHaveLength(0)
  })

  test('report-only with a halt check consults it before the first write too', async () => {
    seedBroken()
    let calls = 0
    const res = await run({ haltCheck: async () => (calls++, { halted: true }) })
    expect(calls).toBe(1)
    expect(fake.state.writes()).toHaveLength(0)
    expect(res.proposals.length).toBe(res.findings.length)
  })
})

describe('result shape and idempotency', () => {
  test('applied plus proposals covers every finding on a first run', async () => {
    seedBroken()
    siblings = [{ application_uuid: 'sib-1' }]
    live = [{ id: 'live-1' }]
    const res = await run({ autofix: true, haltCheck: haltOk })
    expect(res.applied.length + res.proposals.length).toBe(res.findings.length)
    expect(Object.keys(res).sort()).toEqual(['applied', 'findings', 'proposals', 'truncated'])
  })

  test('a re-run inserts each proposed row once: the conflict is not re-listed as a new proposal, findings still list all', async () => {
    seedBroken()
    const first = await run()
    expect(first.proposals).toHaveLength(first.findings.length)
    findingConflict = true // ON CONFLICT DO NOTHING on the second run
    const second = await run()
    expect(second.findings).toHaveLength(first.findings.length)
    expect(findingInserts()).toHaveLength(first.findings.length * 2) // attempted both times, stored once
    expect(second.proposals).toHaveLength(0)
  })

  test('scope narrows: unknown detector names never widen', async () => {
    seedBroken()
    const res = await run({}, { detectors: ['FAILING', 'NOT_A_DETECTOR'] })
    expect(new Set(res.findings.map((f) => f.detector))).toEqual(new Set(['FAILING']))
  })
})
