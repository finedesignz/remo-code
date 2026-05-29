/**
 * Dispatch pipeline contract tests (Phase 1 foundation, no DB).
 *
 * Covers:
 *   - SessionQueue FIFO semantics — MIRRORS the `scheduler/session-queue`
 *     describe-block in `scheduler.test.ts` VERBATIM so the relocated queue is
 *     provably identical.
 *   - GraceBuffer register / drain / TTL-expire + the 60s sweep (driven
 *     synchronously via `_sweepNow`).
 *   - Pipeline gate ordering (threshold before cost-cap before queue; first
 *     block wins), queue dispatch/queue/drop + promotion, offline park, and
 *     onSessionReply finalize-then-promote-then-redispatch.
 *
 * Invariants asserted:
 *   IR-1  cost-capped user → {kind:'skipped'}, send fn NEVER called.
 *   IR-2  gates run threshold→costCap→...; promotion re-runs the gate list.
 *   IR-7  finalize hook fires only via onSessionReply (assistant_message), not
 *         on a partial/no reply.
 */
import { describe, test, expect, beforeEach } from 'bun:test'

import { SessionQueue } from '../src/dispatch/session-queue.ts'
import { getGraceBuffer, DEFAULT_TTL_MS } from '../src/dispatch/grace.ts'
import {
  dispatch,
  onSessionReply,
  getQueue,
  _reset as resetPipeline,
  type DispatchGate,
  type DispatchRequest,
  type PipelineDeps,
  type RunStore,
} from '../src/dispatch/pipeline.ts'

// ─────────────────────────────────────────────────────────────────────────────
// SessionQueue — mirrors scheduler.test.ts `scheduler/session-queue` block
// ─────────────────────────────────────────────────────────────────────────────
describe('dispatch/session-queue (mirrors scheduler contract)', () => {
  let q: SessionQueue
  beforeEach(() => {
    q = new SessionQueue()
  })

  test('1st enqueue dispatches, 2nd queues, 3rd drops', () => {
    expect(q.enqueue('s1', 'r1')).toBe('dispatched')
    expect(q.enqueue('s1', 'r2')).toBe('queued')
    expect(q.enqueue('s1', 'r3')).toBe('dropped')
    expect(q.currentInFlight('s1')).toBe('r1')
  })

  test('markFinished promotes the waiter to in-flight', () => {
    q.enqueue('s1', 'r1')
    q.enqueue('s1', 'r2')
    const promoted = q.markFinished('s1')
    expect(promoted).toBe('r2')
    expect(q.currentInFlight('s1')).toBe('r2')
  })

  test('markFinished with no waiter clears the slot', () => {
    q.enqueue('s1', 'r1')
    const promoted = q.markFinished('s1')
    expect(promoted).toBe(null)
    expect(q.currentInFlight('s1')).toBe(null)
  })

  test('separate sessions have independent slots', () => {
    expect(q.enqueue('a', 'ra1')).toBe('dispatched')
    expect(q.enqueue('b', 'rb1')).toBe('dispatched')
    expect(q.enqueue('a', 'ra2')).toBe('queued')
    expect(q.currentInFlight('a')).toBe('ra1')
    expect(q.currentInFlight('b')).toBe('rb1')
  })

  test('abandon clears a session slot', () => {
    q.enqueue('s1', 'r1')
    q.enqueue('s1', 'r2')
    q.abandon('s1')
    expect(q.currentInFlight('s1')).toBe(null)
    expect(q.enqueue('s1', 'r3')).toBe('dispatched')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// GraceBuffer
// ─────────────────────────────────────────────────────────────────────────────
describe('dispatch/grace', () => {
  beforeEach(() => {
    ;(getGraceBuffer() as any)._reset()
  })

  test('default TTL is the legacy 10-minute window', () => {
    expect(DEFAULT_TTL_MS).toBe(10 * 60 * 1000)
  })

  test('register then drain runs the replay thunk', async () => {
    const g = getGraceBuffer()
    let ran = 0
    g.register('sess_a', async () => {
      ran++
    })
    await g.drain('sess_a')
    expect(ran).toBe(1)
    // drained — second drain is a no-op
    await g.drain('sess_a')
    expect(ran).toBe(1)
  })

  test('multiple replays for one key all run on drain', async () => {
    const g = getGraceBuffer()
    const order: string[] = []
    g.register('k', async () => {
      order.push('a')
    })
    g.register('k', async () => {
      order.push('b')
    })
    await g.drain('k')
    expect(order).toEqual(['a', 'b'])
  })

  test('expired entry is dropped — drain does NOT run it', async () => {
    const g = getGraceBuffer()
    let ran = 0
    g.register('k', async () => {
      ran++
    }, { ttlMs: -1 }) // already expired
    await g.drain('k')
    expect(ran).toBe(0)
  })

  test('sweep removes expired entries', async () => {
    const g = getGraceBuffer() as any
    let ran = 0
    g.register('k', async () => {
      ran++
    }, { ttlMs: -1 })
    expect(g._pendingCount('k')).toBe(1)
    g._sweepNow()
    expect(g._pendingCount('k')).toBe(0)
    await g.drain('k')
    expect(ran).toBe(0)
  })

  test('sweep keeps live entries', () => {
    const g = getGraceBuffer() as any
    g.register('k', async () => {}, { ttlMs: DEFAULT_TTL_MS })
    g._sweepNow()
    expect(g._pendingCount('k')).toBe(1)
  })

  test('drain on a key with no entries is a no-op', async () => {
    const g = getGraceBuffer()
    await g.drain('nope')
  })

  // ── onExpire side-effect (legacy expire-mark parity) ──────────────────────
  test('TTL-expiry fires onExpire on sweep (exactly once)', async () => {
    const g = getGraceBuffer() as any
    let expired = 0
    g.register('k', async () => {}, { ttlMs: -1, onExpire: async () => { expired++ } })
    g._sweepNow()
    expect(expired).toBe(1)
    // entry now gone — a second sweep must not re-fire it
    g._sweepNow()
    expect(expired).toBe(1)
  })

  test('TTL-expiry fires onExpire on drain when sweep has not run', async () => {
    const g = getGraceBuffer()
    let expired = 0
    let replayed = 0
    g.register('k', async () => { replayed++ }, { ttlMs: -1, onExpire: async () => { expired++ } })
    await g.drain('k')
    expect(expired).toBe(1) // expire-marked
    expect(replayed).toBe(0) // never replayed
  })

  test('a drained (live) entry does NOT fire onExpire', async () => {
    const g = getGraceBuffer()
    let expired = 0
    let replayed = 0
    g.register('k', async () => { replayed++ }, { ttlMs: DEFAULT_TTL_MS, onExpire: async () => { expired++ } })
    await g.drain('k')
    expect(replayed).toBe(1)
    expect(expired).toBe(0)
  })

  test('sweep with no expired entries fires nothing', () => {
    const g = getGraceBuffer() as any
    let expired = 0
    g.register('k', async () => {}, { ttlMs: DEFAULT_TTL_MS, onExpire: async () => { expired++ } })
    g._sweepNow()
    expect(expired).toBe(0)
    expect(g._pendingCount('k')).toBe(1)
  })

  test('onExpire that throws does not break the sweep loop', () => {
    const g = getGraceBuffer() as any
    let other = 0
    g.register('a', async () => {}, { ttlMs: -1, onExpire: async () => { throw new Error('boom') } })
    g.register('b', async () => {}, { ttlMs: -1, onExpire: async () => { other++ } })
    expect(() => g._sweepNow()).not.toThrow()
    expect(g._pendingCount('a')).toBe(0)
    expect(g._pendingCount('b')).toBe(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Pipeline
//
// TODO(migration): the following pipeline cases land with the telegram/error-
// capture migration PRs (they need a concrete RunStore/null-store subsystem):
//   - store:null path (telegram) — dispatch with deps.store === null skips the
//     markSkipped/onFinalize/markDispatched calls without throwing.
//   - enqueue-after-abandon — abandon(sessionId) frees the slot so the next
//     dispatch claims 'dispatched' (queue-level case; pipeline has no abandon
//     surface yet — added when a subsystem needs cancel).
//   - promotion-failure branch — promoted re-dispatch whose send() throws is
//     logged and does not wedge the session (re-dispatch failure path).
// ─────────────────────────────────────────────────────────────────────────────

const baseReq = (over: Partial<DispatchRequest> = {}): DispatchRequest => ({
  userId: 'u1',
  sessionId: 's1',
  token: 't1',
  prompt: 'hello',
  ...over,
})

function passGate(name: string): DispatchGate {
  return { name, async check() { return { ok: true } } }
}
function blockGate(name: string, reason: string): DispatchGate {
  return { name, async check() { return { ok: false, reason } } }
}

interface RecordingStore extends RunStore {
  skipped: Array<[string, string]>
  failed: Array<[string, string]>
  finalized: Array<[string, string]>
  dispatched: string[]
}
function recordingStore(): RecordingStore {
  const s: RecordingStore = {
    skipped: [],
    failed: [],
    finalized: [],
    dispatched: [],
    async markSkipped(token, reason) { s.skipped.push([token, reason]) },
    async markFailed(token, error) { s.failed.push([token, error]) },
    async markDispatched(token) { s.dispatched.push(token) },
    async onFinalize(token, content) { s.finalized.push([token, content]) },
  }
  return s
}

function deps(over: Partial<PipelineDeps> = {}): { deps: PipelineDeps; sends: DispatchRequest[]; replays: DispatchRequest[]; store: RecordingStore } {
  const sends: DispatchRequest[] = []
  const replays: DispatchRequest[] = []
  const store = recordingStore()
  const d: PipelineDeps = {
    gates: [passGate('threshold'), passGate('daily_cost_cap')],
    store,
    isOnline: () => true,
    send: async (req) => { sends.push(req) },
    replay: async (req) => { replays.push(req) },
    ...over,
  }
  return { deps: d, sends, replays, store }
}

describe('dispatch/pipeline — gates', () => {
  beforeEach(() => resetPipeline())

  test('all gates pass → dispatched, send called once', async () => {
    const { deps: d, sends } = deps()
    const out = await dispatch(baseReq(), d)
    expect(out).toEqual({ kind: 'dispatched' })
    expect(sends).toHaveLength(1)
  })

  test('IR-1: cost-capped user → skipped, send NEVER called', async () => {
    const { deps: d, sends, store } = deps({
      gates: [passGate('threshold'), blockGate('daily_cost_cap', 'daily_cost_cap')],
    })
    const out = await dispatch(baseReq(), d)
    expect(out).toEqual({ kind: 'skipped', reason: 'daily_cost_cap' })
    expect(sends).toHaveLength(0)
    expect(store.skipped).toEqual([['t1', 'daily_cost_cap']])
  })

  test('IR-2: gate order — threshold blocks BEFORE cost-cap is evaluated', async () => {
    const order: string[] = []
    const threshold: DispatchGate = {
      name: 'threshold',
      async check() { order.push('threshold'); return { ok: false, reason: 'quota_threshold_reached' } },
    }
    const costCap: DispatchGate = {
      name: 'daily_cost_cap',
      async check() { order.push('daily_cost_cap'); return { ok: true } },
    }
    const { deps: d, sends } = deps({ gates: [threshold, costCap] })
    const out = await dispatch(baseReq(), d)
    expect(out).toEqual({ kind: 'skipped', reason: 'quota_threshold_reached' })
    expect(order).toEqual(['threshold']) // cost-cap never ran (first-block-wins)
    expect(sends).toHaveLength(0)
  })

  test('gates run in array order until first block', async () => {
    const order: string[] = []
    const mk = (n: string, ok: boolean): DispatchGate => ({
      name: n,
      async check() { order.push(n); return ok ? { ok: true } : { ok: false, reason: n } },
    })
    const { deps: d } = deps({ gates: [mk('a', true), mk('b', false), mk('c', true)] })
    const out = await dispatch(baseReq(), d)
    expect(out).toEqual({ kind: 'skipped', reason: 'b' })
    expect(order).toEqual(['a', 'b'])
  })
})

describe('dispatch/pipeline — queue claim + drop', () => {
  beforeEach(() => resetPipeline())

  test('second concurrent dispatch on same session → queued', async () => {
    const { deps: d } = deps()
    const out1 = await dispatch(baseReq({ token: 't1' }), d)
    const out2 = await dispatch(baseReq({ token: 't2' }), d)
    expect(out1).toEqual({ kind: 'dispatched' })
    expect(out2).toEqual({ kind: 'queued' })
    expect(getQueue().currentInFlight('s1')).toBe('t1')
  })

  test('third concurrent dispatch → dropped_busy + markSkipped(session_busy)', async () => {
    const { deps: d, store } = deps()
    await dispatch(baseReq({ token: 't1' }), d)
    await dispatch(baseReq({ token: 't2' }), d)
    const out3 = await dispatch(baseReq({ token: 't3' }), d)
    expect(out3).toEqual({ kind: 'dropped_busy' })
    expect(store.skipped).toContainEqual(['t3', 'session_busy'])
  })
})

describe('dispatch/pipeline — offline park', () => {
  beforeEach(() => resetPipeline())

  test('offline target → parked_offline, send not called, slot released, grace registered', async () => {
    ;(getGraceBuffer() as any)._reset()
    const { deps: d, sends, replays } = deps({ isOnline: () => false })
    const out = await dispatch(baseReq(), d)
    expect(out).toEqual({ kind: 'parked_offline' })
    expect(sends).toHaveLength(0)
    // slot released so a later online dispatch can claim it
    expect(getQueue().currentInFlight('s1')).toBe(null)
    // draining grace runs the replay
    await getGraceBuffer().drain('s1')
    expect(replays).toHaveLength(1)
  })

  test('graceKey override parks under the supervisor key', async () => {
    ;(getGraceBuffer() as any)._reset()
    const { deps: d, replays } = deps({ isOnline: () => false, graceKey: () => 'sup_42' })
    await dispatch(baseReq(), d)
    await getGraceBuffer().drain('s1')
    expect(replays).toHaveLength(0) // not under sessionId
    await getGraceBuffer().drain('sup_42')
    expect(replays).toHaveLength(1)
  })

  test('onParkExpire fires when a parked entry TTL-lapses on sweep', async () => {
    const g = getGraceBuffer() as any
    g._reset()
    let expired = 0
    let replayed = 0
    // Force immediate expiry by reaching into the buffer is not exposed; instead
    // park then expire via a 0/negative-TTL replay is not pipeline-controllable,
    // so assert the wiring: onParkExpire is threaded to grace.register's onExpire.
    const { deps: d } = deps({
      isOnline: () => false,
      replay: async () => { replayed++ },
      onParkExpire: async () => { expired++ },
    })
    await dispatch(baseReq(), d)
    // The grace entry is live (10-min TTL) — manually expire it then sweep.
    // Reach the single pending entry and backdate it.
    ;(g as any).byTarget?.get('s1')?.forEach?.((p: any) => { p.expiresAt = Date.now() - 1 })
    g._sweepNow()
    expect(expired).toBe(1)
    expect(replayed).toBe(0)
  })
})

describe('dispatch/pipeline — send failure', () => {
  beforeEach(() => resetPipeline())

  test('send throws → failed, markFailed, slot released', async () => {
    const { deps: d, store } = deps({
      send: async () => { throw new Error('socket_gone') },
    })
    const out = await dispatch(baseReq(), d)
    expect(out).toEqual({ kind: 'failed', reason: 'socket_gone' })
    expect(store.failed).toEqual([['t1', 'socket_gone']])
    expect(getQueue().currentInFlight('s1')).toBe(null)
  })
})

describe('dispatch/pipeline — onSessionReply finalize + promote + redispatch', () => {
  beforeEach(() => resetPipeline())

  test('IR-7: onSessionReply finalizes the in-flight run', async () => {
    const { deps: d, store } = deps()
    await dispatch(baseReq({ token: 't1' }), d)
    await onSessionReply('s1', 'done')
    expect(store.finalized).toEqual([['t1', 'done']])
  })

  test('onSessionReply on a session with no active hook is a no-op', async () => {
    const { deps: d, store } = deps()
    await onSessionReply('nobody', 'x')
    expect(store.finalized).toHaveLength(0)
  })

  test('finalize then promote the waiter and re-dispatch it (send fires)', async () => {
    const { deps: d, sends, store } = deps()
    await dispatch(baseReq({ token: 't1' }), d)
    await dispatch(baseReq({ token: 't2' }), d) // queued
    expect(sends.map((r) => r.token)).toEqual(['t1'])

    await onSessionReply('s1', 'reply-1')
    // t1 finalized; t2 promoted, re-dispatched, sent
    expect(store.finalized).toEqual([['t1', 'reply-1']])
    expect(sends.map((r) => r.token)).toEqual(['t1', 't2'])
    expect(getQueue().currentInFlight('s1')).toBe('t2')
  })

  test('IR-2: a user who crossed the cap WHILE QUEUED gets skipped on promotion', async () => {
    // First gate passes until we flip it after the waiter is queued.
    let capped = false
    const costCap: DispatchGate = {
      name: 'daily_cost_cap',
      async check() { return capped ? { ok: false, reason: 'daily_cost_cap' } : { ok: true } },
    }
    const { deps: d, sends, store } = deps({ gates: [passGate('threshold'), costCap] })

    await dispatch(baseReq({ token: 't1' }), d) // dispatched (cap ok)
    await dispatch(baseReq({ token: 't2' }), d) // queued (cap still ok)
    expect(sends.map((r) => r.token)).toEqual(['t1'])

    capped = true // user crosses the cap while t2 waits
    await onSessionReply('s1', 'reply-1')

    // t1 finalized; t2 promoted but re-runs gates → cost-cap blocks → skipped.
    expect(store.finalized).toEqual([['t1', 'reply-1']])
    expect(sends.map((r) => r.token)).toEqual(['t1']) // t2 NEVER sent
    expect(store.skipped).toContainEqual(['t2', 'daily_cost_cap'])
    expect(getQueue().currentInFlight('s1')).toBe(null)
  })

  test('promotion with no waiter just finalizes and clears', async () => {
    const { deps: d, store } = deps()
    await dispatch(baseReq({ token: 't1' }), d)
    await onSessionReply('s1', 'r')
    expect(store.finalized).toEqual([['t1', 'r']])
    expect(getQueue().currentInFlight('s1')).toBe(null)
  })
})
