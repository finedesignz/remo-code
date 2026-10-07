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
  /** CAS outcome the mocked DAL returns; false = a concurrent writer changed the status. */
  casResult: boolean
  runs: any[]
} = {
  annotation: null,
  singleLive: false,
  batchLive: null,
  updateAnnotationStatusCalls: [],
  dispatchCalls: [],
  casResult: true,
  runs: [],
}

mock.module('../src/db/revanote-dal.ts', () => ({
  listAnnotations: async () => [],
  getAnnotationById: async (id: string) => (state.annotation?.id === id ? state.annotation : null),
  listAnnotationRuns: async () => state.runs,
  updateAnnotationStatus: async (id: string, status: string, opts: any = {}) => {
    state.updateAnnotationStatusCalls.push({ id, status, opts })
  },
  resetAnnotationToPendingIfStatus: async (id: string, expected: string, skip_reason: string) => {
    state.updateAnnotationStatusCalls.push({ id, status: 'pending', opts: { cas_expected: expected, skip_reason } })
    return state.casResult
  },
}))

mock.module('../src/dispatch/pipeline.ts', () => ({
  isTokenLive: (sessionId: string, _token: string) => state.singleLive && !!sessionId,
  isTokenLiveAnywhere: (_token: string) => state.singleLive,
}))

mock.module('../src/revanote/batch-dispatch.ts', () => ({
  isAnnotationLiveInBatch: (_id: string) => state.batchLive,
  batchRunMaxMs: () => 7_200_000,
}))

mock.module('../src/revanote/dispatcher.ts', () => ({
  singleRunMaxMs: () => 1_200_000,
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
  state.casResult = true
  state.runs = []
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

  test('single-path claim window: session_id still NULL but the pipeline owns the token -> 409', async () => {
    state.annotation.status = 'dispatched'
    state.annotation.session_id = null
    state.singleLive = true

    const res = await app.request('/api/revanote/annotations/ann-1/retry', { method: 'POST' })
    expect(res.status).toBe(409)
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

  test('Q1b: the reset is a CAS on the observed status; a concurrent status change refuses the retry with 409', async () => {
    state.annotation.status = 'dispatched'
    state.casResult = false // a concurrent claim/finalize moved the row after our read

    const res = await app.request('/api/revanote/annotations/ann-1/retry', { method: 'POST' })
    expect(res.status).toBe(409)
    expect(state.updateAnnotationStatusCalls[0].opts.cas_expected).toBe('dispatched')
    expect(state.dispatchCalls).toHaveLength(0)
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

describe('POST /api/revanote/annotations/:id/retry -- durable in-flight check (survives a hub restart)', () => {
  const run = (status: string, ageMs: number) => ({
    id: 'run-1', annotation_id: 'ann-1', status, started_at: new Date(Date.now() - ageMs).toISOString(),
  })

  test('8: dispatched + fresh in_flight run + empty memory maps -> 409, nothing sent', async () => {
    state.annotation.status = 'dispatched'
    state.runs = [run('in_flight', 60_000)]
    const res = await app.request('/api/revanote/annotations/ann-1/retry', { method: 'POST' })
    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe('annotation_in_flight')
    expect(state.dispatchCalls).toHaveLength(0)
    expect(state.updateAnnotationStatusCalls).toHaveLength(0)
  })

  test('8: in_flight run older than the single ceiling -> allowed, sent once', async () => {
    state.annotation.status = 'dispatched'
    state.runs = [run('in_flight', 1_200_000 + 60_000)]
    const res = await app.request('/api/revanote/annotations/ann-1/retry', { method: 'POST' })
    expect(res.status).toBe(200)
    expect(state.dispatchCalls).toEqual(['ann-1'])
  })

  test('8: latest run terminal -> allowed', async () => {
    state.annotation.status = 'dispatched'
    state.runs = [run('failed', 1_000), run('in_flight', 9_000_000)]
    const res = await app.request('/api/revanote/annotations/ann-1/retry', { method: 'POST' })
    expect(res.status).toBe(200)
    expect(state.dispatchCalls).toEqual(['ann-1'])
  })

  test('8: a batch member uses the batch ceiling (older than single, younger than batch -> 409)', async () => {
    state.annotation.status = 'dispatched'
    state.annotation.payload_raw = { batch_id: 'b1' }
    state.runs = [run('in_flight', 3_600_000)]
    const res = await app.request('/api/revanote/annotations/ann-1/retry', { method: 'POST' })
    expect(res.status).toBe(409)
    state.runs = [run('in_flight', 7_200_000 + 60_000)]
    const res2 = await app.request('/api/revanote/annotations/ann-1/retry', { method: 'POST' })
    expect(res2.status).toBe(200)
  })

  test('8: the in-memory check still refuses too (fresh-run check is additive)', async () => {
    state.annotation.status = 'dispatched'
    state.singleLive = true
    const res = await app.request('/api/revanote/annotations/ann-1/retry', { method: 'POST' })
    expect(res.status).toBe(409)
  })
})
