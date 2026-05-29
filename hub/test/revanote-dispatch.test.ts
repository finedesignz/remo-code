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
    payload_raw: {},
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
} = {
  runs: [], annStatus: [], broadcasts: [], sentFrames: [], callbacks: [],
  budgetPct: 60, todayCost: 0, costCap: 10,
}

let runSeq = 0

// postgres.sql is used by: peekUserIdForAnnotation, getUserTimezone,
// revanoteBudgetGate (cap+pct), sumTodayAnnotationCostForUser is its own DAL fn.
// We discriminate by the SQL text fragments.
mock.module('../src/db/postgres.ts', () => ({
  sql: async (strings: TemplateStringsArray) => {
    const text = strings.join('')
    if (text.includes('user_id FROM annotations')) return [{ user_id: 'user-1' }]
    if (text.includes('AS tz')) return [{ tz: 'UTC' }]
    if (text.includes('revanote_budget_pct')) return [{ cap: String(state.costCap), pct: state.budgetPct }]
    if (text.includes('daily_cost_cap_usd::text AS cap')) return [{ cap: String(state.costCap) }]
    return []
  },
}))

mock.module('../src/db/revanote-dal.ts', () => ({
  ...realRevDal,
  resolveRevanoteMappingForHost: async () => MAPPING,
  getAnnotationById: async () => makeAnnotation(),
  sumTodayAnnotationCostForUser: async () => state.todayCost,
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
  },
}))

mock.module('../src/db/dal.ts', () => ({
  ...realDal,
  findSessionByProjectDir: async () => ({ id: 'sess-1' }),
  insertMessage: async () => ({ id: 'msg-1', created_at: new Date().toISOString() }),
}))

mock.module('../src/ws/registry.ts', () => ({
  getChannel: (_sid: string) => ({ ws: { send: (f: string) => state.sentFrames.push(JSON.parse(f)) } }),
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
    await onSessionReply('sess-1', 'Done.\n<<JSON>>\n{"resolved":true,"action_taken":"fixed button","files_changed":["a.tsx"],"deployed":true}\n<<END>>')

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

    // Second dispatch on the same session → queued, no new run row.
    const out2 = await dispatchPendingAnnotation('ann-1')
    expect(out2).toEqual({ status: 'queued' })
    expect(state.runs).toHaveLength(1) // still one — queued waiter has NOT opened

    // First reply finalizes head + promotes waiter → re-dispatch opens run #2.
    await onSessionReply('sess-1', '<<JSON>>{"resolved":true}<<END>>')
    expect(state.runs).toHaveLength(2)
    expect(state.runs[1].id).toBe('run-2')
  })
})

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
