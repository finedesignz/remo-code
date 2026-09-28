/**
 * Revanote batch dispatch tests (feat/revanote-batch-dispatch).
 *
 * Proves the batch coalescer end to end against the mocked DB + ws registry +
 * shared dispatch pipeline (same mocking pattern as revanote-dispatch.test.ts):
 *
 *   1. 3 annotations sharing a batch_id -> ONE dispatch, ONE prompt fencing
 *      all 3 items.
 *   2. Debounce resets on a new arrival (extends the window from the LATEST
 *      received_at, not the first).
 *   3. Array reply finalizes all 3 members, each through the real per-item
 *      commit-verify gate (mocked GitHub).
 *   4. A member omitted from the reply's `annotations[]` array finalizes
 *      resolved:false / missing_from_reply.
 *   5. An unparseable batch reply fails every member (mirrors the single-path
 *      parse-failure fallback).
 *   6. An annotation with NO batch_id stays on the single (non-batched) path.
 *   7. Manual retry (`forceSingle`) bypasses batch coalescing even when a
 *      batch_id is present.
 *   8. A batch turn is not force-finalized by the single path's 20min
 *      narration timeout — it uses its own (longer) ceiling.
 */
import { describe, test, expect, beforeEach, afterAll, mock } from 'bun:test'

const realDal = await import(`../src/db/dal.ts?bust=${Date.now()}`)
const realRevDal = await import(`../src/db/revanote-dal.ts?bust=${Date.now()}`)

const MAPPING = {
  id: 'map-1',
  user_id: 'user-1',
  hostname_pattern: 'demo.example.com',
  repo_path: '/repos/demo',
  supervisor_id: null,
  deploy_strategy: 'pr' as const,
  auto_merge: false,
  trusted: false,
  enabled: true,
  auto_created: false,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
}

function makeAnnotation(over: Partial<any> = {}) {
  const extId = over.annotation_id_external ?? 'ext-1'
  return {
    id: over.id ?? 'ann-1',
    user_id: 'user-1',
    annotation_id_external: extId,
    page_url: 'https://demo.example.com/page',
    annotation_url: null,
    screenshot_url: null,
    x: null,
    y: null,
    element_selector: null,
    comment: `fix comment for ${extId}`,
    replies_json: [],
    callback_url: 'https://revanote.app/cb',
    mapping_id: null,
    session_id: null,
    status: 'pending',
    skip_reason: null,
    source_ip: null,
    payload_raw: { installation_id: 999, repo_slug: 'owner/repo' },
    received_at: new Date().toISOString(),
    dispatched_at: null,
    resolved_at: null,
    ...over,
  }
}

const state: {
  pendingAnnotations: any[]
  runs: Array<{ id: string; annotation_id: string; status: string; resolved?: boolean | null }>
  annStatus: Array<{ id: string; status: string; opts: any }>
  broadcasts: any[]
  sentFrames: any[]
  callbacks: any[]
  offlineSessions: Set<string>
  resolvedSession: { id: string } | null
} = {
  pendingAnnotations: [],
  runs: [],
  annStatus: [],
  broadcasts: [],
  sentFrames: [],
  callbacks: [],
  offlineSessions: new Set(),
  resolvedSession: { id: 'sess-1' },
}

let runSeq = 0

mock.module('../src/db/postgres.ts', () => ({
  sql: async (strings: TemplateStringsArray) => {
    const text = strings.join('')
    if (text.includes("payload_raw ? 'batch_id'")) {
      return state.pendingAnnotations.filter((a) => a.status === 'pending' && a.payload_raw?.batch_id)
    }
    if (text.includes('user_id FROM annotations')) return [{ user_id: 'user-1' }]
    if (text.includes('AS tz')) return [{ tz: 'UTC' }]
    if (text.includes('revanote_budget_pct')) return [{ cap: '10', pct: 100 }]
    if (text.includes('daily_cost_cap_usd::text AS cap')) return [{ cap: '10' }]
    return []
  },
}))

mock.module('../src/db/revanote-dal.ts', () => ({
  ...realRevDal,
  resolveRevanoteMappingForHost: async () => MAPPING,
  getAnnotationById: async (id: string) => state.pendingAnnotations.find((a) => a.id === id) ?? null,
  sumTodayAnnotationCostForUser: async () => 0,
  insertAnnotationRun: async (opts: any) => {
    runSeq++
    const run = { id: `run-${runSeq}`, annotation_id: opts.annotation_id, status: 'in_flight' }
    state.runs.push(run)
    return run
  },
  updateAnnotationRun: async (id: string, patch: any) => {
    const run = state.runs.find((r) => r.id === id)
    if (run) Object.assign(run, patch)
    return run ?? null
  },
  updateAnnotationStatus: async (id: string, status: string, opts: any = {}) => {
    state.annStatus.push({ id, status, opts })
    const ann = state.pendingAnnotations.find((a) => a.id === id)
    if (ann) ann.status = status
  },
}))

mock.module('../src/db/dal.ts', () => ({
  ...realDal,
  findSessionByProjectDir: async () => state.resolvedSession,
  insertMessage: async () => ({ id: 'msg-1', created_at: new Date().toISOString() }),
}))

mock.module('../src/ws/registry.ts', () => ({
  getChannel: (sid: string) =>
    state.offlineSessions.has(sid) ? null : { ws: { send: (f: string) => state.sentFrames.push(JSON.parse(f)) } },
  broadcastRevanoteEvent: (_uid: string, ev: any) => state.broadcasts.push(ev),
  broadcastToSubscribers: () => {},
}))

mock.module('../src/revanote/callback.ts', () => ({
  scheduleImmediateCallback: async (ann: any, payload: any) => {
    state.callbacks.push({ ann_id: ann.id, payload })
  },
  startRevanoteCallbackWorker: () => {},
  stopRevanoteCallbackWorker: () => {},
}))

mock.module('../src/auth/github-app.ts', () => ({
  githubApiRequest: async (_installationId: number, _method: string, path: string) => {
    if (/\/repos\/[^/]+\/[^/]+$/.test(path)) return { default_branch: 'main' }
    if (path.includes('/compare/')) return { status: 'identical' }
    return { sha: 'realsha123' }
  },
  GitHubApiError: class GitHubApiError extends Error {
    status: number
    body: string
    constructor(status: number, body: string, msg: string) {
      super(msg)
      this.status = status
      this.body = body
    }
  },
}))

mock.module('../src/dispatch/gates.ts', () => ({
  thresholdGate: { name: 'threshold', async check() { return { ok: true } } },
  dailyCostCapGate: { name: 'daily_cost_cap', async check() { return { ok: true } } },
  dailyTokenCapGate: { name: 'daily_token_cap', async check() { return { ok: true } } },
  sessionInjectRateGate: { name: 'session_inject_rate', async check() { return { ok: true } } },
}))

const { dispatchPendingAnnotation } = await import('../src/revanote/dispatcher.ts')
const { onSessionReply, _reset } = await import('../src/dispatch/pipeline.ts')
const { sweepBatchDispatch, batchDebounceMs, batchRunMaxMs, _resetBatchDispatchState } = await import(
  '../src/revanote/batch-dispatch.ts'
)

const realNow = Date.now
let clockOffset = 0

beforeEach(() => {
  state.pendingAnnotations = []
  state.runs = []
  state.annStatus = []
  state.broadcasts = []
  state.sentFrames = []
  state.callbacks = []
  state.offlineSessions = new Set()
  state.resolvedSession = { id: 'sess-1' }
  runSeq = 0
  clockOffset = 0
  Date.now = () => realNow() + clockOffset
  _reset()
  _resetBatchDispatchState()
})

function envAgo(ms: number): string {
  return new Date(Date.now() - ms).toISOString()
}

describe('revanote batch dispatch — coalescing', () => {
  afterAll(() => {
    mock.restore()
    Date.now = realNow
  })

  test('3 annotations sharing a batch_id -> ONE dispatch, ONE prompt fencing all 3', async () => {
    const debounce = batchDebounceMs()
    state.pendingAnnotations = ['ext-1', 'ext-2', 'ext-3'].map((extId, i) =>
      makeAnnotation({
        id: `ann-${i + 1}`,
        annotation_id_external: extId,
        payload_raw: { installation_id: 999, repo_slug: 'owner/repo', batch_id: 'b1' },
        received_at: envAgo(debounce + 1000),
      }),
    )

    const result = await sweepBatchDispatch()
    expect(result.dispatched).toBe(1)

    // One annotation_run PER member (3), but ONE prompt frame for the batch.
    expect(state.runs).toHaveLength(3)
    expect(state.sentFrames).toHaveLength(1)
    expect(state.sentFrames[0].type).toBe('user_message')
    for (const extId of ['ext-1', 'ext-2', 'ext-3']) {
      expect(state.sentFrames[0].content).toContain(extId)
    }

    // Every member marked dispatched.
    const dispatchedIds = state.annStatus.filter((s) => s.status === 'dispatched').map((s) => s.id)
    expect(dispatchedIds.sort()).toEqual(['ann-1', 'ann-2', 'ann-3'])
  })

  test('debounce resets on a new arrival (extends from the LATEST received_at)', async () => {
    const debounce = batchDebounceMs()
    state.pendingAnnotations = [
      makeAnnotation({ id: 'ann-1', annotation_id_external: 'ext-1', payload_raw: { batch_id: 'b2' }, received_at: envAgo(5000) }),
    ]

    // Still well within the debounce window -> not dispatched yet.
    let result = await sweepBatchDispatch()
    expect(result.dispatched).toBe(0)
    expect(state.runs).toHaveLength(0)

    // A NEW arrival lands, resetting the group's latest received_at.
    state.pendingAnnotations.push(
      makeAnnotation({ id: 'ann-2', annotation_id_external: 'ext-2', payload_raw: { batch_id: 'b2' }, received_at: envAgo(1000) }),
    )

    // Advance the clock partway through the NEW debounce window -> still not due.
    clockOffset += debounce - 2000
    result = await sweepBatchDispatch()
    expect(result.dispatched).toBe(0)
    expect(state.runs).toHaveLength(0)

    // Advance past the full debounce window measured from the LATEST arrival.
    clockOffset += 5000
    result = await sweepBatchDispatch()
    expect(result.dispatched).toBe(1)
    expect(state.runs).toHaveLength(2)
  })

  test('no batch_id -> stays on the single (non-batched) dispatch path', async () => {
    state.pendingAnnotations = [makeAnnotation({ id: 'ann-solo', annotation_id_external: 'ext-solo', payload_raw: {} })]

    const out = await dispatchPendingAnnotation('ann-solo')
    expect(out.status).toBe('dispatched')
    expect(state.runs).toHaveLength(1)
    expect(state.sentFrames).toHaveLength(1)
  })

  test('manual retry (forceSingle) bypasses batch coalescing even with a batch_id present', async () => {
    state.pendingAnnotations = [
      makeAnnotation({
        id: 'ann-retry',
        annotation_id_external: 'ext-retry',
        payload_raw: { batch_id: 'b3' },
      }),
    ]

    // Without forceSingle, a batch-carrying annotation defers (stays pending).
    const deferred = await dispatchPendingAnnotation('ann-retry')
    expect(deferred).toEqual({ status: 'queued' })
    expect(state.runs).toHaveLength(0)

    // forceSingle dispatches it immediately, ignoring batch_id.
    const forced = await dispatchPendingAnnotation('ann-retry', { forceSingle: true })
    expect(forced.status).toBe('dispatched')
    expect(state.runs).toHaveLength(1)
  })
})

describe('revanote batch dispatch — finalize', () => {
  afterAll(() => {
    mock.restore()
    Date.now = realNow
  })

  async function dispatchBatchOf3() {
    const debounce = batchDebounceMs()
    state.pendingAnnotations = ['ext-1', 'ext-2', 'ext-3'].map((extId, i) =>
      makeAnnotation({
        id: `ann-${i + 1}`,
        annotation_id_external: extId,
        payload_raw: { installation_id: 999, repo_slug: 'owner/repo', batch_id: 'b1' },
        received_at: envAgo(debounce + 1000),
      }),
    )
    await sweepBatchDispatch()
  }

  test('array reply finalizes all 3 members through the per-item commit-verify gate', async () => {
    await dispatchBatchOf3()

    const envelope =
      '<<JSON>>\n' +
      JSON.stringify({
        annotations: [
          { annotation_id: 'ext-1', resolved: true, action_taken: 'fixed', files_changed: ['a.tsx'], commit_sha: 'realsha123', deployed: true },
          { annotation_id: 'ext-2', resolved: true, action_taken: 'fixed', files_changed: ['b.tsx'], commit_sha: 'realsha123', deployed: true },
          { annotation_id: 'ext-3', resolved: false, action_taken: 'could not repro', needs_clarification: true, clarification_question: 'which page?' },
        ],
      }) +
      '\n<<END>>'

    await onSessionReply('sess-1', envelope)

    const resolvedIds = state.annStatus.filter((s) => s.status === 'resolved').map((s) => s.id)
    expect(resolvedIds.sort()).toEqual(['ann-1', 'ann-2'])
    const failedIds = state.annStatus.filter((s) => s.status === 'failed').map((s) => s.id)
    expect(failedIds).toEqual(['ann-3'])
    expect(state.callbacks).toHaveLength(3)
    expect(state.callbacks.every((c) => typeof c.payload.annotation_id === 'string')).toBe(true)
  })

  test('a member omitted from the reply array finalizes resolved:false / missing_from_reply', async () => {
    await dispatchBatchOf3()

    const envelope =
      '<<JSON>>\n' +
      JSON.stringify({
        annotations: [
          { annotation_id: 'ext-1', resolved: true, action_taken: 'fixed', files_changed: [], commit_sha: 'realsha123', deployed: true },
          { annotation_id: 'ext-2', resolved: true, action_taken: 'fixed', files_changed: [], commit_sha: 'realsha123', deployed: true },
          // ext-3 omitted entirely.
        ],
      }) +
      '\n<<END>>'

    await onSessionReply('sess-1', envelope)

    const missing = state.annStatus.filter((s) => s.id === 'ann-3')
    expect(missing.some((s) => s.status === 'failed' && String(s.opts.skip_reason).includes('missing_from_reply'))).toBe(true)
  })

  test('an unparseable batch reply fails every member', async () => {
    await dispatchBatchOf3()

    // Envelope markers present (so the pipeline's shouldFinalize gate actually
    // finalizes this turn) but the JSON body is garbage -- mirrors the single
    // path's `invalid_json` fallback.
    await onSessionReply('sess-1', '<<JSON>>\nthis is not valid json at all\n<<END>>')

    for (const id of ['ann-1', 'ann-2', 'ann-3']) {
      expect(state.annStatus.some((s) => s.id === id && s.status === 'failed')).toBe(true)
    }
  })

  test('a batch turn is NOT force-finalized by the single path\'s 20min narration timeout', async () => {
    await dispatchBatchOf3()
    expect(batchRunMaxMs()).toBeGreaterThan(20 * 60 * 1000)

    // Advance 21 minutes -- past the single-path's default 20min
    // finalizeTimeoutMs, but well under the batch's own (2h default) ceiling.
    clockOffset += 21 * 60 * 1000
    await onSessionReply('sess-1', 'Still working on the fixes, hang tight.')

    // Narration-only message with no envelope must NOT force-finalize a
    // batch turn at 21 minutes -- no member should have resolved/failed yet.
    expect(state.annStatus.some((s) => s.status === 'resolved' || s.status === 'failed')).toBe(false)
  })
})
