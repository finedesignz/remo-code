/**
 * P2 — GET /api/usage/cost aggregation shape.
 * DAL is stubbed; this asserts the route wires windows + per-session + per-repo
 * breakdowns and labels cost as an estimate.
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

let userExists = true
const realDal = await import('../src/db/dal.ts')
mock.module('../src/db/dal.ts', () => ({
  ...realDal,
  getUserById: mock(async (id: string) =>
    userExists && id === 'u1' ? { id: 'u1', timezone: 'UTC' } : null),
}))

const windows = {
  today: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 10, cache_read_input_tokens: 200, cost_usd: 0.5 },
  seven_day: { input_tokens: 700, output_tokens: 350, cache_creation_input_tokens: 70, cache_read_input_tokens: 1400, cost_usd: 3.5 },
  total: { input_tokens: 1000, output_tokens: 500, cache_creation_input_tokens: 100, cache_read_input_tokens: 2000, cost_usd: 5 },
}
mock.module('../src/db/token-usage-dal.ts', () => ({
  getTodayTokenTotal: mock(async () => 0),
  sumUserTokenWindows: mock(async () => windows),
  usageBySession: mock(async () => [
    { session_id: 's1', session_name: 'sess', project_dir: '/p', input_tokens: 1000, output_tokens: 500, cache_creation_input_tokens: 100, cache_read_input_tokens: 2000, cost_usd: 5 },
  ]),
  usageByRepo: mock(async () => [
    { repo: 'owner/repo', input_tokens: 1000, output_tokens: 500, cache_creation_input_tokens: 100, cache_read_input_tokens: 2000, cost_usd: 5 },
  ]),
}))

let app: Hono
beforeAll(async () => {
  const { usage } = await import('../src/api/usage')
  app = new Hono()
  app.use('/api/usage/*', async (c, next) => {
    c.set('userId', 'u1' as any)
    return next()
  })
  app.route('/api/usage', usage)
})

describe('GET /api/usage/cost', () => {
  test('returns today/7d/total + per-session + per-repo, labeled estimate', async () => {
    const res = await app.request('/api/usage/cost')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.timezone).toBe('UTC')
    expect(body.cost_is_estimate).toBe(true)
    expect(body.today.cost_usd).toBe(0.5)
    expect(body.seven_day.cost_usd).toBe(3.5)
    expect(body.total.input_tokens).toBe(1000)
    expect(body.by_session[0].session_id).toBe('s1')
    expect(body.by_repo[0].repo).toBe('owner/repo')
  })

  test('404 when user missing', async () => {
    userExists = false
    try {
      const res = await app.request('/api/usage/cost')
      expect(res.status).toBe(404)
    } finally {
      userExists = true
    }
  })
})
