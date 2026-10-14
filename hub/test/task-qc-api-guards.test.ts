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
    (c as any).set('userId', 'u1')
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
    expect(((await res.json()) as any).error).toBe('task_qc_machine_seeded')
    expect(stubCreate).not.toHaveBeenCalled()
    expect(regRegister).not.toHaveBeenCalled()
  })

  test('once create of task_qc is 400 task_qc_machine_seeded and inserts nothing', async () => {
    const res = await call('POST', '', {
      task_type: 'task_qc', target_kind: 'all_supervisors', schedule_kind: 'once',
      run_at: '2030-01-01T00:00:00Z', timezone: 'UTC',
    })
    expect(res.status).toBe(400)
    expect(((await res.json()) as any).error).toBe('task_qc_machine_seeded')
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
    expect(((await res.json()) as any).error).toBe('task_qc_system_task')
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
    expect(((await list.json()) as any).tasks.some((t: any) => t.task_type === 'task_qc')).toBe(true)
    const one = await call('GET', '/qc-1')
    expect(one.status).toBe(200)
    expect(((await one.json()) as any).task_type).toBe('task_qc')
  })

  test('run-now is not rejected by the API layer', async () => {
    const res = await call('POST', '/qc-1/run-now')
    expect(res.status).toBe(202)
    expect(stubRunNow).toHaveBeenCalledTimes(1)
  })
})

const LOCKED_DIFFERING: Array<[string, unknown]> = [
  ['task_type', 'dev'],
  ['target_kind', 'all_agents'],
  ['target_id', 'some-target'],
  ['payload', { prompt: 'evil' }],
  ['prompt', 'evil'],
  ['email_summary', true],
  ['post_run_actions', [{ kind: 'x' }]],
  ['schedule_kind', 'once'],
  ['run_at', '2030-01-01T00:00:00Z'],
  ['schedule_rules', [{ interval: 1, unit: 'hours', start_at: '2030-01-01T00:00:00Z' }]],
  ['catchup_policy', 'run_once'],
  ['max_concurrent', 5],
  ['teab_repo_ident', 'github://o/r'],
  ['name', 'renamed'],
  ['name_suffix', 'renamed'],
]

describe('PATCH: only enabled, a validated cadence and a valid timezone', () => {
  test('allowed keys succeed and the update receives ONLY those fields', async () => {
    const res = await call('PATCH', '/qc-1', { enabled: false, cron_expr: '0 */6 * * *', timezone: 'America/Los_Angeles' })
    expect(res.status).toBe(200)
    expect(stubUpdate).toHaveBeenCalledTimes(1)
    const patch = (stubUpdate.mock.calls[0] as any[])[2]
    expect(Object.keys(patch).filter((k) => patch[k] !== undefined).sort()).toEqual(['cron_expr', 'enabled', 'timezone'])
    for (const k of ['name', 'name_prefix', 'name_suffix', 'payload', 'prompt', 'catchup_policy', 'max_concurrent', 'post_run_actions', 'email_summary', 'task_type']) {
      expect(patch[k]).toBeUndefined()
    }
    expect(regReplace).toHaveBeenCalledTimes(1)
  })

  test('enabled-only patch never renames the row', async () => {
    const res = await call('PATCH', '/qc-1', { enabled: true })
    expect(res.status).toBe(200)
    const patch = (stubUpdate.mock.calls[0] as any[])[2]
    expect(patch.name).toBeUndefined()
    expect(patch.name_prefix).toBeUndefined()
    expect(patch.name_suffix).toBeUndefined()
    expect(patch.enabled).toBe(true)
    expect(regReplace).toHaveBeenCalledTimes(1)
  })

  for (const [key, value] of LOCKED_DIFFERING) {
    test(`locked key ${key} with a differing value is 400 task_qc_field_immutable`, async () => {
      const res = await call('PATCH', '/qc-1', { [key]: value })
      // schedule_rules may fail generic body/rule validation before the guard
      // only if the guard ran after it; the guard must run first.
      expect(res.status).toBe(400)
      const body = (await res.json()) as any
      expect(body.error).toBe('task_qc_field_immutable')
      expect(body.fields).toContain(key)
      expect(stubUpdate).not.toHaveBeenCalled()
      expect(regReplace).not.toHaveBeenCalled()
    })
  }

  test('several offending keys are all named', async () => {
    const res = await call('PATCH', '/qc-1', { payload: { a: 1 }, prompt: 'x', enabled: false })
    expect(res.status).toBe(400)
    const body = (await res.json()) as any
    expect(body.fields.sort()).toEqual(['payload', 'prompt'])
    expect(stubUpdate).not.toHaveBeenCalled()
  })

  test('locked keys equal to the stored values are ignored and the request succeeds', async () => {
    const res = await call('PATCH', '/qc-1', {
      name: QC_TASK.name,
      name_suffix: QC_TASK.name_suffix,
      task_type: 'task_qc',
      target_kind: 'all_supervisors',
      target_id: null,
      payload: { depth: 2, prompt: 'audit' },
      prompt: 'audit',
      email_summary: false,
      post_run_actions: [],
      schedule_kind: 'cron',
      run_at: null,
      catchup_policy: 'skip',
      max_concurrent: 1,
      teab_repo_ident: null,
      enabled: false,
    })
    expect(res.status).toBe(200)
    const patch = (stubUpdate.mock.calls[0] as any[])[2]
    expect(Object.keys(patch).filter((k) => patch[k] !== undefined)).toEqual(['enabled'])
  })

  test('faster-than-hourly cron is 400 task_qc_cadence_invalid / faster_than_hourly', async () => {
    const res = await call('PATCH', '/qc-1', { cron_expr: '*/5 * * * *' })
    expect(res.status).toBe(400)
    const body = (await res.json()) as any
    expect(body.error).toBe('task_qc_cadence_invalid')
    expect(body.reason).toBe('faster_than_hourly')
    expect(stubUpdate).not.toHaveBeenCalled()
  })

  test('invalid cron is 400 task_qc_cadence_invalid / invalid_cron', async () => {
    const res = await call('PATCH', '/qc-1', { cron_expr: 'not a cron' })
    expect(res.status).toBe(400)
    const body = (await res.json()) as any
    expect(body.error).toBe('task_qc_cadence_invalid')
    expect(body.reason).toBe('invalid_cron')
    expect(stubUpdate).not.toHaveBeenCalled()
  })

  test('invalid timezone is 400 task_qc_cadence_invalid / invalid_timezone', async () => {
    const res = await call('PATCH', '/qc-1', { timezone: 'Mars/Olympus' })
    expect(res.status).toBe(400)
    const body = (await res.json()) as any
    expect(body.error).toBe('task_qc_cadence_invalid')
    expect(body.reason).toBe('invalid_timezone')
    expect(stubUpdate).not.toHaveBeenCalled()
  })

  test('a valid daily cron passes', async () => {
    const res = await call('PATCH', '/qc-1', { cron_expr: '30 3 * * *' })
    expect(res.status).toBe(200)
    expect(((stubUpdate.mock.calls[0] as any[])[2]).cron_expr).toBe('30 3 * * *')
  })

  test('non-task_qc rows keep the generic PATCH behavior (rename recompute, free fields)', async () => {
    const res = await call('PATCH', '/dev-1', { payload: { prompt: 'new' }, cron_expr: '*/5 * * * *' })
    expect(res.status).toBe(200)
    const patch = (stubUpdate.mock.calls[0] as any[])[2]
    expect(patch.prompt).toBe('new')
    expect(patch.cron_expr).toBe('*/5 * * * *')
    expect(patch.name).toBeDefined()
  })
})
