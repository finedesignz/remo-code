/**
 * POST /api/supervisors/:id/start on a repo_path that resolves to the user's
 * orchestrator session must 409 `use_orchestrator_start` (the reserve seam
 * refuses it) and must NEVER send session.start.
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

const sent: any[] = []
const reserve = mock(async () => ({ ok: false, reason: 'orchestrator_session', sessionId: 'orch-1' }))

const realSupDal = await import('../src/db/supervisor-dal.ts')
mock.module('../src/db/supervisor-dal.ts', () => ({
  ...realSupDal,
  getSupervisor: async (id: string, userId: string) =>
    id === 'sup1' && userId === 'u1' ? { id: 'sup1', user_id: 'u1', hostname: 'h', roots: ['/root'] } : null,
}))
const realReg = await import('../src/ws/supervisor-registry.ts')
mock.module('../src/ws/supervisor-registry.ts', () => ({
  ...realReg,
  isSupervisorOnline: () => true,
  sendToSupervisor: (_id: string, m: any) => sent.push(m),
}))
const realBudget = await import('../src/sessions/budget.ts')
mock.module('../src/sessions/budget.ts', () => ({ ...realBudget, reserveSessionSlot: reserve }))

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

describe('POST /api/supervisors/:id/start orchestrator guard', () => {
  test('409 use_orchestrator_start, nothing sent', async () => {
    const res = await app.request('/api/supervisors/sup1/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repo_path: '/root' }),
    })
    expect(res.status).toBe(409)
    const body: any = await res.json()
    expect(body.error).toBe('use_orchestrator_start')
    expect(body.session_id).toBe('orch-1')
    expect(sent.length).toBe(0)
  })
})
