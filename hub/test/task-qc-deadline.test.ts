/**
 * PTYCAP-08 QC round 1 (codex MAJOR 2): the pass wall-clock bound is HARD. Every
 * QC transaction arms the time left as its statement_timeout BEFORE any lock wait,
 * the database cancelling a statement (57014 / 55P03) is the deadline passing, and
 * a non-database await (the app-uuid resolver) is raced against the deadline.
 * DB-free over the strict fake.
 */
import { describe, test, expect, beforeEach, afterAll, mock } from 'bun:test'
import { makeEngineWorld, mk, okRun, failRuns, haltOk, baseDeps, USER, NOW } from './fixtures/task-qc-engine-fixture.ts'

const { world, reset } = makeEngineWorld()
const fake = world.fake
mock.module('../src/db/postgres.ts', () => ({ sql: fake.sql }))
afterAll(() => mock.restore())

const { runTaskQcPass } = await import('../src/task-qc/engine.ts')

beforeEach(reset)

const run = (over: Record<string, unknown> = {}) =>
  runTaskQcPass({ userId: USER, origin: 'schedule', deps: baseDeps(fake, over) as any })
const cancelled = () => Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' })

describe('hard wall-clock bound (F1-A3)', () => {
  test('the read transaction arms the statement timeout BEFORE the advisory lock and before every statement', async () => {
    world.store['a'] = mk('a')
    await run({ autofix: true, haltCheck: haltOk })
    const readTx = fake.state.statements.filter((s) => s.tx === 1)
    expect(readTx[0]!.kind).toBe('set_local')
    const lockAt = readTx.findIndex((s) => s.kind === 'lock')
    expect(lockAt).toBeGreaterThan(0)
    readTx.forEach((s, i) => {
      if (s.kind !== 'set_local') expect(readTx[i - 1]!.kind).toBe('set_local')
    })
  })

  test('a fix transaction arms the statement timeout first, before the row lock', async () => {
    world.store['tz'] = mk('tz', { timezone: 'Mars/Phobos' })
    world.runs.push(okRun('tz'))
    const res = await run({ autofix: true, haltCheck: haltOk })
    expect(res.applied).toHaveLength(1)
    const fixTx = fake.state.statements.filter((s) => s.tx === 2)
    expect(fixTx[0]!.kind).toBe('set_local')
    expect(fixTx[1]!.forUpdate).toBe(true)
  })

  test('the database cancelling a fix statement ends the pass truncated: no throw, finding left as an unpersisted deadline proposal', async () => {
    world.store['tz'] = mk('tz', { timezone: 'Mars/Phobos' })
    world.runs.push(okRun('tz'))
    fake.failOn(/^UPDATE scheduled_tasks SET timezone/, cancelled())
    const res = await run({ autofix: true, haltCheck: haltOk })
    expect(res.truncated).toBe(true)
    expect(res.applied).toHaveLength(0)
    const p = res.proposals.find((x) => x.proposal.params.reason === 'deadline')!
    expect(p.proposal.params.persisted).toBe(false)
  })

  test('the database cancelling a proposal insert ends that write truncated, not as a crash', async () => {
    world.store['f'] = mk('f')
    world.runs.push(...failRuns('f', 3))
    fake.failOn(/INSERT INTO task_qc_findings/, Object.assign(new Error('lock timeout'), { code: '55P03' }))
    const res = await run()
    expect(res.truncated).toBe(true)
    expect(res.findings).toHaveLength(1)
    expect(res.proposals.map((p) => p.proposal.params.reason)).toEqual(['deadline'])
  })

  test('a lookup transaction cancelled at the deadline becomes a deadline step', async () => {
    world.store['lg'] = mk('lg', { task_type: 'log_check', payload: {} })
    world.runs.push(okRun('lg'))
    fake.failOn(/FROM scheduled_tasks t/, cancelled())
    const res = await run({ autofix: true, haltCheck: haltOk })
    expect(res.truncated).toBe(true)
    expect(res.applied).toHaveLength(0)
  })

  test('an ordinary database error is NOT swallowed as a deadline', async () => {
    world.store['f'] = mk('f')
    world.runs.push(...failRuns('f', 3))
    fake.failOn(/INSERT INTO task_qc_findings/, new Error('boom'))
    await expect(run()).rejects.toThrow('boom')
  })

  test('a resolver that never answers cannot hold the pass past its deadline', async () => {
    world.store['lg'] = mk('lg', { task_type: 'log_check' })
    world.runs.push(okRun('lg'))
    const started = Date.now()
    const res = await runTaskQcPass({
      userId: USER,
      origin: 'schedule',
      deps: {
        now: NOW,
        q: fake.sql,
        bounds: { passTimeoutMs: 80 },
        resolveAppUuid: () => new Promise<string | null>(() => {}),
      } as any,
    })
    expect(Date.now() - started).toBeLessThan(3000)
    expect(res.truncated).toBe(true)
    expect(res.findings).toHaveLength(0)
  })
})
