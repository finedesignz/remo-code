/**
 * Regression: custom task prompt persistence + display (column/payload split).
 *
 * The prompt for a `dev` scheduled task historically lived in two places that
 * drifted: the `prompt` column and `payload.prompt`. The editor reads
 * `payload.prompt`; the create path wrote the column; PATCH never wrote the
 * column at all. These tests lock the single-source-of-truth behaviour:
 *   - CREATE persists BOTH the column and payload.prompt.
 *   - PATCH persists BOTH (mirrors payload.prompt → column and vice-versa).
 *   - The dispatcher sender resolves the saved prompt (not the default).
 *
 * Pure-unit: the DAL is mocked to capture the args the router would persist, so
 * no DB connection is opened.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-chars-long-aaaaaaaa'
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'session-secret-at-least-32-chars-long-x'
process.env.MAGIC_LINK_SECRET = process.env.MAGIC_LINK_SECRET || 'magic-link-secret-at-least-32-chars-x'
process.env.TITANIUM_KEYGEN_API_URL = process.env.TITANIUM_KEYGEN_API_URL || 'https://keygen.titaniumlabs.us'
process.env.TITANIUM_KEYGEN_ACCOUNT_ID = process.env.TITANIUM_KEYGEN_ACCOUNT_ID || 'acct_test'
process.env.TITANIUM_KEYGEN_PRODUCT_ID = process.env.TITANIUM_KEYGEN_PRODUCT_ID || 'prod_test'
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://localhost:5432/placeholder'

import { describe, test, expect, beforeAll, afterAll, mock } from 'bun:test'
import { Hono } from 'hono'

// Captured args the router passes to the DAL.
let createArg: any = null
let updateArg: any = null
let existingRow: any = null

const realSchedDal = await import('../src/db/scheduled-tasks-dal.ts')
mock.module('../src/db/scheduled-tasks-dal.ts', () => ({
  ...realSchedDal,
  listTasksForUser: mock(async () => []),
  getTask: mock(async () => existingRow),
  createTaskV2: mock(async (input: any) => {
    createArg = input
    return { id: 'new1', ...input }
  }),
  updateTaskV2: mock(async (_id: string, _u: string, fields: any) => {
    updateArg = fields
    return { id: existingRow?.id ?? 't1', ...existingRow, ...fields }
  }),
  deleteTask: mock(async () => undefined),
}))

// Auto-name + cycle detection reach into other DALs / registry — stub them.
const realDal = await import('../src/db/dal.ts')
mock.module('../src/db/dal.ts', () => ({ ...realDal, listSessions: mock(async () => []) }))
const realSupDal = await import('../src/db/supervisor-dal.ts')
mock.module('../src/db/supervisor-dal.ts', () => ({ ...realSupDal, listSupervisorsForUser: mock(async () => []) }))
mock.module('../src/scheduler/registry.ts', () => ({
  register: mock(() => {}),
  unregister: mock(() => {}),
  replace: mock(async () => {}),
  has: () => false,
}))

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

afterAll(() => mock.restore())

const baseCreate = {
  task_type: 'dev',
  target_kind: 'all_agents',
  cron_expr: '0 * * * *',
  timezone: 'UTC',
}

describe('CREATE persists prompt to BOTH column and payload', () => {
  test('payload.prompt → column + payload stay in sync', async () => {
    createArg = null
    const res = await app.request('/api/scheduled-tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...baseCreate, payload: { prompt: 'do the thing' } }),
    })
    expect(res.status).toBe(201)
    expect(createArg.prompt).toBe('do the thing')
    expect(createArg.payload.prompt).toBe('do the thing')
  })

  test('top-level prompt mirror also lands in payload + column', async () => {
    createArg = null
    const res = await app.request('/api/scheduled-tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...baseCreate, prompt: 'top level' }),
    })
    expect(res.status).toBe(201)
    expect(createArg.prompt).toBe('top level')
    expect(createArg.payload.prompt).toBe('top level')
  })
})

describe('PATCH persists prompt to BOTH column and payload', () => {
  test('editing payload.prompt writes the column too', async () => {
    existingRow = {
      id: 't1', user_id: 'u1', name: 'x', task_type: 'dev',
      target_kind: 'all_agents', target_id: null, payload: { prompt: 'old' },
      cron_expr: '0 * * * *', timezone: 'UTC', post_run_actions: [],
      name_suffix: null,
    }
    updateArg = null
    const res = await app.request('/api/scheduled-tasks/t1', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ payload: { prompt: 'updated' } }),
    })
    expect(res.status).toBe(200)
    expect(updateArg.prompt).toBe('updated')
    expect(updateArg.payload.prompt).toBe('updated')
  })

  test('top-level prompt patch mirrors into payload', async () => {
    existingRow = {
      id: 't1', user_id: 'u1', name: 'x', task_type: 'dev',
      target_kind: 'all_agents', target_id: null, payload: {},
      cron_expr: '0 * * * *', timezone: 'UTC', post_run_actions: [],
      name_suffix: null,
    }
    updateArg = null
    const res = await app.request('/api/scheduled-tasks/t1', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'via-top-level' }),
    })
    expect(res.status).toBe(200)
    expect(updateArg.prompt).toBe('via-top-level')
    expect(updateArg.payload.prompt).toBe('via-top-level')
  })
})

describe('dispatcher sender resolves the saved prompt', () => {
  test('buildContent prefers payload.prompt, falls back to column, then default', async () => {
    const { buildContent } = await import('../src/scheduler/senders/agent.ts')
    expect(buildContent({ task_type: 'dev', payload: { prompt: 'P' }, prompt: 'C' } as any)).toBe('P')
    // Legacy row: prompt only in the column.
    expect(buildContent({ task_type: 'dev', payload: {}, prompt: 'C' } as any)).toBe('C')
    // Neither → default.
    expect(buildContent({ task_type: 'dev', payload: {}, prompt: '' } as any)).toBe('Continue where you left off.')
  })
})
