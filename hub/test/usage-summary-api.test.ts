/**
 * Phase 12 W2 — GET /api/usage/summary
 *
 * Verifies happy-path shape, cache TTL (second call within window returns
 * cached value without re-hitting the DAL), and the 404 path when the user
 * record is missing.
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

let userRow: any = {
  id: 'u1',
  timezone: 'America/Los_Angeles',
  daily_cost_cap_usd: '2.5000',
  claude_session_threshold_pct: 80,
  claude_week_threshold_pct: 95,
}

const stubGetUserById = mock(async (id: string) => (id === 'u1' ? userRow : null))
const stubSumWindows = mock(async () => ({ today_usd: 1.23, week_usd: 4.56, month_usd: 7.89 }))

const realDalForUsage = await import('../src/db/dal.ts')
mock.module('../src/db/dal.ts', () => ({
  ...realDalForUsage,
  getUserById: stubGetUserById,
  sumUserCostWindows: stubSumWindows,
}))

const realUsageStore = await import('../src/usage/store.ts')
mock.module('../src/usage/store.ts', () => ({
  ...realUsageStore,
  getUsage: () => ({
    usage: {
      five_hour: { utilization: 12, resets_at: '2026-05-28T05:00:00Z' },
      seven_day: { utilization: 33, resets_at: '2026-06-04T00:00:00Z' },
    },
    updated_at: '2026-05-28T00:00:00Z',
  }),
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

beforeEach(async () => {
  const { _resetUsageSummaryCacheForTests } = await import('../src/api/usage')
  _resetUsageSummaryCacheForTests()
  stubGetUserById.mockClear()
  stubSumWindows.mockClear()
})

describe('GET /api/usage/summary', () => {
  test('happy path — full shape', async () => {
    const res = await app.request('/api/usage/summary')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.timezone).toBe('America/Los_Angeles')
    expect(body.today_usd).toBe(1.23)
    expect(body.week_usd).toBe(4.56)
    expect(body.month_usd).toBe(7.89)
    expect(body.daily_cap_usd).toBe(2.5)
    expect(body.thresholds.session_pct).toBe(80)
    expect(body.thresholds.week_pct).toBe(95)
    expect(body.claude_window.five_hour.utilization).toBe(12)
    expect(body.claude_window_updated_at).toBe('2026-05-28T00:00:00Z')
  })

  test('cache HIT on second call within TTL', async () => {
    await app.request('/api/usage/summary')
    await app.request('/api/usage/summary')
    // DAL hit exactly once.
    expect(stubGetUserById.mock.calls.length).toBe(1)
    expect(stubSumWindows.mock.calls.length).toBe(1)
  })

  test('404 when user record missing', async () => {
    userRow = null
    try {
      const res = await app.request('/api/usage/summary')
      expect(res.status).toBe(404)
    } finally {
      userRow = {
        id: 'u1',
        timezone: 'America/Los_Angeles',
        daily_cost_cap_usd: '2.5000',
        claude_session_threshold_pct: 80,
        claude_week_threshold_pct: 95,
      }
    }
  })

  test('falls back to UTC when user has no timezone', async () => {
    userRow.timezone = null
    try {
      const res = await app.request('/api/usage/summary')
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.timezone).toBe('UTC')
    } finally {
      userRow.timezone = 'America/Los_Angeles'
    }
  })
})
