/**
 * Revanote webhook ingress tests.
 *
 * Covers:
 *   1. URL-path token auth (constant-time compare).
 *   2. Optional HMAC layer (when X-Revuu-Signature header present).
 *   3. Timestamp skew (when present in body).
 *   4. Raw body read BEFORE JSON parse.
 *   5. Idempotent insert via ON CONFLICT (user_id, annotation_id_external).
 *   6. Audit log recording for success + auth-fail + hmac-fail.
 *
 * DAL + dispatcher are mocked via `mock.module` so no Postgres / no real
 * dispatch occurs.
 */
import { describe, test, expect, beforeAll, beforeEach, mock } from 'bun:test'
import { createHmac } from 'node:crypto'
import { Hono } from 'hono'

const TEST_USER_ID = '22222222-2222-2222-2222-222222222222'
const TEST_SECRET = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'

const mockState: {
  secret: string | null
  attempts: any[]
  annotations: any[]
  dispatched: any[]
  broadcasts: any[]
} = {
  secret: TEST_SECRET,
  attempts: [],
  annotations: [],
  dispatched: [],
  broadcasts: [],
}

// Spread real shared modules so non-overridden exports stay resolvable for
// sibling files in the full suite (Bun mock.module is process-global).
const realRevanoteDalRW = await import(`../src/db/revanote-dal.ts?real=${Date.now()}`)
const realWsRegRW = await import(`../src/ws/registry.ts?real=${Date.now()}`)
mock.module('../src/db/revanote-dal.ts', () => ({
  ...realRevanoteDalRW,
  getUserRevanoteWebhookSecret: async () => mockState.secret,
  recordRevanoteWebhookAttempt: async (row: any) => { mockState.attempts.push(row) },
  insertAnnotation: async (input: any) => {
    const dup = mockState.annotations.find(
      (a) =>
        a.user_id === input.user_id &&
        a.annotation_id_external === input.annotation_id_external,
    )
    if (dup) return dup
    const row = {
      id: 'ann-' + (mockState.annotations.length + 1),
      status: 'pending',
      received_at: new Date().toISOString(),
      ...input,
    }
    mockState.annotations.push(row)
    return row
  },
  updateAnnotationStatus: async () => {},
  resolveRevanoteMappingForHost: async () => null,
}))

mock.module('../src/revanote/dispatcher.ts', () => ({
  dispatchAnnotationRow: async (ann: any) => {
    mockState.dispatched.push(ann)
    return { status: 'dispatched', run_id: 'r1', session_id: 's1' }
  },
  previewComment: (s: string, n = 30) => (s ?? '').slice(0, n),
}))

mock.module('../src/ws/registry.ts', () => ({
  ...realWsRegRW,
  broadcastRevanoteEvent: (uid: string, ev: any) => {
    mockState.broadcasts.push({ uid, ev })
  },
}))

let app: Hono
let mod: typeof import('../src/api/revanote-webhook.ts')

beforeAll(async () => {
  mod = await import('../src/api/revanote-webhook.ts')
  app = new Hono()
  app.route('/api/revanote', mod.revanoteWebhookRoutes)
})

beforeEach(() => {
  mockState.secret = TEST_SECRET
  mockState.attempts = []
  mockState.annotations = []
  mockState.dispatched = []
  mockState.broadcasts = []
})

const validBody = () => ({
  source: 'revanote',
  revanote_version: '1.0.0',
  annotation_id: 'ext-abc',
  annotation_url: 'https://app.revanote.com/review/p1#annotation-ext-abc',
  page_url: 'https://app.example.com/dashboard',
  screenshot_url: 'https://shots/1.png',
  x: 100, y: 200,
  element_selector: 'button.cta',
  comment: 'wrong color',
  callback_url: 'https://app.revanote.com/api/agent-callbacks',
})

describe('POST /api/revanote/webhook/:user_id/:token', () => {
  test('valid token → 202 + annotation inserted + dispatched', async () => {
    const res = await app.request(`/api/revanote/webhook/${TEST_USER_ID}/${TEST_SECRET}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validBody()),
    })
    expect(res.status).toBe(202)
    const body = await res.json()
    expect(body.accepted).toBe(true)
    expect(body.annotation_id_external).toBe('ext-abc')
    expect(mockState.annotations.length).toBe(1)
    expect(mockState.dispatched.length).toBe(1)
    expect(mockState.attempts[0].status).toBe('success')
  })

  test('wrong token → 401 + audit auth_failed', async () => {
    const res = await app.request(`/api/revanote/webhook/${TEST_USER_ID}/wrong-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validBody()),
    })
    expect(res.status).toBe(401)
    expect(mockState.attempts[0].status).toBe('auth_failed')
    expect(mockState.annotations.length).toBe(0)
  })

  test('no secret configured → 401 + audit webhook_not_configured', async () => {
    mockState.secret = null
    const res = await app.request(`/api/revanote/webhook/${TEST_USER_ID}/${TEST_SECRET}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validBody()),
    })
    expect(res.status).toBe(401)
    expect(mockState.attempts[0].reason).toBe('webhook_not_configured')
  })

  test('valid HMAC header → 202', async () => {
    const body = JSON.stringify(validBody())
    const sig = 'sha256=' + createHmac('sha256', TEST_SECRET).update(body).digest('hex')
    const res = await app.request(`/api/revanote/webhook/${TEST_USER_ID}/${TEST_SECRET}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Revuu-Signature': sig },
      body,
    })
    expect(res.status).toBe(202)
  })

  test('bad HMAC header → 401 + audit hmac_failed', async () => {
    const body = JSON.stringify(validBody())
    const res = await app.request(`/api/revanote/webhook/${TEST_USER_ID}/${TEST_SECRET}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Revuu-Signature': 'sha256=deadbeef',
      },
      body,
    })
    expect(res.status).toBe(401)
    expect(mockState.attempts[0].status).toBe('hmac_failed')
  })

  test('bad json → 400 + audit bad_payload', async () => {
    const res = await app.request(`/api/revanote/webhook/${TEST_USER_ID}/${TEST_SECRET}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json',
    })
    expect(res.status).toBe(400)
    expect(mockState.attempts[0].reason).toBe('invalid_json')
  })

  test('schema mismatch → 400', async () => {
    const res = await app.request(`/api/revanote/webhook/${TEST_USER_ID}/${TEST_SECRET}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ annotation_id: 'x' }), // missing required fields
    })
    expect(res.status).toBe(400)
  })

  test('stale timestamp → 401', async () => {
    const body = { ...validBody(), timestamp: 1 } // epoch 1 → way stale
    const res = await app.request(`/api/revanote/webhook/${TEST_USER_ID}/${TEST_SECRET}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    expect(res.status).toBe(401)
    expect(mockState.attempts[0].reason).toBe('stale_timestamp')
  })

  test('idempotent on duplicate annotation_id (same external id → same row)', async () => {
    const path = `/api/revanote/webhook/${TEST_USER_ID}/${TEST_SECRET}`
    const init = {
      method: 'POST' as const,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validBody()),
    }
    const r1 = await app.request(path, init)
    const r2 = await app.request(path, init)
    expect(r1.status).toBe(202)
    expect(r2.status).toBe(202)
    expect(mockState.annotations.length).toBe(1)
  })
})
