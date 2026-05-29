/**
 * B2 (obs): hub self-capture tests.
 *
 * Verifies:
 *   1. Synthetic exception → row persisted via insertError.
 *   2. dispatchPendingError is NEVER called for self-errors.
 *   3. Two identical throws → second hits the dedupe gate (status='deduped').
 *
 * DAL + WS registry are mocked so no Postgres / no live WS needed.
 */
import { describe, test, expect, beforeEach, afterAll, mock } from 'bun:test'

// Cache-bust + grab real exports so partial mocks below don't strip
// other functions (e.g. ensureSupervisorProject) that sibling test files
// import from the same module. Per Bun mock.module pollution pattern.
const realErrorCaptureDal = await import(`../src/db/error-capture-dal.ts?bust=${Date.now()}`)
const realDal = await import(`../src/db/dal.ts?bust=${Date.now()}`)
const realWsReg = await import(`../src/ws/registry.ts?bust=${Date.now()}`)

const TEST_USER = '233c6d63-5f44-43f4-9eae-efc34a00735a'

type Row = {
  id: string
  project_id: string
  fingerprint: string
  error_type: string
  error_value: string
  stacktrace_json: any
  release: string | null
  received_at: string
  dispatch_status: string
  dispatched_at: string | null
  skip_reason: string | null
}

const mockState: {
  selfProject: any
  rows: Row[]
  dispatchCalls: number
  broadcasts: any[]
} = {
  selfProject: {
    id: 'proj-self',
    user_id: TEST_USER,
    name: 'Hub self-capture',
    sentry_key: '__hub_self__',
    session_id: null,
    dedupe_window_seconds: 300,
    rate_limit_per_hour: 60,
    daily_dispatch_cap: 1000,
    enabled: true,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
  rows: [],
  dispatchCalls: 0,
  broadcasts: [],
}

let rowSeq = 0
mock.module('../src/db/error-capture-dal.ts', () => ({
  ...realErrorCaptureDal,
  ensureSelfProject: async (_userId: string) => mockState.selfProject,
  insertError: async (projectId: string, fields: any) => {
    rowSeq += 1
    const row: Row = {
      id: `err-${rowSeq}`,
      project_id: projectId,
      fingerprint: fields.fingerprint,
      error_type: fields.error_type,
      error_value: fields.error_value,
      stacktrace_json: fields.stacktrace_json ?? [],
      release: fields.release ?? null,
      received_at: new Date().toISOString(),
      dispatch_status: fields.dispatch_status ?? 'pending',
      dispatched_at: null,
      skip_reason: fields.skip_reason ?? null,
    }
    mockState.rows.push(row)
    return row
  },
  findRecentErrorByFingerprint: async (projectId: string, fp: string, _win: number) => {
    // Return the FIRST row matching this fingerprint (older). recordError
    // ignores it when its id matches the just-inserted row.
    return mockState.rows.find((r) => r.project_id === projectId && r.fingerprint === fp) ?? null
  },
  countErrorsInLastHour: async (projectId: string) =>
    mockState.rows.filter((r) => r.project_id === projectId).length,
  countDispatchesToday: async () => 0,
  updateErrorDispatchStatus: async (id: string, status: string, reason: string | null) => {
    const r = mockState.rows.find((x) => x.id === id)
    if (r) {
      r.dispatch_status = status
      r.skip_reason = reason
    }
  },
}))

mock.module('../src/db/dal.ts', () => ({
  ...realDal,
  getUserTimezone: async () => 'UTC',
}))

mock.module('../src/error-capture/notify.ts', () => ({
  notifyThrottled: async () => {},
}))

mock.module('../src/error-capture/dispatcher.ts', () => ({
  dispatchPendingError: async () => {
    mockState.dispatchCalls += 1
  },
}))

mock.module('../src/ws/registry.ts', () => ({
  ...realWsReg,
  broadcastErrorEvent: (_userId: string, event: any) => {
    mockState.broadcasts.push(event)
  },
}))

// Import AFTER mocks installed.
const { installSelfCapture, captureSelfError, _resetForTest } = await import(
  '../src/observability/self-capture'
)
const { Hono } = await import('hono')

beforeEach(() => {
  mockState.rows = []
  mockState.dispatchCalls = 0
  mockState.broadcasts = []
  rowSeq = 0
  _resetForTest()
})

describe('hub self-capture', () => {
  afterAll(() => mock.restore())

  test('install no-ops when HUB_SELF_OWNER_USER_ID unset', async () => {
    const app = new Hono()
    const ok = await installSelfCapture(app, '')
    expect(ok).toBe(false)
    await captureSelfError(new Error('boom'), 'test')
    expect(mockState.rows.length).toBe(0)
  })

  test('synthetic exception persists row and skips dispatch', async () => {
    const app = new Hono()
    const ok = await installSelfCapture(app, TEST_USER)
    expect(ok).toBe(true)

    await captureSelfError(new Error('explode at line 42'), 'uncaughtException')

    expect(mockState.rows.length).toBe(1)
    const row = mockState.rows[0]
    expect(row.project_id).toBe('proj-self')
    expect(row.error_type).toBe('Error [uncaughtException]')
    expect(row.error_value).toBe('explode at line 42')
    expect(row.dispatch_status).toBe('skipped')
    expect(row.skip_reason).toBe('no_dispatch')
    expect(mockState.dispatchCalls).toBe(0)
  })

  test('identical second throw is deduped (same fingerprint)', async () => {
    const app = new Hono()
    await installSelfCapture(app, TEST_USER)

    const mkErr = () => {
      const e = new Error('repeated failure')
      e.stack = `Error: repeated failure
    at fn (/app/hub/src/foo.ts:10:5)
    at bar (/app/hub/src/baz.ts:20:3)`
      return e
    }

    await captureSelfError(mkErr(), 'uncaughtException')
    await captureSelfError(mkErr(), 'uncaughtException')

    expect(mockState.rows.length).toBe(2)
    expect(mockState.rows[0].fingerprint).toBe(mockState.rows[1].fingerprint)
    // First passes all gates → skipped (no_dispatch). Second hits dedupe.
    expect(mockState.rows[0].dispatch_status).toBe('skipped')
    expect(mockState.rows[1].dispatch_status).toBe('deduped')
    expect(mockState.dispatchCalls).toBe(0)
  })

  test('non-Error throws (strings, objects) still capture', async () => {
    const app = new Hono()
    await installSelfCapture(app, TEST_USER)
    await captureSelfError('plain string failure', 'unhandledRejection')
    await captureSelfError({ code: 500, msg: 'obj' }, 'unhandledRejection')
    expect(mockState.rows.length).toBe(2)
    expect(mockState.rows[0].error_value).toBe('plain string failure')
    expect(mockState.rows[1].error_value).toContain('500')
  })
})
