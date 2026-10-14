/**
 * PTYCAP-08 plan 05 (F2-B5, D-25): the seeded task_qc row is system-owned at the
 * API boundary. POST rejects the type, DELETE is 409, PATCH allows only
 * enabled + a validated cron_expr + a valid timezone and never rewrites the name.
 *
 * Pure unit: router behind stub auth + stubbed DAL/registry/dispatcher.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-chars-long-aaaaaaaa'
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'session-secret-at-least-32-chars-long-x'
process.env.MAGIC_LINK_SECRET = process.env.MAGIC_LINK_SECRET || 'magic-link-secret-at-least-32-chars-x'
process.env.TITANIUM_KEYGEN_API_URL = process.env.TITANIUM_KEYGEN_API_URL || 'https://keygen.titaniumlabs.us'
process.env.TITANIUM_KEYGEN_ACCOUNT_ID = process.env.TITANIUM_KEYGEN_ACCOUNT_ID || 'acct_test'
process.env.TITANIUM_KEYGEN_PRODUCT_ID = process.env.TITANIUM_KEYGEN_PRODUCT_ID || 'prod_test'
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://localhost:5432/placeholder'

import { describe, test, expect, beforeAll, beforeEach, afterAll, mock } from 'bun:test'
import { Hono } from 'hono'

const QC_TASK = {
  id: 'qc-1',
  user_id: 'u1',
  name: 'Task quality auditor',
  name_prefix: 'Task QC',
  name_suffix: 'daily',
  task_type: 'task_qc',
  target_kind: 'all_supervisors',
  target_id: null,
  payload: { prompt: 'audit', depth: 2 },
  prompt: 'audit',
  cron_expr: '0 9 * * *',
  cron_expression: '0 9 * * *',
  timezone: 'UTC',
  enabled: true,
  post_run_actions: [],
  schedule_kind: 'cron',
  run_at: null,
  schedule_rules: null,
  catchup_policy: 'skip',
  max_concurrent: 1,
  teab_repo_ident: null,
  email_summary: false,
  next_fire_at: '2030-01-01T00:00:00Z',
}
const OTHER_TASK = { ...QC_TASK, id: 'dev-1', name: 'Dev', task_type: 'dev', target_kind: 'all_agents' }

const stubGetTask = mock(async (id: string) => {
  if (id === 'qc-1') return { ...QC_TASK }
  if (id === 'dev-1') return { ...OTHER_TASK }
  return null
})
const stubUpdate = mock(async (_id: string, _u: string, patch: any) => ({ ...QC_TASK, ...patch }))
const stubList = mock(async () => [{ ...QC_TASK }, { ...OTHER_TASK }])
const stubCreate = mock(async (row: any) => ({ ...OTHER_TASK, ...row, id: 'created-1' }))
const stubDelete = mock(async () => {})
const regRegister = mock(() => {})
const regReplace = mock(async () => {})
const regUnregister = mock(() => {})
const stubRunNow = mock(async () => ({ runIds: ['r1'] }))

const realDal = await import('../src/db/scheduled-tasks-dal.ts')
mock.module('../src/db/scheduled-tasks-dal.ts', () => ({
  ...realDal,
  getTask: stubGetTask,
  updateTaskV2: stubUpdate,
  listTasksForUser: stubList,
  createTaskV2: stubCreate,
  deleteTask: stubDelete,
}))
const realRegistry = await import('../src/scheduler/registry.ts')
mock.module('../src/scheduler/registry.ts', () => ({
  ...realRegistry,
  register: regRegister,
  replace: regReplace,
  unregister: regUnregister,
}))
const realDispatcher = await import('../src/scheduler/dispatcher.ts')
mock.module('../src/scheduler/dispatcher.ts', () => ({ ...realDispatcher, runNow: stubRunNow }))
const realDal2 = await import('../src/db/dal.ts')
mock.module('../src/db/dal.ts', () => ({ ...realDal2, listSessions: mock(async () => []) }))
const realSup = await import('../src/db/supervisor-dal.ts')
mock.module('../src/db/supervisor-dal.ts', () => ({ ...realSup, listSupervisorsForUser: mock(async () => []) }))

let app: Hono

beforeAll(async () => {
  const { scheduledTasks } = await import('../src/api/scheduled-tasks.ts')
  app = new Hono()
  app.use('/api/scheduled-tasks/*', async (c, next) => {
    c.set('userId', 'u1' as any)
    return next()
  })
  app.route('/api/scheduled-tasks', scheduledTasks)
})

afterAll(() => {
  mock.restore()
})

beforeEach(() => {
  for (const m of [stubUpdate, stubCreate, stubDelete, regRegister, regReplace, regUnregister, stubRunNow]) m.mockClear()
})

const call = (method: string, path: string, body?: unknown) =>
  app.request(`/api/scheduled-tasks${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })

describe('POST: task_qc is machine-seeded only', () => {
  test('cron create of task_qc is 400 task_qc_machine_seeded and inserts nothing', async () => {
    const res = await call('POST', '', {
      task_type: 'task_qc', target_kind: 'all_supervisors', cron_expr: '0 9 * * *', timezone: 'UTC',
    })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('task_qc_machine_seeded')
    expect(stubCreate).not.toHaveBeenCalled()
    expect(regRegister).not.toHaveBeenCalled()
  })

  test('once create of task_qc is 400 task_qc_machine_seeded and inserts nothing', async () => {
    const res = await call('POST', '', {
      task_type: 'task_qc', target_kind: 'all_supervisors', schedule_kind: 'once',
      run_at: '2030-01-01T00:00:00Z', timezone: 'UTC',
    })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('task_qc_machine_seeded')
    expect(stubCreate).not.toHaveBeenCalled()
  })

  test('other task types still create', async () => {
    const res = await call('POST', '', {
      task_type: 'dev', target_kind: 'all_agents', cron_expr: '*/5 * * * *', timezone: 'UTC',
      payload: { prompt: 'hi' },
    })
    expect(res.status).toBe(201)
    expect(stubCreate).toHaveBeenCalledTimes(1)
  })
})

describe('DELETE: task_qc is never deletable', () => {
  test('409 task_qc_system_task, no unregister, no delete DAL call', async () => {
    const res = await call('DELETE', '/qc-1')
    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe('task_qc_system_task')
    expect(regUnregister).not.toHaveBeenCalled()
    expect(stubDelete).not.toHaveBeenCalled()
  })

  test('other rows still delete', async () => {
    const res = await call('DELETE', '/dev-1')
    expect(res.status).toBe(200)
    expect(regUnregister).toHaveBeenCalledTimes(1)
    expect(stubDelete).toHaveBeenCalledTimes(1)
  })

  test('missing id is still 404', async () => {
    const res = await call('DELETE', '/nope')
    expect(res.status).toBe(404)
    expect(stubDelete).not.toHaveBeenCalled()
  })
})

describe('GET and run-now stay open for task_qc', () => {
  test('list and get still return the task_qc row', async () => {
    const list = await call('GET', '')
    expect((await list.json()).tasks.some((t: any) => t.task_type === 'task_qc')).toBe(true)
    const one = await call('GET', '/qc-1')
    expect(one.status).toBe(200)
    expect((await one.json()).task_type).toBe('task_qc')
  })

  test('run-now is not rejected by the API layer', async () => {
    const res = await call('POST', '/qc-1/run-now')
    expect(res.status).toBe(202)
    expect(stubRunNow).toHaveBeenCalledTimes(1)
  })
})
