/**
 * PTYCAP-08 plan 04, TQC-06: the writer never writes a task that has an open run
 * of its own or shares its session with another task that has one. Open means
 * status running/pending/in_flight with finished_at AND completed_at both null,
 * read from the database (the in-memory in-flight map is never consulted).
 * DB-free: real overlapping-writer serialisation is proven in plan 09.
 */
import { afterAll, describe, expect, mock, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createTaskQcFakeSql } from './fixtures/task-qc-fake-sql.ts'

afterAll(() => {
  mock.restore()
})

const { applyFix } = (await import(`../src/task-qc/safe-fixes.ts?inflight=${Date.now()}`)) as typeof import('../src/task-qc/safe-fixes.ts')

const FINDING: any = {
  detector: 'NEVER_FIRED',
  taskId: 't1',
  taskName: 'n',
  taskType: 'dev',
  severity: 'warn',
  evidence: { reasons: ['timezone_invalid'] },
  proposal: { kind: 'fix_timezone', params: { taskId: 't1' } },
  fixCandidate: 'normalize_timezone',
}
const CTX: any = { userId: 'u1', taskId: 't1', day: '2026-10-13', finding: FINDING }
const ROW = {
  id: 't1',
  user_id: 'u1',
  name: 'n',
  task_type: 'dev',
  enabled: true,
  schedule_kind: 'cron',
  timezone: 'Mars/Base',
  payload: {},
  session_id: 's1',
  target_kind: 'session',
  target_id: 's1',
}

function setup(opts: { own?: boolean; shared?: boolean; row?: any }) {
  const fake = createTaskQcFakeSql()
  fake.on(/FROM scheduled_tasks WHERE id/, [opts.row ?? ROW])
  fake.on(/FROM sessions WHERE id = \? FOR UPDATE/, [{ id: 's1' }])
  fake.on(/FROM scheduled_task_runs WHERE task_id/, opts.own ? [{ open: 1 }] : [])
  fake.on(/FROM scheduled_task_runs WHERE session_id/, opts.shared ? [{ open: 1 }] : [])
  fake.on(/UPDATE scheduled_tasks SET timezone/, [{ timezone: 'UTC' }])
  fake.on('INSERT INTO task_qc_findings', [{ id: 'f1' }])
  return fake
}

describe('in-flight refusal (TQC-06)', () => {
  test('an open run of the task itself: zero UPDATEs, a skipped_in_flight finding, an in_flight proposal', async () => {
    const fake = setup({ own: true })
    const r: any = await applyFix(fake.sql, { kind: 'normalize_timezone', timezone: 'UTC' }, CTX)
    expect(r.status).toBe('skipped_in_flight')
    expect(r.proposal).toEqual({ reason: 'in_flight', kind: 'fix_timezone', params: { taskId: 't1' } })
    expect(fake.state.updatesTo('scheduled_tasks').length).toBe(0)
    const inserts = fake.state.statements.filter((s) => s.kind === 'insert')
    expect(inserts.length).toBe(1)
    expect(inserts[0]!.values).toContain('skipped_in_flight')
    expect(inserts[0]!.values.some((v) => typeof v === 'string' && v.includes('"in_flight":"own_run"'))).toBe(true)
    expect(fake.state.beginCalls).toBe(1)
  })

  test('another task live on the same session: zero UPDATEs and a shared_session finding', async () => {
    const fake = setup({ shared: true })
    const r: any = await applyFix(fake.sql, { kind: 'normalize_timezone', timezone: 'UTC' }, CTX)
    expect(r.status).toBe('skipped_in_flight')
    expect(fake.state.updatesTo('scheduled_tasks').length).toBe(0)
    const ins = fake.state.statements.find((s) => s.kind === 'insert')!
    expect(ins.values.some((v) => typeof v === 'string' && v.includes('"in_flight":"shared_session"'))).toBe(true)
    // the shared-session probe is scoped by the task's effective session
    const probe = fake.state.statements.find((s) => /WHERE session_id/.test(s.text))!
    expect(probe.values).toEqual(['s1'])
  })

  test('round 2: no advisory lock and no trigger; the task row (FOR UPDATE) then the session row (FOR UPDATE) are locked before the probes and the write', async () => {
    const fake = setup({})
    await applyFix(fake.sql, { kind: 'normalize_timezone', timezone: 'UTC' }, CTX)
    const st = fake.state.statements
    expect(fake.state.lockCalls).toBe(0)
    const taskLock = st.findIndex((x) => /FROM scheduled_tasks WHERE id/.test(x.text))
    // FOR UPDATE, not FOR NO KEY UPDATE: only FOR UPDATE conflicts with the FOR KEY SHARE a run insert's FK check takes
    expect(st[taskLock]!.text).toMatch(/FOR UPDATE$/)
    expect(st[taskLock]!.text).not.toMatch(/NO KEY/)
    const sessLock = st.findIndex((x) => /FROM sessions WHERE id = \? FOR UPDATE/.test(x.text))
    expect(sessLock).toBeGreaterThan(taskLock)
    expect(st[sessLock]!.values).toEqual(['s1'])
    expect(sessLock).toBeLessThan(st.findIndex((x) => /FROM scheduled_task_runs/.test(x.text)))
    expect(sessLock).toBeLessThan(st.findIndex((x) => x.kind === 'update'))
    // one transaction: row locks are held until commit, so check and write share them
    expect(st.every((x) => x.tx === 1)).toBe(true)
  })

  test('round 2 (codex new MAJOR 2): a null-session task is serialised against its own run inserts by the task row FOR UPDATE alone', async () => {
    const fake = setup({ row: { ...ROW, session_id: null, target_id: null, target_kind: 'agent' } })
    await applyFix(fake.sql, { kind: 'normalize_timezone', timezone: 'UTC' }, CTX)
    const st = fake.state.statements
    const taskLock = st.findIndex((x) => /FROM scheduled_tasks WHERE id/.test(x.text))
    expect(st[taskLock]!.text).toMatch(/FOR UPDATE$/)
    expect(st[taskLock]!.text).not.toMatch(/NO KEY/)
    expect(taskLock).toBeLessThan(st.findIndex((x) => /FROM scheduled_task_runs WHERE task_id/.test(x.text)))
    expect(st.some((x) => /FROM sessions/.test(x.text))).toBe(false)
    expect(fake.state.lockCalls).toBe(0)
  })

  test('the row locks are also held when the write is refused for a shared-session run', async () => {
    const fake = setup({ shared: true })
    const r: any = await applyFix(fake.sql, { kind: 'normalize_timezone', timezone: 'UTC' }, CTX)
    expect(r.status).toBe('skipped_in_flight')
    expect(fake.state.statements.some((x) => /FROM sessions WHERE id = \? FOR UPDATE/.test(x.text))).toBe(true)
  })

  test('the open-run definition is the D-07 one, in SQL', async () => {
    const fake = setup({})
    await applyFix(fake.sql, { kind: 'normalize_timezone', timezone: 'UTC' }, CTX)
    const own = fake.state.statements.find((s) => /WHERE task_id/.test(s.text))!
    for (const frag of ["status IN ('running','pending','in_flight')", 'finished_at IS NULL', 'completed_at IS NULL']) {
      expect(own.text).toContain(frag)
    }
  })

  test('no open run: the write proceeds (a finished or legacy-completed run does not block)', async () => {
    const fake = setup({})
    const r = await applyFix(fake.sql, { kind: 'normalize_timezone', timezone: 'UTC' }, CTX)
    expect(r.status).toBe('applied')
    expect(fake.state.updatesTo('scheduled_tasks').length).toBe(1)
  })

  test('a task with no effective session skips the shared-session probe', async () => {
    const fake = setup({ row: { ...ROW, session_id: null, target_id: null, target_kind: 'agent' } })
    const r = await applyFix(fake.sql, { kind: 'normalize_timezone', timezone: 'UTC' }, CTX)
    expect(r.status).toBe('applied')
    expect(fake.state.statements.some((s) => /WHERE session_id/.test(s.text))).toBe(false)
  })

  test('the in-memory in-flight map is not consulted: the writer module imports no dispatcher', () => {
    const src = readFileSync(join(import.meta.dir, '..', 'src', 'task-qc', 'safe-fixes.ts'), 'utf8')
    expect(src).not.toMatch(/from '[^']*(dispatcher|registry|dispatch\/)[^']*'/)
  })
})
