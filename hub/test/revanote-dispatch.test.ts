/**
 * Revanote dispatch adapter tests (Round-2 migration).
 *
 * Proves the revanote adapter drives the shared dispatch pipeline end to end —
 * the same lifecycle the error-capture pilot proves, plus the revanote-specific
 * per-source budget gate and the onFinalize=envelope+callback wiring:
 *
 *   1. A dispatched annotation INSERTs an annotation_run (in_flight) via open()
 *      EXACTLY ONCE, broadcasts revanote_dispatched with the REAL run id, and
 *      sets the annotation status='dispatched'.
 *   2. onSessionReply (the agent assistant_message bridge) finalizes that run:
 *      parses the <<JSON>>…<<END>> envelope, marks the annotation resolved,
 *      and ENQUEUES the outbound callback (with annotation_id always present).
 *   3. The per-source revanote budget gate runs in the gate chain ON TOP of the
 *      cost cap: over-budget → skipped, no send, reject callback fired.
 *   4. The global cost cap remains non-bypassable (IR-1): over-cap → skipped,
 *      no send.
 *
 * DAL + postgres `sql` + ws registry + dal.insertMessage + callback are mocked
 * so no Postgres / no live WS is needed. The dispatch pipeline + gates-under-
 * test are REAL where it matters: the budget gate is the real
 * `revanoteBudgetGate` (driven by mocked sql); threshold + cost-cap are passed
 * through so the budget gate is exercised in isolation. We are testing the
 * ADAPTER↔PIPELINE wiring (open()→finalize lifecycle) + the budget DispatchGate.
 */
import { describe, test, expect, beforeEach, afterAll, mock } from 'bun:test'

const realDal = await import(`../src/db/dal.ts?bust=${Date.now()}`)
const realRevDal = await import(`../src/db/revanote-dal.ts?bust=${Date.now()}`)

function makeAnnotation(over: Partial<any> = {}) {
  return {
    id: 'ann-1',
    user_id: 'user-1',
    annotation_id_external: 'ext-abc',
    page_url: 'https://demo.example.com/page',
    annotation_url: 'https://revanote.app/a/ext-abc',
    screenshot_url: null,
    x: 10,
    y: 20,
    element_selector: '.btn',
    comment: 'fix this button',
    replies_json: [],
    callback_url: 'https://revanote.app/cb',
    mapping_id: 'map-1',
    session_id: 'sess-1',
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

const MAPPING = {
  id: 'map-1',
  user_id: 'user-1',
  hostname_pattern: 'demo.example.com',
  repo_path: '/repos/demo',
  supervisor_id: null,
  deploy_strategy: 'pr' as const,
  auto_merge: false,
  enabled: true,
  auto_created: false,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
}

const state: {
  runs: Array<{ id: string; annotation_id: string; status: string; resolved?: boolean | null; output_snippet?: string | null }>
  annStatus: Array<{ id: string; status: string; opts: any }>
  broadcasts: any[]
  sentFrames: any[]
  callbacks: any[]
  // controls the budget-gate / cost-cap sql responses.
  budgetPct: number
  todayCost: number
  costCap: number
  // sessions considered "offline" by the getChannel mock (dead/replaced ids).
  offlineSessions: Set<string>
  // what dal.findSessionByProjectDir resolves to (the "replacement" session).
  resolvedSession: { id: string } | null
  // session_id persisted on the annotation row returned by getAnnotationById.
  annSessionId: string
  // every id the pre-send claim (claimAnnotationsAtSend) was invoked with,
  // across every call — used to prove WHEN (relative to queueing) a claim
  // happens (R2-1).
  claimCalls: string[]
  // Q3 harness: when non-null, the claim models the real conditional UPDATE
  // (an id already in the set is NOT claimable; a successful claim adds it).
  claimed: Set<string> | null
  // Q3 harness: awaited inside insertAnnotationRun (between open() and send()).
  onOpen: (() => Promise<void>) | null
  // single-path markSkipped CAS outcome (false = a concurrent dispatch already resolved the row).
  failCas: boolean
  // Generation binding: annotation id -> current_run_id the send-time claim recorded.
  currentRun: Record<string, string>
} = {
  runs: [], annStatus: [], broadcasts: [], sentFrames: [], callbacks: [],
  budgetPct: 60, todayCost: 0, costCap: 10,
  offlineSessions: new Set(),
  resolvedSession: { id: 'sess-1' },
  annSessionId: 'sess-1',
  claimCalls: [],
  claimed: null,
  onOpen: null,
  failCas: true,
  currentRun: {},
}

let runSeq = 0

// postgres.sql is used by: peekUserIdForAnnotation, getUserTimezone,
// revanoteBudgetGate (cap+pct), sumTodayAnnotationCostForUser is its own DAL fn.
// We discriminate by the SQL text fragments.
mock.module('../src/db/postgres.ts', () => ({
  sql: async (strings: TemplateStringsArray, ...values: any[]) => {
    const text = strings.join('')
    if (text.includes('user_id FROM annotations')) return [{ user_id: 'user-1' }]
    if (text.includes('AS tz')) return [{ tz: 'UTC' }]
    if (text.includes('revanote_budget_pct')) return [{ cap: String(state.costCap), pct: state.budgetPct }]
    if (text.includes('daily_cost_cap_usd::text AS cap')) return [{ cap: String(state.costCap) }]
    // Atomic pre-send claim (qcfix/batch-claim) — this suite doesn't model
    // annotation row state across calls (getAnnotationById below always
    // returns a fresh synthetic 'pending' row), so every requested id is
    // claimable; concurrent-claim races are covered in
    // revanote-batch-dispatch.test.ts, which DOES share mutable row state.
    if (text.includes("SET status = 'dispatched'")) {
      const ids: string[] = values[0] ?? []
      state.claimCalls.push(...ids)
      // Generation binding: values[1] is the {annotation id -> run id} JSON map.
      if (typeof values[1] === 'string') Object.assign(state.currentRun, JSON.parse(values[1]))
      if (state.claimed) {
        const won = ids.filter((id) => !state.claimed!.has(id))
        for (const id of won) state.claimed.add(id)
        return won.map((id) => ({ id }))
      }
      return ids.map((id) => ({ id }))
    }
    return []
  },
}))

mock.module('../src/db/revanote-dal.ts', () => ({
  ...realRevDal,
  resolveRevanoteMappingForHost: async () => MAPPING,
  getAnnotationById: async (id: string) => makeAnnotation({ id, session_id: state.annSessionId }),
  sumTodayAnnotationCostForUser: async () => state.todayCost,
  insertAnnotationRun: async (opts: any) => {
    if (state.onOpen) {
      const hook = state.onOpen
      state.onOpen = null
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
  // Models the finalize CAS: `if_run_id` only wins while it is the row's current generation.
  updateAnnotationStatus: async (id: string, status: string, opts: any = {}) => {
    if (opts.if_run_id && state.currentRun[id] !== opts.if_run_id) return false
    state.annStatus.push({ id, status, opts })
    return true
  },
  // CAS helpers (real SQL: conditional UPDATEs) -- rows here are always in the expected state.
  parkAnnotationOfflineIfPending: async (id: string, session_id: string | null) => {
    state.annStatus.push({ id, status: 'pending', opts: { skip_reason: 'session_offline', session_id } })
    return true
  },
  expireParkedAnnotation: async (id: string) => {
    state.annStatus.push({ id, status: 'failed_offline', opts: { skip_reason: 'target_offline_expired' } })
    return true
  },
  recordDispatchIfDispatched: async (id: string, opts: any) => {
    state.annStatus.push({ id, status: 'dispatched', opts })
    return true
  },
  failAnnotationIfDispatched: async (id: string, skip_reason: string) => {
    state.annStatus.push({ id, status: 'failed', opts: { skip_reason } })
    return true
  },
  failAnnotationIfPending: async (id: string, skip_reason: string, session_id: string | null) => {
    if (!state.failCas) return false
    state.annStatus.push({ id, status: 'failed', opts: { skip_reason, session_id } })
    return true
  },
}))

// fix/revanote-verify-pushed — the finalize path now checks a resolved reply's
// commit on GitHub. Stub that lookup as "commit found" so these adapter tests
// keep exercising the happy path; the gate itself is covered in
// revanote-commit-verify.test.ts.
const realCommitVerify = await import(`../src/revanote/commit-verify.ts?bust=${Date.now()}`)
mock.module('../src/revanote/commit-verify.ts', () => ({
  ...realCommitVerify,
  loadVerifyContext: async () => ({ owner: 'acme', repo: 'site', installationIds: [1] }),
  realGithubGet: async (_i: number, path: string) => {
    if (/\/repos\/[^/]+\/[^/]+$/.test(path)) return { default_branch: 'main' }
    if (path.includes('/compare/')) return { status: 'identical' }
    return { sha: 'c0ffee'.padEnd(40, '0'), commit: { committer: { date: new Date(Date.now() + 1000).toISOString() } } }
  },
}))

mock.module('../src/db/dal.ts', () => ({
  ...realDal,
  findSessionByProjectDir: async () => state.resolvedSession,
  insertMessage: async () => ({ id: 'msg-1', created_at: new Date().toISOString() }),
}))

mock.module('../src/ws/registry.ts', () => ({
  getChannel: (sid: string) =>
    state.offlineSessions.has(sid)
      ? null
      : { ws: { send: (f: string) => state.sentFrames.push(JSON.parse(f)) } },
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

// commit-verify gate (fix/revanote-resolved-requires-pushed-sha): the annotation
// fixture above carries installation_id/repo_slug, so resolved:true replies that
// cite a commit_sha are verified against a mocked-green GitHub API here — this
// file is testing the dispatch/pipeline wiring, not the verify gate itself
// (covered by revanote-commit-verify.test.ts).
mock.module('../src/auth/github-app.ts', () => ({
  githubApiRequest: async (_installationId: number, _method: string, path: string) => {
    if (/\/repos\/[^/]+\/[^/]+$/.test(path)) return { default_branch: 'main' }
    if (path.includes('/compare/')) return { status: 'identical' }
    return { sha: 'realsha123', commit: { committer: { date: new Date(Date.now() + 1000).toISOString() } } }
  },
  GitHubApiError: class GitHubApiError extends Error {
    status: number
    body: string
    constructor(status: number, body: string, msg: string) { super(msg); this.status = status; this.body = body }
  },
}))

// Pass-through threshold + cost-cap so the REAL budget gate is what we exercise
// in the budget test. The budget gate itself is imported real from the adapter.
mock.module('../src/dispatch/gates.ts', () => ({
  thresholdGate: { name: 'threshold', async check() { return { ok: true } } },
  dailyCostCapGate: { name: 'daily_cost_cap', async check() {
    // Honor the cost cap so IR-1 stays testable through the real adapter path.
    if (state.costCap > 0 && state.todayCost >= state.costCap) {
      return { ok: false, reason: 'daily_cost_cap' }
    }
    return { ok: true }
  } },
  // fix/stop-the-bleed: the token cap now rides EVERY dispatch gate list.
  dailyTokenCapGate: { name: 'daily_token_cap', async check() { return { ok: true } } },
  // fix/self-heal-guards: inject-rate ceiling now rides the self-heal gate lists.
  sessionInjectRateGate: { name: 'session_inject_rate', async check() { return { ok: true } } },
}))

// Import AFTER mocks. Pipeline + the revanote adapter (incl. revanoteBudgetGate)
// are REAL — that's the wiring under test.
const { dispatchPendingAnnotation } = await import('../src/revanote/dispatcher.ts')
const { onSessionReply, _reset } = await import('../src/dispatch/pipeline.ts')

beforeEach(() => {
  state.runs = []
  state.annStatus = []
  state.broadcasts = []
  state.sentFrames = []
  state.callbacks = []
  state.budgetPct = 60
  state.todayCost = 0
  state.costCap = 10
  state.offlineSessions = new Set()
  state.resolvedSession = { id: 'sess-1' }
  state.annSessionId = 'sess-1'
  state.claimCalls = []
  state.claimed = null
  state.onOpen = null
  state.failCas = true
  state.currentRun = {}
  runSeq = 0
  _reset()
})

describe('revanote dispatch adapter — open()→finalize lifecycle', () => {
  afterAll(() => mock.restore())

  test('dispatched annotation inserts ONE annotation_run, broadcasts dispatched, finalizes + enqueues callback on reply', async () => {
    const out = await dispatchPendingAnnotation('ann-1')

    // open() fired EXACTLY once → one annotation_run; outcome has the real id.
    expect(state.runs).toHaveLength(1)
    expect(state.runs[0].id).toBe('run-1')
    expect(out).toEqual({ status: 'dispatched', run_id: 'run-1', session_id: 'sess-1' })

    // annotation marked dispatched.
    expect(state.annStatus.some((s) => s.status === 'dispatched')).toBe(true)

    // user_message frame sent on the agent socket.
    expect(state.sentFrames).toHaveLength(1)
    expect(state.sentFrames[0].type).toBe('user_message')

    // revanote_dispatched broadcast carries the real run id.
    const dispatched = state.broadcasts.find((b) => b.type === 'revanote_dispatched')
    expect(dispatched?.run_id).toBe('run-1')

    // No callback enqueued yet (dispatch succeeded, awaiting reply).
    expect(state.callbacks).toHaveLength(0)

    // Agent replies with an envelope → onSessionReply finalizes.
    await onSessionReply('sess-1', 'Done.\n<<JSON>>\n{"dispatch_id":"run-1","resolved":true,"action_taken":"fixed button","files_changed":["a.tsx"],"commit_sha":"c0ffee1","deployed":true}\n<<END>>')

    // run finalized success + resolved.
    expect(state.runs[0].status).toBe('success')
    expect(state.runs[0].resolved).toBe(true)

    // annotation resolved.
    expect(state.annStatus.some((s) => s.status === 'resolved')).toBe(true)

    // revanote_resolved broadcast.
    const resolved = state.broadcasts.find((b) => b.type === 'revanote_resolved')
    expect(resolved?.resolved).toBe(true)

    // Outbound callback enqueued with annotation_id ALWAYS present (invariant).
    expect(state.callbacks).toHaveLength(1)
    expect(state.callbacks[0].payload.annotation_id).toBe('ext-abc')
    expect(state.callbacks[0].payload.resolved).toBe(true)
    expect(state.callbacks[0].payload.files_changed).toEqual(['a.tsx'])
  })

  test('open() is NOT called for a queued (second) annotation until promotion', async () => {
    // First dispatch claims the in-flight slot.
    await dispatchPendingAnnotation('ann-1')
    expect(state.runs).toHaveLength(1)

    // Second (different) annotation on the same session → queued, no new run
    // row. Re-dispatching the SAME annotation while it is in flight is a no-op
    // (queue dedupes by token = annotation id), so this uses a distinct id.
    const out2 = await dispatchPendingAnnotation('ann-2')
    expect(out2).toEqual({ status: 'queued' })
    expect(state.runs).toHaveLength(1) // still one — queued waiter has NOT opened

    // First reply finalizes head + promotes waiter → re-dispatch opens run #2.
    await onSessionReply('sess-1', '<<JSON>>{"dispatch_id":"run-1","resolved":true}<<END>>')
    expect(state.runs).toHaveLength(2)
    expect(state.runs[1].id).toBe('run-2')
  })

  test('R2-1: a queued annotation is never claimed and survives a hub restart (_reset) fully dispatchable', async () => {
    // First dispatch claims the in-flight slot for sess-1.
    await dispatchPendingAnnotation('ann-1')
    expect(state.runs).toHaveLength(1)

    // A second, distinct annotation on the SAME session queues behind it.
    const out2 = await dispatchPendingAnnotation('ann-2')
    expect(out2).toEqual({ status: 'queued' })

    // The queued annotation must NEVER have been claimed — the claim only
    // happens inside deps.send(), which a merely-queued request never
    // reaches. Pre-fix, the claim ran unconditionally BEFORE dispatch() was
    // even called, so ann-2 would already appear in claimCalls here.
    expect(state.claimCalls).not.toContain('ann-2')
    expect(state.annStatus.some((s) => s.id === 'ann-2')).toBe(false)

    // Simulate a hub restart: the pipeline's in-memory active-hook + waiter
    // state is gone (this is exactly what stranded a claimed-but-unsent row
    // forever pre-fix — nothing ever resets 'dispatching' back to 'pending').
    _reset()

    // Because ann-2 was never claimed, it is still 'pending' in the DB and a
    // fresh dispatch attempt for it must succeed outright (not `noop:
    // already_claimed`, not stuck) — proving restart-recoverability.
    const redispatched = await dispatchPendingAnnotation('ann-2')
    expect(redispatched.status).toBe('dispatched')
    expect(state.sentFrames.some((f) => true)).toBe(true)
  })
})

describe('revanote dispatch adapter — Q3 lost send-time claim race', () => {
  afterAll(() => mock.restore())

  test('Q3: a dispatch that loses the claim to a racing winner cancels its run row (lost_claim_race), sends nothing, never fails the annotation', async () => {
    state.claimed = new Set()
    let winnerSends = 0
    // Between this dispatch's open() (run row inserted) and its send(): a racing
    // caller (batch sweep / forceSingle retry) wins the atomic claim and sends.
    state.onOpen = async () => {
      const won = await claimViaSql('ann-1')
      if (won) winnerSends++
    }

    const out = await dispatchPendingAnnotation('ann-1')

    expect(winnerSends).toBe(1)
    expect(state.sentFrames).toHaveLength(0) // loser sent nothing
    expect(state.runs).toHaveLength(1) // the spurious open() row...
    expect(state.runs[0]).toMatchObject({ status: 'cancelled', error: 'lost_claim_race' }) // ...is closed out
    expect(state.annStatus.some((s) => s.id === 'ann-1' && s.status === 'failed')).toBe(false)
    expect(out.status).not.toBe('dispatched')
  })
})

const env = (runId: string, extra: Record<string, unknown> = {}) =>
  `<<JSON>>
${JSON.stringify({ dispatch_id: runId, resolved: true, action_taken: 'fixed', files_changed: [], commit_sha: 'c0ffee1', ...extra })}
<<END>>`

describe('revanote dispatch adapter -- reply bound to its dispatch generation (late reply must not finalize a newer dispatch)', () => {
  afterAll(() => mock.restore())

  test('A dispatched, hub restart (_reset), B dispatched on the same session: a late reply for A does NOT finalize B; the reply for B does', async () => {
    await dispatchPendingAnnotation('ann-1') // run-1
    _reset() // restart: A's hook is gone, B can take the session
    await dispatchPendingAnnotation('ann-2') // run-2
    expect(state.runs.map((r) => r.id)).toEqual(['run-1', 'run-2'])

    await onSessionReply('sess-1', env('run-1'))
    expect(state.annStatus.some((s) => s.id === 'ann-2' && s.status === 'resolved')).toBe(false)
    expect(state.runs[1].status).toBe('in_flight')
    expect(state.callbacks).toHaveLength(0)

    await onSessionReply('sess-1', env('run-2'))
    expect(state.annStatus.some((s) => s.id === 'ann-2' && s.status === 'resolved')).toBe(true)
    expect(state.runs[1].status).toBe('success')
  })

  test('an envelope with no dispatch_id is "not mine": the hook stays armed', async () => {
    await dispatchPendingAnnotation('ann-1')
    await onSessionReply('sess-1', '<<JSON>>{"resolved":true,"commit_sha":"c0ffee1"}<<END>>')
    expect(state.runs[0].status).toBe('in_flight')
    expect(state.callbacks).toHaveLength(0)
    await onSessionReply('sess-1', env('run-1'))
    expect(state.runs[0].status).toBe('success')
  })

  test('terminal-timeout path: a FOREIGN-id envelope is never applied -- run finalizes failed, annotation not resolved', async () => {
    process.env.REVANOTE_FINALIZE_TIMEOUT_MS = '1'
    try {
      await dispatchPendingAnnotation('ann-1')
      await new Promise((r) => setTimeout(r, 15))
      await onSessionReply('sess-1', env('some-other-run'))
    } finally {
      delete process.env.REVANOTE_FINALIZE_TIMEOUT_MS
    }
    expect(state.annStatus.some((s) => s.status === 'resolved')).toBe(false)
    expect(state.callbacks[0]?.payload.resolved).toBe(false)
  })

  test('the claim records the dispatch generation (current_run_id) for the claimed annotation', async () => {
    await dispatchPendingAnnotation('ann-1')
    expect(state.currentRun['ann-1']).toBe('run-1')
  })

  test('finalize write is a CAS on the generation: a retry that took the row over (new current_run_id) makes the OLD finalize a no-op (no annotation write, no callback, no broadcast)', async () => {
    await dispatchPendingAnnotation('ann-1') // run-1
    state.currentRun['ann-1'] = 'run-2' // retry reset + re-claimed under a newer generation
    await onSessionReply('sess-1', env('run-1'))
    expect(state.annStatus.some((s) => s.id === 'ann-1' && (s.status === 'resolved' || s.status === 'failed'))).toBe(false)
    expect(state.callbacks).toHaveLength(0)
    expect(state.broadcasts.some((b) => b.type === 'revanote_resolved')).toBe(false)
  })
})

async function claimViaSql(id: string): Promise<boolean> {
  const { sql } = await import('../src/db/postgres.ts')
  const rows: any[] = await (sql as any)(["UPDATE annotations SET status = 'dispatched' WHERE id = ANY(", ")"], [id])
  return rows.length === 1
}

describe('revanote dispatch adapter — budget + cost-cap gates', () => {
  afterAll(() => mock.restore())

  test('over per-source budget → skipped, NO send, reject callback fired (gate on TOP of cost cap)', async () => {
    // cap=10, pct=60 → sourceCap=6. todayCost=6 ≥ 6 → over budget. Cost cap
    // (10) NOT yet hit, proving the budget gate blocks independently.
    state.costCap = 10
    state.budgetPct = 60
    state.todayCost = 6

    const out = await dispatchPendingAnnotation('ann-1')
    // markSkipped fires the reject callback fire-and-forget (void + dynamic
    // import); let the microtask + dynamic import settle before asserting.
    await new Promise((r) => setTimeout(r, 10))

    expect(out.status).toBe('skipped')
    expect((out as any).skip_reason).toContain('revanote_budget_exceeded')
    // No run opened, no frame sent.
    expect(state.runs).toHaveLength(0)
    expect(state.sentFrames).toHaveLength(0)
    // annotation marked failed + reject callback with annotation_id.
    expect(state.annStatus.some((s) => s.status === 'failed')).toBe(true)
    expect(state.callbacks).toHaveLength(1)
    expect(state.callbacks[0].payload.annotation_id).toBe('ext-abc')
    expect(state.callbacks[0].payload.resolved).toBe(false)
  })

  test('markSkipped is a CAS on pending: a row a concurrent dispatch already resolved gets NO failed write, broadcast or callback', async () => {
    state.costCap = 10
    state.budgetPct = 60
    state.todayCost = 6
    state.failCas = false

    await dispatchPendingAnnotation('ann-1')
    await new Promise((r) => setTimeout(r, 10))

    expect(state.annStatus.some((s) => s.status === 'failed')).toBe(false)
    expect(state.callbacks).toHaveLength(0)
    expect(state.broadcasts.filter((b) => b.type === 'revanote_skipped')).toHaveLength(0)
  })

  test('under budget → dispatches (budget gate passes)', async () => {
    state.costCap = 10
    state.budgetPct = 60
    state.todayCost = 5.99 // < sourceCap 6

    const out = await dispatchPendingAnnotation('ann-1')
    expect(out.status).toBe('dispatched')
    expect(state.sentFrames).toHaveLength(1)
  })

  test('IR-1: over global cost cap → skipped, NO send (cost-cap non-bypassable)', async () => {
    state.costCap = 10
    state.todayCost = 10 // ≥ cap

    const out = await dispatchPendingAnnotation('ann-1')
    expect(out.status).toBe('skipped')
    expect((out as any).skip_reason).toBe('daily_cost_cap')
    expect(state.runs).toHaveLength(0)
    expect(state.sentFrames).toHaveLength(0)
  })
})

describe('revanote dispatch adapter — stale/orphaned session rebind (prod incident 2026-09-10)', () => {
  afterAll(() => mock.restore())

  test('bound session_id is offline (dead/replaced) → re-resolves via mapping to the live replacement session and dispatches', async () => {
    state.annSessionId = 'sess-dead'
    state.offlineSessions.add('sess-dead')
    state.resolvedSession = { id: 'sess-2' }

    const out = await dispatchPendingAnnotation('ann-1')

    expect(out).toEqual({ status: 'dispatched', run_id: 'run-1', session_id: 'sess-2' })
    expect(state.sentFrames).toHaveLength(1)
    expect(state.annStatus.some((s) => s.status === 'dispatched' && s.opts.session_id === 'sess-2')).toBe(true)
  })

  test('bound session_id online → reused as-is, no re-resolution (healthy rows unaffected)', async () => {
    state.resolvedSession = { id: 'sess-should-not-be-used' }

    const out = await dispatchPendingAnnotation('ann-1')

    expect(out).toEqual({ status: 'dispatched', run_id: 'run-1', session_id: 'sess-1' })
  })

  test('bound session_id offline AND no replacement session exists → non-success outcome, NOT a bare dispatch/ack; reject callback fired', async () => {
    state.annSessionId = 'sess-dead'
    state.offlineSessions.add('sess-dead')
    state.resolvedSession = null

    const out = await dispatchPendingAnnotation('ann-1')
    await new Promise((r) => setTimeout(r, 10))

    expect(out.status).toBe('failed')
    expect((out as any).skip_reason).toBe('session_not_found_for_repo')
    expect(state.runs).toHaveLength(0)
    expect(state.sentFrames).toHaveLength(0)

    expect(state.annStatus.some((s) => s.status === 'failed' && s.opts.skip_reason === 'session_not_found_for_repo')).toBe(true)

    expect(state.callbacks).toHaveLength(1)
    expect(state.callbacks[0].payload.annotation_id).toBe('ext-abc')
    expect(state.callbacks[0].payload.resolved).toBe(false)
    expect(state.callbacks[0].payload.action_taken).toBe('no_target')
  })
})
