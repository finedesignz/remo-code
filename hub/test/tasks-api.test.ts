/**
 * Phase 12 W2 — Tasks API validation tests.
 *
 * Mounts the tasks router behind a stub auth middleware that sets userId, and
 * intercepts DAL calls so we exercise only the route parsing + response shape.
 * Full DB-backed coverage is gated on REMO_E2E_DB_URL elsewhere; this file is
 * pure unit and runs on every `bun test`.
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

// Stub the DAL functions BEFORE importing the router so the import-time
// reference resolves to the mock. (postgres.js is lazy — never actually opens
// a connection because the stubs short-circuit.) Spread the real module first
// so cross-test imports of other dal symbols still resolve.
const stubUpcoming = mock(async () => [{ id: 't1', name: 'Demo', next_fire_at: '2030-01-01T00:00:00Z' }])
const stubActivity = mock(async () => [{ id: 'r1', task_id: 't1', started_at: '2026-05-28T00:00:00Z' }])
const stubGrouped = mock(async () => [{ key: 'repo:/code/x', label: '/code/x', tasks: [] }])

const realDalForTasks = await import('../src/db/dal.ts')
mock.module('../src/db/dal.ts', () => ({
  ...realDalForTasks,
  listUpcomingTasks: stubUpcoming,
  listUserActivityRuns: stubActivity,
  listTasksGroupedByRepo: stubGrouped,
}))

let app: Hono

beforeAll(async () => {
  const { tasks } = await import('../src/api/tasks')
  app = new Hono()
  // Stub auth: every request is user 'u1'.
  app.use('/api/tasks/*', async (c, next) => {
    c.set('userId', 'u1' as any)
    return next()
  })
  app.route('/api/tasks', tasks)
})

describe('GET /api/tasks/upcoming', () => {
  test('happy path returns { tasks }', async () => {
    const res = await app.request('/api/tasks/upcoming')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(Array.isArray(body.tasks)).toBe(true)
    expect(body.tasks[0].id).toBe('t1')
  })
  test('limit > 100 rejected', async () => {
    const res = await app.request('/api/tasks/upcoming?limit=500')
    expect(res.status).toBe(400)
  })
  test('limit < 1 rejected', async () => {
    const res = await app.request('/api/tasks/upcoming?limit=0')
    expect(res.status).toBe(400)
  })
  test('limit accepted within range', async () => {
    const res = await app.request('/api/tasks/upcoming?limit=10&offset=5')
    expect(res.status).toBe(200)
  })
})

describe('GET /api/tasks/activity', () => {
  test('no params → 200', async () => {
    const res = await app.request('/api/tasks/activity')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(Array.isArray(body.runs)).toBe(true)
    // next_cursor is the last-row started_at (present in stub).
    expect(typeof body.next_cursor).toBe('string')
  })
  test('valid status accepted', async () => {
    const res = await app.request('/api/tasks/activity?status=in_progress')
    expect(res.status).toBe(200)
  })
  test('invalid status rejected', async () => {
    const res = await app.request('/api/tasks/activity?status=banana')
    expect(res.status).toBe(400)
  })
  test('limit cap = 200', async () => {
    const res = await app.request('/api/tasks/activity?limit=500')
    expect(res.status).toBe(400)
  })
  test('invalid before timestamp rejected', async () => {
    const res = await app.request('/api/tasks/activity?before=notadate')
    expect(res.status).toBe(400)
  })
})

describe('GET /api/tasks/schedule', () => {
  test('default group_by=repo', async () => {
    const res = await app.request('/api/tasks/schedule')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.group_by).toBe('repo')
    expect(Array.isArray(body.groups)).toBe(true)
  })
  test('group_by=repo explicit', async () => {
    const res = await app.request('/api/tasks/schedule?group_by=repo')
    expect(res.status).toBe(200)
  })
  test('invalid group_by rejected', async () => {
    const res = await app.request('/api/tasks/schedule?group_by=user')
    expect(res.status).toBe(400)
  })
})
