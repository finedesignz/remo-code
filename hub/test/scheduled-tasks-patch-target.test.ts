/**
 * Regression: PATCH /api/scheduled-tasks/:id must NOT re-validate targeting on
 * a non-targeting patch (e.g. `{ enabled }`). Internal system tasks legitimately
 * carry target_kind='session' with target_id=null (routed at dispatch time);
 * toggling them previously 400'd `target_id_required`. See fix/hide-internal-tasks.
 *
 * Pure unit: mounts the router behind stub auth + stubbed DAL/registry so we
 * exercise only the route's validation + response shape.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-chars-long-aaaaaaaa'
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'session-secret-at-least-32-chars-long-x'
process.env.MAGIC_LINK_SECRET = process.env.MAGIC_LINK_SECRET || 'magic-link-secret-at-least-32-chars-x'
process.env.TITANIUM_KEYGEN_API_URL = process.env.TITANIUM_KEYGEN_API_URL || 'https://keygen.titaniumlabs.us'
process.env.TITANIUM_KEYGEN_ACCOUNT_ID = process.env.TITANIUM_KEYGEN_ACCOUNT_ID || 'acct_test'
process.env.TITANIUM_KEYGEN_PRODUCT_ID = process.env.TITANIUM_KEYGEN_PRODUCT_ID || 'prod_test'
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://localhost:5432/placeholder'

import { describe, test, expect, beforeAll, mock } from 'bun:test'
import { Hono } from 'hono'

// An internal system task: target_kind='session' but target_id=null by design.
const INTERNAL_TASK = {
  id: 'internal-1',
  user_id: 'u1',
  name: '__internal_triage',
  task_type: 'triage',
  target_kind: 'session',
  target_id: null,
  payload: {},
  cron_expr: '*/5 * * * *',
  cron_expression: '*/5 * * * *',
  timezone: 'UTC',
  enabled: true,
  post_run_actions: [],
  name_suffix: null,
  next_fire_at: '2030-01-01T00:00:00Z',
}

const stubGetTask = mock(async () => ({ ...INTERNAL_TASK }))
const stubUpdate = mock(async (_id: string, _u: string, patch: any) => ({ ...INTERNAL_TASK, ...patch }))
const stubList = mock(async () => [{ ...INTERNAL_TASK }])
const stubCreate = mock(async (row: any) => ({ ...INTERNAL_TASK, ...row, id: 'created-1' }))

const realDal = await import('../src/db/scheduled-tasks-dal.ts')
mock.module('../src/db/scheduled-tasks-dal.ts', () => ({
  ...realDal,
  getTask: stubGetTask,
  updateTaskV2: stubUpdate,
  listTasksForUser: stubList,
  createTaskV2: stubCreate,
  deleteTask: mock(async () => {}),
}))

const realRegistry = await import('../src/scheduler/registry.ts')
mock.module('../src/scheduler/registry.ts', () => ({
  ...realRegistry,
  register: mock(() => {}),
  replace: mock(async () => {}),
  unregister: mock(() => {}),
}))

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

describe('PATCH /api/scheduled-tasks/:id — target re-validation gating', () => {
  test('(a) pure { enabled } patch on a null-target session task SUCCEEDS (no 400)', async () => {
    const res = await app.request('/api/scheduled-tasks/internal-1', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    })
    expect(res.status).toBe(200)
  })

  test('(b) patch that sets target_kind to a kind needing a target WITHOUT target_id still 400s', async () => {
    const res = await app.request('/api/scheduled-tasks/internal-1', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target_kind: 'supervisor' }),
    })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe('target_id_required')
  })

  test('(c) create still 400s without a required target_id', async () => {
    const res = await app.request('/api/scheduled-tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        task_type: 'dev',
        target_kind: 'supervisor',
        cron_expr: '*/5 * * * *',
        timezone: 'UTC',
        payload: { prompt: 'hi' },
      }),
    })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe('target_id_required')
  })
})
