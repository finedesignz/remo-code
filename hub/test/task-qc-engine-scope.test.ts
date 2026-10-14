/**
 * PTYCAP-08-06 Task 3 (F1-A4): runTaskQcPass(scope) is the seam Phase 9 reuses,
 * so its scope can only NARROW. Hostile scope objects, foreign task ids and
 * widening keys must have no effect. DB-free over the strict fake.
 */
import { describe, test, expect, beforeEach, afterAll, mock } from 'bun:test'
import { makeEngineWorld, mk, okRun, failRuns, haltOk, baseDeps, USER } from './fixtures/task-qc-engine-fixture.ts'

const { world, reset } = makeEngineWorld()
const fake = world.fake
mock.module('../src/db/postgres.ts', () => ({ sql: fake.sql }))
afterAll(() => mock.restore())

const { runTaskQcPass } = await import('../src/task-qc/engine.ts')
const { SAFE_FIXES } = await import('../src/task-qc/safe-fixes.ts')

beforeEach(reset)

const run = (scope?: any, origin: 'schedule' | 'run_now' = 'run_now', over: Record<string, unknown> = {}) =>
  runTaskQcPass({ userId: USER, origin, scope, deps: baseDeps(fake, over) as any }).then(({ recordedIds: _ids, ...rest }) => rest) // row ids come from the fake's counter

function seed() {
  world.store['own1'] = mk('own1')
  world.store['own2'] = mk('own2')
  world.store['badtz'] = mk('badtz', { timezone: 'Mars/Phobos' })
  world.runs.push(...failRuns('own1', 3), ...failRuns('own2', 3), okRun('badtz'))
}
const ids = (r: Awaited<ReturnType<typeof run>>) => [...new Set(r.findings.map((f) => f.taskId))].sort()

describe('scope narrows only', () => {
  test('taskIds intersect the user\'s own audited set: a foreign id is never read', async () => {
    seed()
    // a dishonest store that leaks a foreign user's row anyway
    world.store['foreign'] = mk('foreign', { user_id: 'another-user' })
    world.runs.push(...failRuns('foreign', 5))
    const res = await run({ taskIds: ['own1', 'foreign'] })
    expect(ids(res)).toEqual(['own1'])
    // every statement that touches a user-owned table is bound to this user
    const owned = fake.state.statements.filter((s) => /FROM (scheduled_tasks|scheduled_task_runs|sessions|users)\b/.test(s.text))
    expect(owned.length).toBeGreaterThan(0)
    for (const s of owned) expect(s.values).toContain(USER)
    // the id list reaches SQL as an id-in-list predicate next to user_id
    const tasks = fake.state.statements.find((s) => /FROM scheduled_tasks WHERE user_id/.test(s.text))!
    expect(tasks.text).toMatch(/user_id = \?/)
    expect(tasks.text).toMatch(/id = ANY\(\?::text\[\]\)/)
    expect(tasks.values).toContainEqual(['own1', 'foreign'])
    // the foreign task's history is never requested
    const hist = fake.state.statements.find((s) => /ROW_NUMBER/.test(s.text))!
    expect(JSON.stringify(hist.values)).not.toContain('foreign')
  })

  test('an empty taskIds list audits nothing and reads nothing', async () => {
    seed()
    const res = await run({ taskIds: [] })
    expect(res).toEqual({ findings: [], applied: [], proposals: [], truncated: false })
    expect(fake.state.statements).toHaveLength(0)
  })

  test('non-string task ids are ignored', async () => {
    seed()
    const res = await run({ taskIds: ['own1', 7, null, { id: 'own2' }] })
    expect(ids(res)).toEqual(['own1'])
  })

  test('detectors restrict the finding set to the named detectors', async () => {
    seed()
    const all = await run()
    expect(new Set(all.findings.map((f) => f.detector))).toEqual(new Set(['FAILING', 'NEVER_FIRED']))
    fake.state.statements.length = 0
    const only = await run({ detectors: ['NEVER_FIRED'] })
    expect(new Set(only.findings.map((f) => f.detector))).toEqual(new Set(['NEVER_FIRED']))
  })

  test('an unknown detector name is ignored and never widens; only unknown names audit nothing', async () => {
    seed()
    const res = await run({ detectors: ['FAILING', 'EVERYTHING', '*'] })
    expect(new Set(res.findings.map((f) => f.detector))).toEqual(new Set(['FAILING']))
    fake.state.statements.length = 0
    const none = await run({ detectors: ['EVERYTHING'] })
    expect(none.findings).toEqual([])
    expect(fake.state.statements).toHaveLength(0)
  })

  test('extra or widening keys have no effect and SAFE_FIXES is unchanged', async () => {
    seed()
    const baseline = await run()
    const hostile = {
      allowlist: ['*'],
      fixKinds: ['disable_task', 'normalize_timezone'],
      disableGuards: true,
      bounds: { maxAuditedTasks: 99999, maxAutoFixesPerPass: 99999 },
      includeInternal: true,
      userId: 'someone-else',
      autofix: true,
    }
    const res = await run(hostile)
    expect(JSON.stringify(res)).toBe(JSON.stringify(baseline))
    expect(fake.state.updatesTo('scheduled_tasks')).toHaveLength(0)
    expect([...SAFE_FIXES.values()].sort()).toEqual(['backfill_payload_from_sibling', 'normalize_timezone', 'rebind_dead_session'])
    expect(SAFE_FIXES.size).toBe(3)
    // statements were issued for the caller's own user, not the hostile one
    expect(fake.state.statements.every((s) => !s.values.includes('someone-else'))).toBe(true)
  })

  test('hostile scope under auto-fix still cannot reach beyond the allowlist or other users', async () => {
    seed()
    const res = await run({ fixKinds: ['disable_task'], allowlist: ['badtz'] }, 'run_now', { autofix: true, haltCheck: haltOk })
    expect(res.applied.map((a) => a.fix)).toEqual(['normalize_timezone'])
    const upd = fake.state.updatesTo('scheduled_tasks')
    expect(upd).toHaveLength(1)
    expect(upd[0]!.text).not.toMatch(/\benabled\b/)
  })

  test('omitting scope audits the full set', async () => {
    seed()
    expect(ids(await run())).toEqual(['badtz', 'own1', 'own2'])
  })

  test('origin run_now and schedule behave identically for the same inputs', async () => {
    seed()
    const a = await run(undefined, 'run_now')
    const b = await run(undefined, 'schedule')
    expect(JSON.stringify(b)).toBe(JSON.stringify(a))
  })
})
