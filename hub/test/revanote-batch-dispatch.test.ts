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

// C5 harness: a second, TRUSTED mapping for a different host, so a batch
// whose members span both hosts (but resolve to the SAME session -- the prod
// shape: ~23 client sites, each with its own mapping, sharing one session)
// exercises the mapping-aware sub-group.
const TRUSTED_MAPPING = {
  ...MAPPING,
  id: 'map-trusted',
  hostname_pattern: 'trusted.example.com',
  repo_path: '/repos/trusted',
  deploy_strategy: 'direct' as const,
  auto_merge: true,
  trusted: true,
}

const MAPPINGS_BY_HOST: Record<string, typeof MAPPING> = {
  'demo.example.com': MAPPING,
  'trusted.example.com': TRUSTED_MAPPING,
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
  dispatchedCallCount: number
  crashOnNthDispatchedCall: number | null
  gateFirstMappingCall: boolean
  mappingGateArmed: boolean
  releaseMappingGate: (() => void) | null
  sessionByRepoPath: Record<string, { id: string }> | null
  /** Q1 harness: awaited inside insertAnnotationRun (between claim and in-flight registration). */
  onInsertRun: (() => Promise<void>) | null
} = {
  pendingAnnotations: [],
  runs: [],
  annStatus: [],
  broadcasts: [],
  sentFrames: [],
  callbacks: [],
  offlineSessions: new Set(),
  resolvedSession: { id: 'sess-1' },
  dispatchedCallCount: 0,
  crashOnNthDispatchedCall: null,
  gateFirstMappingCall: false,
  mappingGateArmed: false,
  releaseMappingGate: null,
  sessionByRepoPath: null,
  onInsertRun: null,
}

mock.module('../src/auth/middleware.ts', () => ({
  authMiddleware: (c: any, next: () => Promise<void>) => {
    c.set('userId', 'user-1')
    return next()
  },
}))

let runSeq = 0

mock.module('../src/db/postgres.ts', () => ({
  sql: async (strings: TemplateStringsArray, ...values: any[]) => {
    const text = strings.join('')
    if (text.includes("payload_raw ? 'batch_id'")) {
      return state.pendingAnnotations.filter((a) => a.status === 'pending' && a.payload_raw?.batch_id)
    }
    // Atomic claim: `UPDATE annotations SET status = 'dispatched' WHERE id =
    // ANY(...) AND status = 'pending' RETURNING id` — models the real
    // conditional UPDATE against the shared in-memory row set so a race
    // between two callers (a sweep tick vs. a forceSingle retry) resolves
    // deterministically: whichever call reaches this branch first flips the
    // row and wins it; the loser sees it already non-'pending' and gets it
    // filtered out of its own result.
    if (text.includes("SET status = 'dispatched'")) {
      const ids: string[] = values[0] ?? []
      const claimed: { id: string }[] = []
      for (const id of ids) {
        const ann = state.pendingAnnotations.find((a) => a.id === id)
        if (ann && ann.status === 'pending') {
          ann.status = 'dispatched'
          claimed.push({ id })
        }
      }
      return claimed
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
  resolveRevanoteMappingForHost: async (_userId: string, host: string) => {
    // F4 race harness: when armed, the FIRST caller to reach this shared
    // lookup (retry's dispatchAnnotationRow or the sweep's per-member
    // resolveMappingAndSession -- whichever the JS scheduler happens to
    // reach first) is parked here until the test explicitly releases it,
    // so the OTHER (unpaused) caller can race ahead and fully dispatch
    // first -- deterministically reproducing "a sweep tick lands in the
    // gap while retry is mid-flight" regardless of which one the scheduler
    // happened to start first.
    if (state.gateFirstMappingCall && !state.mappingGateArmed) {
      state.mappingGateArmed = true
      await new Promise<void>((resolve) => {
        state.releaseMappingGate = resolve
      })
    }
    return MAPPINGS_BY_HOST[host] ?? MAPPING
  },
  getAnnotationById: async (id: string) => state.pendingAnnotations.find((a) => a.id === id) ?? null,
  sumTodayAnnotationCostForUser: async () => 0,
  // Real SQL is a conditional UPDATE ... WHERE status = $expected RETURNING.
  resetAnnotationToPendingIfStatus: async (id: string, expected: string, skip_reason: string) => {
    const ann = state.pendingAnnotations.find((a) => a.id === id)
    if (!ann || ann.status !== expected) return false
    ann.status = 'pending'
    ann.skip_reason = skip_reason
    return true
  },
  insertAnnotationRun: async (opts: any) => {
    if (state.onInsertRun) {
      const hook = state.onInsertRun
      state.onInsertRun = null // fire once, at the first member's run insert
      await hook()
    }
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
    if (status === 'dispatched') {
      state.dispatchedCallCount++
      if (state.crashOnNthDispatchedCall != null && state.dispatchedCallCount === state.crashOnNthDispatchedCall) {
        throw new Error('simulated crash mid per-member dispatched-status loop')
      }
    }
    state.annStatus.push({ id, status, opts })
    const ann = state.pendingAnnotations.find((a) => a.id === id)
    if (ann) ann.status = status
  },
}))

mock.module('../src/db/dal.ts', () => ({
  ...realDal,
  findSessionByProjectDir: async (_userId: string, repoPath: string) =>
    state.sessionByRepoPath?.[repoPath] ?? state.resolvedSession,
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

// The finalize path verifies via commit-verify's DB-backed context + real GitHub
// getter; pin both so this file tests dispatch wiring, not the verify gate.
const realCommitVerify = await import(`../src/revanote/commit-verify.ts?bust=${Date.now()}`)
mock.module('../src/revanote/commit-verify.ts', () => ({
  ...realCommitVerify,
  loadVerifyContext: async () => ({ owner: 'acme', repo: 'site', installationIds: [1] }),
  realGithubGet: async (_i: number, path: string) => {
    if (/\/repos\/[^/]+\/[^/]+$/.test(path)) return { default_branch: 'main' }
    if (path.includes('/compare/')) return { status: 'identical' }
    return { sha: 'c0ffee1'.padEnd(40, '0') }
  },
}))

mock.module('../src/auth/github-app.ts', () => ({
  githubApiRequest: async (_installationId: number, _method: string, path: string) => {
    if (/\/repos\/[^/]+\/[^/]+$/.test(path)) return { default_branch: 'main' }
    if (path.includes('/compare/')) return { status: 'identical' }
    return { sha: 'c0ffee1' }
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
  state.dispatchedCallCount = 0
  state.crashOnNthDispatchedCall = null
  state.gateFirstMappingCall = false
  state.mappingGateArmed = false
  state.releaseMappingGate = null
  state.sessionByRepoPath = null
  state.onInsertRun = null
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

  test('F4: forceSingle retry racing a sweep tick over the same batch_id row dispatches at most once', async () => {
    const debounce = batchDebounceMs()
    state.pendingAnnotations = [
      makeAnnotation({
        id: 'ann-race',
        annotation_id_external: 'ext-race',
        payload_raw: { installation_id: 999, repo_slug: 'owner/repo', batch_id: 'brace' },
        received_at: envAgo(debounce + 1000),
      }),
    ]

    // Simulate the retry endpoint's reset-to-pending + forceSingle dispatch
    // racing a concurrent sweep tick over the SAME still-pending,
    // batch_id-carrying row. Session-queue dedup is token-identity only
    // (token=annotation id on one side, token=batch_id on the other), so it
    // cannot catch this on its own -- only an atomic pre-send DB claim can.
    //
    // The harness arms a gate on the shared mapping lookup so whichever of
    // the two callers the JS scheduler happens to reach FIRST is parked;
    // the other (unpaused) caller races ahead and fully dispatches. Once it
    // has sent its frame, the parked caller is released and allowed to
    // finish too -- deterministically reproducing "a sweep tick lands in
    // the gap while retry is mid-flight" (or vice versa) regardless of
    // which one the scheduler actually started first.
    state.gateFirstMappingCall = true
    const p1 = dispatchPendingAnnotation('ann-race', { forceSingle: true })
    const p2 = sweepBatchDispatch()

    for (let i = 0; i < 50 && state.sentFrames.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    expect(state.sentFrames.length).toBe(1) // the unpaused (winning) caller sent first

    state.releaseMappingGate?.()
    await Promise.all([p1, p2])
    // The loser must not have sent a SECOND frame yet -- pre-fix it is merely
    // QUEUED behind the winner's in-flight session-queue slot (same session);
    // post-fix its own claim already failed and it never reached the queue.
    expect(state.sentFrames.length).toBe(1)

    // Finalize the winner's in-flight turn. This is the exact moment the bug
    // fires pre-fix: SessionQueue promotes whatever token was QUEUED behind
    // it and the pipeline sends for that promoted request DIRECTLY, without
    // ever re-checking the annotation's current DB status -- a second,
    // fully redundant dispatch for the same annotation.
    const finalizeEnvelope = ['<<JSON>>', JSON.stringify({ resolved: true, action_taken: 'fixed', files_changed: [], commit_sha: 'c0ffee1' }), '<<END>>'].join('\n')
    await onSessionReply('sess-1', finalizeEnvelope)

    expect(state.sentFrames.length).toBe(1) // still just the one -- no promoted duplicate send
    expect(state.runs.filter((r) => r.annotation_id === 'ann-race')).toHaveLength(1)
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
          { annotation_id: 'ext-1', resolved: true, action_taken: 'fixed', files_changed: ['a.tsx'], commit_sha: 'c0ffee1', deployed: true },
          { annotation_id: 'ext-2', resolved: true, action_taken: 'fixed', files_changed: ['b.tsx'], commit_sha: 'c0ffee1', deployed: true },
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
          { annotation_id: 'ext-1', resolved: true, action_taken: 'fixed', files_changed: [], commit_sha: 'c0ffee1', deployed: true },
          { annotation_id: 'ext-2', resolved: true, action_taken: 'fixed', files_changed: [], commit_sha: 'c0ffee1', deployed: true },
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

  test('F3: a single non-array object batch reply finalizes every member failed, never re-parsed as one verdict', async () => {
    await dispatchBatchOf3()

    // A single verdict shaped for ONE annotation, not the batch `{annotations:[...]}`
    // envelope. `parseRevanoteBatchOutput` must reject this (missing `annotations`
    // array), and the failure path must NEVER hand `content` to the single-item
    // parser -- that parser happily accepts this exact shape and would resolve
    // every member true from one verdict.
    const singleObjectReply = '<<JSON>>\n' + JSON.stringify({ resolved: true, commit_sha: 'c0ffee1' }) + '\n<<END>>'
    await onSessionReply('sess-1', singleObjectReply)

    for (const id of ['ann-1', 'ann-2', 'ann-3']) {
      const lastStatus = state.annStatus.filter((s) => s.id === id).pop()
      expect(lastStatus?.status).toBe('failed')
    }
    expect(state.annStatus.some((s) => s.status === 'resolved')).toBe(false)
  })
})

describe('revanote batch dispatch — atomic claim (F2)', () => {
  afterAll(() => {
    mock.restore()
    Date.now = realNow
  })

  test('F2: a crash mid per-member dispatched-status loop must not let a resweep re-dispatch the same batch', async () => {
    const debounce = batchDebounceMs()
    state.pendingAnnotations = ['ext-1', 'ext-2', 'ext-3'].map((extId, i) =>
      makeAnnotation({
        id: `ann-${i + 1}`,
        annotation_id_external: extId,
        payload_raw: { installation_id: 999, repo_slug: 'owner/repo', batch_id: 'bcrash' },
        received_at: envAgo(debounce + 1000),
      }),
    )

    // Simulate a crash right after member 1's per-member `updateAnnotationStatus
    // (ann.id, 'dispatched')` call succeeds, before member 2's runs.
    state.crashOnNthDispatchedCall = 2
    await expect(sweepBatchDispatch()).rejects.toThrow('simulated crash')

    // The single batch prompt frame already went out before the crash.
    expect(state.sentFrames).toHaveLength(1)

    // "Restart": a fresh sweep tick re-reads pending rows exactly like
    // runSweepOnce does after a real process restart. With the atomic
    // pre-send claim, ann-2/ann-3 were flipped pending -> dispatching BEFORE
    // that first send ever happened, so this tick must find nothing pending
    // for this batch and must NOT re-dispatch / re-send / insert a 2nd run.
    state.crashOnNthDispatchedCall = null
    const resweep = await sweepBatchDispatch()
    expect(resweep.dispatched).toBe(0)
    expect(state.sentFrames).toHaveLength(1)
    expect(state.runs.filter((r) => r.annotation_id === 'ann-2')).toHaveLength(1)
  })

  test('R2-1: a batch queued behind another in-flight send on the same session survives a hub restart still pending, and re-sweeps successfully', async () => {
    const debounce = batchDebounceMs()
    // Two single-member mapping groups sharing ONE session (the C5 shape) —
    // the pipeline's per-session queue serializes them: the first sends
    // immediately, the second is merely QUEUED (never claimed pre-fix would
    // have already flipped it to 'dispatching' before it ever reached the
    // queue).
    state.pendingAnnotations = [
      makeAnnotation({
        id: 'ann-q1',
        annotation_id_external: 'ext-q1',
        page_url: 'https://demo.example.com/page',
        payload_raw: { installation_id: 999, repo_slug: 'owner/repo-demo', batch_id: 'bqueue' },
        received_at: envAgo(debounce + 1000),
      }),
      makeAnnotation({
        id: 'ann-q2',
        annotation_id_external: 'ext-q2',
        page_url: 'https://trusted.example.com/page',
        payload_raw: { installation_id: 999, repo_slug: 'owner/repo-trusted', batch_id: 'bqueue' },
        received_at: envAgo(debounce + 1000),
      }),
    ]

    const result = await sweepBatchDispatch()
    expect(result.dispatched).toBe(2)
    expect(state.sentFrames).toHaveLength(1) // one sent, one queued behind it

    // The queued one's row must still be 'pending' — never claimed while
    // merely queued.
    const queuedAnn = state.pendingAnnotations.find((a) => a.status === 'pending')
    expect(queuedAnn).toBeDefined()

    // Simulate a hub restart: pipeline active-hook/waiter state AND the batch
    // coalescer's own in-flight bookkeeping are both gone.
    _reset()
    _resetBatchDispatchState()

    // A fresh sweep tick must now be able to dispatch the previously-queued
    // row on its own — it was never claimed, so it's exactly as
    // restart-recoverable as a plain 'pending' row.
    const resweep = await sweepBatchDispatch()
    expect(resweep.dispatched).toBe(1)
    expect(state.sentFrames).toHaveLength(2)
    expect(state.pendingAnnotations.every((a) => a.status === 'dispatched')).toBe(true)
  })
})

describe('revanote batch dispatch — per-target isolation (C3/C5)', () => {
  afterAll(() => {
    mock.restore()
    Date.now = realNow
  })

  test('C3: one batch_id spanning 2 sessions produces 2 dispatches, each reply finalizing only its own members', async () => {
    const debounce = batchDebounceMs()
    state.sessionByRepoPath = {
      '/repos/demo': { id: 'sess-a' },
      '/repos/trusted': { id: 'sess-b' },
    }
    state.pendingAnnotations = [
      makeAnnotation({
        id: 'ann-a1',
        annotation_id_external: 'ext-a1',
        page_url: 'https://demo.example.com/page',
        payload_raw: { installation_id: 999, repo_slug: 'owner/repo-a', batch_id: 'bsplit' },
        received_at: envAgo(debounce + 1000),
      }),
      makeAnnotation({
        id: 'ann-b1',
        annotation_id_external: 'ext-b1',
        page_url: 'https://trusted.example.com/page',
        payload_raw: { installation_id: 999, repo_slug: 'owner/repo-b', batch_id: 'bsplit' },
        received_at: envAgo(debounce + 1000),
      }),
    ]

    const result = await sweepBatchDispatch()
    expect(result.dispatched).toBe(2)
    expect(state.sentFrames).toHaveLength(2)

    const frameA = state.sentFrames.find((f) => f.content.includes('ext-a1'))
    const frameB = state.sentFrames.find((f) => f.content.includes('ext-b1'))
    expect(frameA).toBeDefined()
    expect(frameB).toBeDefined()
    // Each frame covers ONLY its own session's member -- the same raw
    // batch_id must not merge them into one prompt/token.
    expect(frameA!.content).not.toContain('ext-b1')
    expect(frameB!.content).not.toContain('ext-a1')

    // Each session's reply finalizes ONLY its own member -- proves the two
    // dispatches hold genuinely distinct tokens (a raw-batch_id key would
    // collide the two `inFlightBatches` entries and misroute/orphan one).
    const envelopeFor = (extId: string) =>
      '<<JSON>>\n' +
      JSON.stringify({ annotations: [{ annotation_id: extId, resolved: true, action_taken: 'fixed', files_changed: [], commit_sha: 'c0ffee1', deployed: true }] }) +
      '\n<<END>>'

    await onSessionReply('sess-a', envelopeFor('ext-a1'))
    expect(state.annStatus.some((s) => s.id === 'ann-a1' && s.status === 'resolved')).toBe(true)
    // ann-b1 was independently dispatched (its own status='dispatched' entry
    // exists), but finalizing sess-a's reply must NOT touch it -- a raw
    // batch_id key would collide the two `inFlightBatches` entries and
    // misroute this finalize onto the wrong (or both) session's members.
    expect(state.annStatus.some((s) => s.id === 'ann-b1' && s.status === 'resolved')).toBe(false)

    await onSessionReply('sess-b', envelopeFor('ext-b1'))
    expect(state.annStatus.some((s) => s.id === 'ann-b1' && s.status === 'resolved')).toBe(true)
  })

  test('C5: two mappings with different trust in the same session+batch_id produce 2 dispatches, untrusted gets the propose-only/pr plan', async () => {
    const debounce = batchDebounceMs()
    // Both resolve to the SAME session (state.resolvedSession, sessionByRepoPath
    // left null) -- the prod shape this defect actually hits: ~23 sites, each
    // its own mapping/trust, sharing one session.
    state.pendingAnnotations = [
      makeAnnotation({
        id: 'ann-untrusted',
        annotation_id_external: 'ext-untrusted',
        page_url: 'https://demo.example.com/page',
        payload_raw: { installation_id: 999, repo_slug: 'owner/repo-demo', batch_id: 'bmix' },
        received_at: envAgo(debounce + 1000),
      }),
      makeAnnotation({
        id: 'ann-trusted',
        annotation_id_external: 'ext-trusted',
        page_url: 'https://trusted.example.com/page',
        payload_raw: { installation_id: 999, repo_slug: 'owner/repo-trusted', batch_id: 'bmix' },
        received_at: envAgo(debounce + 1000),
      }),
    ]

    const result = await sweepBatchDispatch()
    // Both mapping groups are separately dispatched -- but they resolve to
    // the SAME session, so the pipeline's own per-session queue legitimately
    // serializes them to ONE immediate send; the second is QUEUED, not
    // dropped or merged. Finalizing the first promotes and sends the second.
    expect(result.dispatched).toBe(2)
    expect(state.sentFrames).toHaveLength(1)

    const firstIsUntrusted = state.sentFrames[0].content.includes('ext-untrusted')
    const finalizeJson = JSON.stringify({
      annotations: [
        {
          annotation_id: firstIsUntrusted ? 'ext-untrusted' : 'ext-trusted',
          resolved: true, action_taken: 'fixed', files_changed: [], commit_sha: 'c0ffee1', deployed: true,
        },
      ],
    })
    await onSessionReply('sess-1', ['<<JSON>>', finalizeJson, '<<END>>'].join('\n'))
    expect(state.sentFrames).toHaveLength(2)

    const untrustedFrame = state.sentFrames.find((f) => f.content.includes('ext-untrusted'))
    const trustedFrame = state.sentFrames.find((f) => f.content.includes('ext-trusted'))
    expect(untrustedFrame).toBeDefined()
    expect(trustedFrame).toBeDefined()

    // Each dispatched batch is single-mapping -- the untrusted member's
    // prompt must NOT inherit the trusted mapping's direct/auto-merge plan,
    // and vice versa.
    expect(untrustedFrame!.content).not.toContain('ext-trusted')
    expect(untrustedFrame!.content).toContain('Strategy: PR.')
    expect(untrustedFrame!.content).toContain('Leave the PR open for human review.')
    expect(untrustedFrame!.content).not.toContain('Strategy: DIRECT.')

    expect(trustedFrame!.content).not.toContain('ext-untrusted')
    expect(trustedFrame!.content).toContain('Strategy: DIRECT.')
  })
})


describe('revanote batch dispatch — Q1 retry vs batch send race', () => {
  afterAll(() => {
    mock.restore()
    Date.now = realNow
  })

  test('Q1: a retry landing between the claim commit and the run inserts is refused; exactly one send', async () => {
    const debounce = batchDebounceMs()
    state.pendingAnnotations = ['ext-1', 'ext-2'].map((extId, i) =>
      makeAnnotation({
        id: `ann-${i + 1}`,
        annotation_id_external: extId,
        payload_raw: { installation_id: 999, repo_slug: 'owner/repo', batch_id: 'b1' },
        received_at: envAgo(debounce + 1000),
      }),
    )
    let retryStatus = 0
    let statusDuringGap = ''
    state.onInsertRun = async () => {
      // The claim has committed: rows read 'dispatched', in-flight map not yet filled by the old code.
      statusDuringGap = state.pendingAnnotations[0].status
      const { revanoteAnnotations } = await import('../src/api/revanote-annotations.ts')
      const { Hono } = await import('hono')
      const app = new Hono()
      app.route('/api/revanote/annotations', revanoteAnnotations)
      const res = await app.request('/api/revanote/annotations/ann-1/retry', { method: 'POST' })
      retryStatus = res.status
    }

    await sweepBatchDispatch()

    expect(statusDuringGap).toBe('dispatched')
    expect(retryStatus).toBe(409)
    expect(state.sentFrames).toHaveLength(1)
  })
})
