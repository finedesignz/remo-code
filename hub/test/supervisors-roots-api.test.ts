/**
 * Phase 12 W2 — PATCH /api/supervisors/:id/roots
 *
 * Validation + plumbing test. Mocks the supervisor DAL + registry so the
 * route is exercised without a DB. Covers:
 *   - 404 when supervisor doesn't belong to the user
 *   - 400 on invalid body / invalid roots shape
 *   - 200 'queued' when supervisor is offline
 *   - 200 'live' when supervisor acks
 *   - 200 with supervisor_error when ack times out / nacks
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-chars-long-aaaaaaaa'
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'session-secret-at-least-32-chars-long-x'
process.env.MAGIC_LINK_SECRET = process.env.MAGIC_LINK_SECRET || 'magic-link-secret-at-least-32-chars-x'
process.env.TITANIUM_KEYGEN_API_URL = process.env.TITANIUM_KEYGEN_API_URL || 'https://keygen.titaniumlabs.us'
process.env.TITANIUM_KEYGEN_ACCOUNT_ID = process.env.TITANIUM_KEYGEN_ACCOUNT_ID || 'acct_test'
process.env.TITANIUM_KEYGEN_PRODUCT_ID = process.env.TITANIUM_KEYGEN_PRODUCT_ID || 'prod_test'
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://localhost:5432/placeholder'

import { describe, test, expect, beforeAll, beforeEach, mock } from 'bun:test'
import { Hono } from 'hono'

// State the stubs read — mutated per test.
let supervisorRow: any = { id: 'sup1', user_id: 'u1', hostname: 'h', roots: ['/old'] }
let online = false
let ackBehavior: 'ok' | 'nack' | 'throw' = 'ok'

const stubGetSupervisor = mock(async (id: string, userId: string) =>
  id === 'sup1' && userId === 'u1' ? supervisorRow : null,
)
const stubSetSupervisorRoots = mock(async (args: any) => ({
  ...supervisorRow,
  roots: args.roots,
}))

const stubIsOnline = mock(() => online)
const stubSendRequest = mock(async () => {
  if (ackBehavior === 'throw') throw new Error('timeout')
  if (ackBehavior === 'nack') return { ok: false, error: 'disk_full' }
  return { ok: true, applied_roots: ['/applied'] }
})
const stubBroadcast = mock(() => {})

// Spread real modules so cross-test imports of other symbols don't fail.
const realSupDal = await import('../src/db/supervisor-dal.ts')
mock.module('../src/db/supervisor-dal.ts', () => ({
  ...realSupDal,
  getSupervisor: stubGetSupervisor,
  setSupervisorRoots: stubSetSupervisorRoots,
}))

const realSupRegistry = await import('../src/ws/supervisor-registry.ts')
mock.module('../src/ws/supervisor-registry.ts', () => ({
  ...realSupRegistry,
  isSupervisorOnline: stubIsOnline,
  sendRequest: stubSendRequest,
}))

const realWsRegistry = await import('../src/ws/registry.ts')
mock.module('../src/ws/registry.ts', () => ({
  ...realWsRegistry,
  broadcastToUser: stubBroadcast,
}))

// Budget is imported by api/supervisors. Other tests in the suite mock budget
// partially; spread the real surface so cross-load order doesn't break.
const realBudget = await import('../src/sessions/budget.ts')
mock.module('../src/sessions/budget.ts', () => ({ ...realBudget }))

let app: Hono

beforeAll(async () => {
  const { supervisors } = await import('../src/api/supervisors')
  app = new Hono()
  app.use('/api/supervisors/*', async (c, next) => {
    c.set('userId', 'u1' as any)
    return next()
  })
  app.route('/api/supervisors', supervisors)
})

beforeEach(() => {
  supervisorRow = { id: 'sup1', user_id: 'u1', hostname: 'h', roots: ['/old'] }
  online = false
  ackBehavior = 'ok'
  stubGetSupervisor.mockClear()
  stubSetSupervisorRoots.mockClear()
  stubIsOnline.mockClear()
  stubSendRequest.mockClear()
  stubBroadcast.mockClear()
})

async function patch(path: string, body: any): Promise<Response> {
  return app.request(path, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('PATCH /api/supervisors/:id/roots', () => {
  test('404 when supervisor not found / not owned', async () => {
    const res = await patch('/api/supervisors/nope/roots', { roots: ['/a'] })
    expect(res.status).toBe(404)
  })

  test('400 when body lacks roots array', async () => {
    const res = await patch('/api/supervisors/sup1/roots', {})
    expect(res.status).toBe(400)
  })

  test('400 when a root has parent-traversal segment', async () => {
    const res = await patch('/api/supervisors/sup1/roots', { roots: ['/foo/../bad'] })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe('root_has_parent_traversal')
  })

  test('400 when a root is relative', async () => {
    const res = await patch('/api/supervisors/sup1/roots', { roots: ['relpath'] })
    expect(res.status).toBe(400)
  })

  test('200 queued when supervisor offline', async () => {
    online = false
    const res = await patch('/api/supervisors/sup1/roots', { roots: ['/home/u/code'] })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.applied).toBe('queued')
    expect(body.roots).toEqual(['/home/u/code'])
    expect(stubSendRequest.mock.calls.length).toBe(0)
    // Always broadcasts so other tabs sync.
    expect(stubBroadcast.mock.calls.length).toBe(1)
  })

  test('200 live when supervisor online and acks ok', async () => {
    online = true
    ackBehavior = 'ok'
    const res = await patch('/api/supervisors/sup1/roots', { roots: ['/x'] })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.applied).toBe('live')
    expect(body.supervisor_error).toBeNull()
    expect(stubSendRequest.mock.calls.length).toBe(1)
  })

  test('200 queued + supervisor_error when ack throws', async () => {
    online = true
    ackBehavior = 'throw'
    const res = await patch('/api/supervisors/sup1/roots', { roots: ['/x'] })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.applied).toBe('queued')
    expect(body.supervisor_error).toBe('timeout')
  })

  test('200 queued + supervisor_error when ack nacks', async () => {
    online = true
    ackBehavior = 'nack'
    const res = await patch('/api/supervisors/sup1/roots', { roots: ['/x'] })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.applied).toBe('queued')
    expect(body.supervisor_error).toBe('disk_full')
  })

  test('empty roots array is allowed (clears)', async () => {
    online = false
    const res = await patch('/api/supervisors/sup1/roots', { roots: [] })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.roots).toEqual([])
  })
})
