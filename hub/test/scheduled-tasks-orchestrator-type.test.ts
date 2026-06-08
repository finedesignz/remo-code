/**
 * Regression: PATCH/POST /api/scheduled-tasks must accept task_type='orchestrator'.
 * The DB CHECK constraint in schema.sql allows 'orchestrator' (Phase 21
 * auto-dev-orchestrator), but the API Zod `TaskTypeEnum` was missing it, so
 * editing an orchestrator-type task 400'd `invalid_body`. See
 * fix/orchestrator-task-type-enum.
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

const ORCH_TASK = {
  id: 'orch-1',
  user_id: 'u1',
  name: 'Orchestrator',
  task_type: 'orchestrator',
  target_kind: 'session',
  target_id: 'sess-1',
  payload: {},
  cron_expr: '*/5 * * * *',
  cron_expression: '*/5 * * * *',
  timezone: 'UTC',
  enabled: true,
  post_run_actions: [],
  name_suffix: null,
  next_fire_at: '2030-01-01T00:00:00Z',
}

const stubGetTask = mock(async () => ({ ...ORCH_TASK }))
const stubUpdate = mock(async (_id: string, _u: string, patch: any) => ({ ...ORCH_TASK, ...patch }))
const stubList = mock(async () => [{ ...ORCH_TASK }])
const stubCreate = mock(async (row: any) => ({ ...ORCH_TASK, ...row, id: 'created-1' }))

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
mock.module('../src/db/dal.ts', () => ({ ...realDal2, listSessions: mock(async () => [{ id: 'sess-1', user_id: 'u1' }]) }))

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

describe('scheduled-tasks task_type=orchestrator acceptance', () => {
  test('PATCH with task_type:orchestrator is NOT rejected as invalid_body', async () => {
    const res = await app.request('/api/scheduled-tasks/orch-1', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ task_type: 'orchestrator', enabled: false }),
    })
    if (res.status !== 200) {
      const body = await res.clone().json().catch(() => ({}))
      expect(body.error).not.toBe('invalid_body')
    }
    expect(res.status).toBe(200)
  })

  test('POST with task_type:orchestrator parses (no invalid_body)', async () => {
    const res = await app.request('/api/scheduled-tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        task_type: 'orchestrator',
        target_kind: 'session',
        target_id: 'sess-1',
        cron_expr: '*/5 * * * *',
        timezone: 'UTC',
        payload: { prompt: 'hi' },
      }),
    })
    const body = await res.clone().json().catch(() => ({}))
    expect(body.error).not.toBe('invalid_body')
  })
})
