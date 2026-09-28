// hub/test/revanote-retry-guard.test.ts
// R2-2 — POST /api/revanote/annotations/:id/retry must refuse to reset+
// re-dispatch a 'dispatched' annotation whose first turn is still genuinely
// live (a live single-annotation pipeline hook/waiter, or a live batch turn),
// and must still allow a retry once that ownership is gone (stranded after a
// restart, or the row was never live in the first place).
//
// Run in isolation (Bun per-file process) via check-baseline.

import { describe, test, expect, mock, beforeAll, afterAll, beforeEach } from 'bun:test'

const USER_A = 'user-aaaa-0000-0000-0000-000000000001'

// ── Module mocks (must be before any dynamic import of the app) ─────────────

mock.module('../src/auth/middleware.ts', () => ({
  authMiddleware: (c: any, next: () => Promise<void>) => {
    c.set('userId', USER_A)
    return next()
  },
}))

const state: {
  annotation: any
  singleLive: boolean
  batchLive: { sessionId: string; token: string } | null
  updateAnnotationStatusCalls: Array<{ id: string; status: string; opts: any }>
  dispatchCalls: string[]
} = {
  annotation: null,
  singleLive: false,
  batchLive: null,
  updateAnnotationStatusCalls: [],
  dispatchCalls: [],
}

mock.module('../src/db/revanote-dal.ts', () => ({
  listAnnotations: async () => [],
  getAnnotationById: async (id: string) => (state.annotation?.id === id ? state.annotation : null),
  listAnnotationRuns: async () => [],
  updateAnnotationStatus: async (id: string, status: string, opts: any = {}) => {
    state.updateAnnotationStatusCalls.push({ id, status, opts })
  },
}))

mock.module('../src/dispatch/pipeline.ts', () => ({
  isTokenLive: (_sessionId: string, _token: string) => state.singleLive,
}))

mock.module('../src/revanote/batch-dispatch.ts', () => ({
  isAnnotationLiveInBatch: (_id: string) => state.batchLive,
}))

mock.module('../src/revanote/dispatcher.ts', () => ({
  dispatchPendingAnnotation: async (id: string, _opts: any) => {
    state.dispatchCalls.push(id)
    return { status: 'dispatched', run_id: 'run-x', session_id: 'sess-1' }
  },
}))

let app: any

beforeAll(async () => {
  const { revanoteAnnotations } = await import('../src/api/revanote-annotations.ts')
  const { Hono } = await import('hono')
  const testApp = new Hono()
  testApp.route('/api/revanote/annotations', revanoteAnnotations)
  app = testApp
})

afterAll(() => mock.restore())

beforeEach(() => {
  state.singleLive = false
  state.batchLive = null
  state.updateAnnotationStatusCalls = []
  state.dispatchCalls = []
  state.annotation = {
    id: 'ann-1',
    user_id: USER_A,
    session_id: 'sess-1',
    status: 'pending',
  }
})

describe('GET /api/revanote/annotations — R2-4 unknown ?status= must 400, not silently list unfiltered', () => {
  test('unrecognized status value -> 400', async () => {
    const res = await app.request('/api/revanote/annotations?status=dispatching')
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe('invalid_status')
  })

  test('empty status (no filter requested) -> 200, not 400', async () => {
    const res = await app.request('/api/revanote/annotations')
    expect(res.status).toBe(200)
  })

  test('a genuinely valid status -> 200', async () => {
    const res = await app.request('/api/revanote/annotations?status=dispatched')
    expect(res.status).toBe(200)
  })
})

describe('POST /api/revanote/annotations/:id/retry — R2-2 live-ownership guard', () => {
  test('pending row: retry proceeds (reset + forceSingle dispatch), no liveness check needed', async () => {
    const res = await app.request('/api/revanote/annotations/ann-1/retry', { method: 'POST' })
    expect(res.status).toBe(200)
    expect(state.updateAnnotationStatusCalls).toHaveLength(1)
    expect(state.updateAnnotationStatusCalls[0].status).toBe('pending')
    expect(state.dispatchCalls).toEqual(['ann-1'])
  })

  test('dispatched + single-annotation pipeline hook still live: refuses with 409, never resets/re-dispatches', async () => {
    state.annotation.status = 'dispatched'
    state.singleLive = true

    const res = await app.request('/api/revanote/annotations/ann-1/retry', { method: 'POST' })
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error).toBe('annotation_in_flight')
    expect(state.updateAnnotationStatusCalls).toHaveLength(0)
    expect(state.dispatchCalls).toHaveLength(0)
  })

  test('dispatched + live batch turn owns this annotation: refuses with 409, never resets/re-dispatches', async () => {
    state.annotation.status = 'dispatched'
    state.batchLive = { sessionId: 'sess-1', token: 'batch:user-aaaa-0000-0000-0000-000000000001:sess-1:map-1:b1' }

    const res = await app.request('/api/revanote/annotations/ann-1/retry', { method: 'POST' })
    expect(res.status).toBe(409)
    expect(state.updateAnnotationStatusCalls).toHaveLength(0)
    expect(state.dispatchCalls).toHaveLength(0)
  })

  test('dispatched but stranded (no live hook, no live batch — e.g. post-restart): retry proceeds', async () => {
    state.annotation.status = 'dispatched'
    state.singleLive = false
    state.batchLive = null

    const res = await app.request('/api/revanote/annotations/ann-1/retry', { method: 'POST' })
    expect(res.status).toBe(200)
    expect(state.updateAnnotationStatusCalls).toHaveLength(1)
    expect(state.dispatchCalls).toEqual(['ann-1'])
  })

  test('resolved / failed / failed_offline rows never consult liveness — retry always proceeds', async () => {
    for (const status of ['resolved', 'failed', 'failed_offline']) {
      state.updateAnnotationStatusCalls = []
      state.dispatchCalls = []
      state.annotation.status = status
      // Even if a stale live flag were somehow set, a non-'dispatched' row
      // must never consult it.
      state.singleLive = true
      state.batchLive = { sessionId: 'sess-1', token: 'batch:x' }

      const res = await app.request('/api/revanote/annotations/ann-1/retry', { method: 'POST' })
      expect(res.status).toBe(200)
      expect(state.dispatchCalls).toEqual(['ann-1'])
    }
  })
})
