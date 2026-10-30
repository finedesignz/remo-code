/**
 * Revanote re-delivery reopens a stranded annotation.
 *
 * Incident (2026-10): Revanote re-sends a comment when no callback arrives within
 * its reclaim window. The webhook upsert kept the hub row's old status, the
 * send-time claim only takes 'pending', so the re-send dispatched nothing and sent
 * no callback while the hub answered 202 — a 5-attempt silent loop per comment.
 *
 * DAL, dispatcher and liveness are mocked; no Postgres, no real dispatch.
 */
import { describe, test, expect, beforeAll, beforeEach, mock } from 'bun:test'
import { Hono } from 'hono'

const USER = '33333333-3333-3333-3333-333333333333'
const SECRET = 'cccccccc-cccc-cccc-cccc-cccccccccccc'

const s: {
  existing: any
  runs: any[]
  singleLive: boolean
  batchLive: boolean
  casResult: boolean
  resets: Array<{ id: string; expected: string; reason: string }>
  cancels: Array<{ id: string; reason: string }>
  dispatched: any[]
} = {
  existing: null, runs: [], singleLive: false, batchLive: false, casResult: true,
  resets: [], cancels: [], dispatched: [],
}

const realDal = await import(`../src/db/revanote-dal.ts?real=${Date.now()}`)
mock.module('../src/db/revanote-dal.ts', () => ({
  ...realDal,
  getUserRevanoteWebhookSecret: async () => SECRET,
  recordRevanoteWebhookAttempt: async () => {},
  insertAnnotation: async (input: any) =>
    s.existing ?? { id: 'ann-new', status: 'pending', received_at: new Date().toISOString(), ...input },
  setAnnotationMappingId: async () => {},
  resolveRevanoteMappingForHost: async () => null,
  listAnnotationRuns: async () => s.runs,
  resetAnnotationToPendingIfStatus: async (id: string, expected: string, reason: string) => {
    s.resets.push({ id, expected, reason })
    return s.casResult
  },
  cancelInFlightRunsForAnnotation: async (id: string, reason: string) => {
    s.cancels.push({ id, reason })
  },
}))

const realPipeline = await import(`../src/dispatch/pipeline.ts?real=${Date.now()}`)
mock.module('../src/dispatch/pipeline.ts', () => ({
  ...realPipeline,
  isTokenLiveAnywhere: () => s.singleLive,
  hookMaxMsFromEnv: () => 7_200_000,
}))

const realBatch = await import(`../src/revanote/batch-dispatch.ts?real=${Date.now()}`)
mock.module('../src/revanote/batch-dispatch.ts', () => ({
  ...realBatch,
  isAnnotationLiveInBatch: () => (s.batchLive ? { sessionId: 's1', token: 't' } : null),
  batchRunMaxMs: () => 7_200_000,
}))

mock.module('../src/revanote/dispatcher.ts', () => ({
  dispatchAnnotationRow: async (ann: any) => {
    s.dispatched.push(ann)
    return { status: 'dispatched', run_id: 'r1', session_id: 's1' }
  },
  previewComment: (t: string, n = 30) => (t ?? '').slice(0, n),
}))

mock.module('../src/ws/registry.ts', () => ({ broadcastRevanoteEvent: () => {} }))

let app: Hono
beforeAll(async () => {
  const mod = await import('../src/api/revanote-webhook.ts')
  app = new Hono()
  app.route('/api/revanote', mod.revanoteWebhookRoutes)
})

beforeEach(() => {
  s.existing = null
  s.runs = []
  s.singleLive = false
  s.batchLive = false
  s.casResult = true
  s.resets = []
  s.cancels = []
  s.dispatched = []
})

const body = () => ({
  source: 'revanote',
  revanote_version: '1.0.0',
  annotation_id: 'ext-redeliver',
  annotation_url: 'https://app.revanote.com/review/p1#annotation-ext-redeliver',
  page_url: 'https://app.example.com/',
  screenshot_url: 'https://shots/1.png',
  x: 1, y: 2,
  element_selector: 'h1',
  comment: 'fix the heading',
  callback_url: 'https://app.revanote.com/api/agent-callbacks',
})

function existingRow(status: string) {
  return {
    id: 'ann-1', user_id: USER, annotation_id_external: 'ext-redeliver', status,
    received_at: new Date(Date.now() - 6 * 3_600_000).toISOString(), payload_raw: {},
  }
}

async function post() {
  const res = await app.request(`/api/revanote/webhook/${USER}/${SECRET}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body()),
  })
  // dispatch is fire-and-forget after the response
  await new Promise((r) => setTimeout(r, 10))
  return res
}

describe('webhook re-delivery of a known annotation', () => {
  test('stranded dispatched row (run past ceiling) is reset to pending, run cancelled, dispatched', async () => {
    s.existing = existingRow('dispatched')
    s.runs = [{ status: 'in_flight', started_at: new Date(Date.now() - 3 * 3_600_000).toISOString() }]
    const res = await post()
    expect(res.status).toBe(202)
    expect(s.resets).toEqual([{ id: 'ann-1', expected: 'dispatched', reason: 'source_redelivered' }])
    expect(s.cancels).toEqual([{ id: 'ann-1', reason: 'superseded_by_retry' }])
    expect(s.dispatched.length).toBe(1)
    expect(s.dispatched[0].status).toBe('pending')
  })

  test('failed row is reopened and dispatched as pending', async () => {
    s.existing = existingRow('failed')
    await post()
    expect(s.resets.map((r) => r.expected)).toEqual(['failed'])
    expect(s.cancels).toEqual([])
    expect(s.dispatched[0].status).toBe('pending')
  })

  test('failed_offline row is reopened', async () => {
    s.existing = existingRow('failed_offline')
    await post()
    expect(s.resets.map((r) => r.expected)).toEqual(['failed_offline'])
    expect(s.dispatched[0].status).toBe('pending')
  })

  test('a live in-memory turn is never reset', async () => {
    s.existing = existingRow('dispatched')
    s.singleLive = true
    await post()
    expect(s.resets).toEqual([])
    expect(s.cancels).toEqual([])
    expect(s.dispatched[0].status).toBe('dispatched')
  })

  test('a live batch turn is never reset', async () => {
    s.existing = existingRow('dispatched')
    s.batchLive = true
    await post()
    expect(s.resets).toEqual([])
  })

  test('a durable in_flight run within its ceiling is never reset (hub restarted mid-turn)', async () => {
    s.existing = existingRow('dispatched')
    s.runs = [{ status: 'in_flight', started_at: new Date(Date.now() - 10 * 60_000).toISOString() }]
    await post()
    expect(s.resets).toEqual([])
    expect(s.dispatched[0].status).toBe('dispatched')
  })

  test('resolved and archived rows are never reopened by a machine re-send', async () => {
    for (const status of ['resolved', 'archived']) {
      s.resets = []
      s.dispatched = []
      s.existing = existingRow(status)
      await post()
      expect(s.resets).toEqual([])
    }
  })

  test('a lost CAS (concurrent claim) leaves the row as observed', async () => {
    s.existing = existingRow('failed')
    s.casResult = false
    await post()
    expect(s.resets.length).toBe(1)
    expect(s.dispatched[0].status).toBe('failed')
  })

  test('a fresh annotation takes the old path untouched', async () => {
    const res = await post()
    expect(res.status).toBe(202)
    expect(s.resets).toEqual([])
    expect(s.dispatched[0].status).toBe('pending')
  })
})
