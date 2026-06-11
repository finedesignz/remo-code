/**
 * Tests for the public end-user feedback intake (Option A).
 *
 * Covers:
 *   - valid token → 202 + dispatchFeedback called (screenshot inlined as image)
 *   - unknown token → 404; disabled key → 403
 *   - missing comment → 400; oversized comment / screenshot → 413
 *   - bad screenshot data-URI / unsupported type → 400
 *   - per-IP rate-limit flood → 429
 *   - offline session (dispatch returns skipped) → still 202 (fire-and-forget,
 *     never a hard error to the submitter)
 *   - mount-order: the public /api/feedback/ path is in the auth/csrf allowlists
 *     (covered by mount-order.test.ts; here we assert the route is reachable).
 *
 * DAL + dispatcher are mocked via `mock.module` so no Postgres / agent socket
 * is needed. Run in isolation (Bun mock.module is process-global).
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-chars-long-aaaaaaaa'
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'session-secret-at-least-32-chars-long-x'
process.env.MAGIC_LINK_SECRET = process.env.MAGIC_LINK_SECRET || 'magic-link-secret-at-least-32-chars-x'
process.env.TITANIUM_KEYGEN_API_URL = process.env.TITANIUM_KEYGEN_API_URL || 'https://keygen.titaniumlabs.us'
process.env.TITANIUM_KEYGEN_ACCOUNT_ID = process.env.TITANIUM_KEYGEN_ACCOUNT_ID || 'acct_test_0000000000'
process.env.TITANIUM_KEYGEN_PRODUCT_ID = process.env.TITANIUM_KEYGEN_PRODUCT_ID || 'prod_test_remo'

import { describe, test, expect, beforeEach, mock } from 'bun:test'

const mockState: {
  key: { token_hash: string; session_id: string; user_id: string; label: string | null; enabled: boolean; created_at: Date } | null
  dispatchOutcome: any
  dispatchCalls: any[]
} = {
  key: null,
  dispatchOutcome: { status: 'dispatched', run_id: 'run_1' },
  dispatchCalls: [],
}

const realFeedbackDal = await import(`../src/db/feedback-dal.ts?real=${Date.now()}`)
mock.module('../src/db/feedback-dal.ts', () => ({
  ...realFeedbackDal,
  resolveFeedbackKey: async (token: string) => {
    if (mockState.key == null) return null
    if (!token || !token.startsWith('fb_')) return null
    return mockState.key
  },
}))

mock.module('../src/feedback/dispatcher.ts', () => ({
  dispatchFeedback: async (sub: any) => {
    mockState.dispatchCalls.push(sub)
    return mockState.dispatchOutcome
  },
}))

// Reset the rate-limit memory backend between tests so floods don't bleed over.
const rl = await import('../src/middleware/rate-limit.ts')

const { app } = await import('../src/index.ts')

const VALID = {
  token_hash: 'h', session_id: 'sess_1', user_id: 'user_1',
  label: 'MyApp', enabled: true, created_at: new Date(),
}

const TINY_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

function post(token: string, body: any, ip = '203.0.113.1') {
  return app.request(`/api/feedback/${token}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  mockState.key = { ...VALID }
  mockState.dispatchOutcome = { status: 'dispatched', run_id: 'run_1' }
  mockState.dispatchCalls = []
  // Fresh in-memory rate-limit backend each test (avoids cross-test 429s).
  rl.__setRateLimitBackendForTesting(null)
})

describe('feedback intake — happy path', () => {
  test('valid token + comment + screenshot → 202 and dispatch called with inlined image', async () => {
    const res = await post('fb_validtoken', { comment: 'Button is broken', screenshot: TINY_PNG, page_url: 'https://app.example.com/x', console_errors: 'TypeError: x' })
    expect(res.status).toBe(202)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.status).toBe('accepted')
    expect(mockState.dispatchCalls.length).toBe(1)
    const sub = mockState.dispatchCalls[0]
    expect(sub.sessionId).toBe('sess_1')
    expect(sub.userId).toBe('user_1')
    expect(sub.comment).toBe('Button is broken')
    // screenshot parsed into media_type + raw base64 data (data-URI prefix stripped)
    expect(sub.screenshot.media_type).toBe('image/png')
    expect(sub.screenshot.data).not.toContain('data:')
    expect(sub.page_url).toBe('https://app.example.com/x')
    expect(sub.console_errors).toBe('TypeError: x')
  })

  test('comment-only (no screenshot) → 202', async () => {
    const res = await post('fb_validtoken', { comment: 'no repro screenshot' })
    expect(res.status).toBe(202)
    expect(mockState.dispatchCalls[0].screenshot).toBeNull()
  })
})

describe('feedback intake — auth', () => {
  test('unknown token → 404', async () => {
    mockState.key = null
    const res = await post('fb_unknown', { comment: 'hi' })
    expect(res.status).toBe(404)
    expect(mockState.dispatchCalls.length).toBe(0)
  })

  test('disabled key → 403', async () => {
    mockState.key = { ...VALID, enabled: false }
    const res = await post('fb_disabled', { comment: 'hi' })
    expect(res.status).toBe(403)
    expect(mockState.dispatchCalls.length).toBe(0)
  })
})

describe('feedback intake — validation + size caps', () => {
  test('missing comment → 400', async () => {
    const res = await post('fb_validtoken', { screenshot: TINY_PNG })
    expect(res.status).toBe(400)
  })

  test('oversized comment → 413', async () => {
    const res = await post('fb_validtoken', { comment: 'x'.repeat(5001) })
    expect(res.status).toBe(413)
  })

  test('oversized screenshot → 413', async () => {
    const huge = 'data:image/png;base64,' + 'A'.repeat(15 * 1024 * 1024)
    const res = await post('fb_validtoken', { comment: 'ok', screenshot: huge })
    expect(res.status).toBe(413)
  })

  test('oversized console_errors → 413', async () => {
    const res = await post('fb_validtoken', { comment: 'ok', console_errors: 'e'.repeat(20001) })
    expect(res.status).toBe(413)
  })

  test('non-data-URI screenshot → 400', async () => {
    const res = await post('fb_validtoken', { comment: 'ok', screenshot: 'http://evil/x.png' })
    expect(res.status).toBe(400)
  })

  test('unsupported screenshot media type → 400', async () => {
    const res = await post('fb_validtoken', { comment: 'ok', screenshot: 'data:image/svg+xml;base64,PHN2Zz4=' })
    expect(res.status).toBe(400)
  })

  test('non-JSON body → 400', async () => {
    const res = await app.request('/api/feedback/fb_validtoken', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.9' },
      body: 'not json',
    })
    expect(res.status).toBe(400)
  })
})

describe('feedback intake — abuse / rate limit', () => {
  test('per-IP flood trips 429', async () => {
    // Per-IP bucket is 10/min. 12 requests from one IP → at least one 429.
    const ip = '198.51.100.7'
    const codes: number[] = []
    for (let i = 0; i < 14; i++) {
      const res = await post('fb_validtoken', { comment: `c${i}` }, ip)
      codes.push(res.status)
    }
    expect(codes.includes(429)).toBe(true)
  })
})

describe('feedback intake — offline session is not a hard error', () => {
  test('dispatch returns skipped(session_offline) → submitter still gets 202', async () => {
    // The route is fire-and-forget: it returns 202 regardless of the async
    // dispatch outcome (offline → spawn-on-error/park handled downstream).
    mockState.dispatchOutcome = { status: 'skipped', skip_reason: 'session_offline' }
    const res = await post('fb_validtoken', { comment: 'offline app' }, '203.0.113.55')
    expect(res.status).toBe(202)
  })
})
