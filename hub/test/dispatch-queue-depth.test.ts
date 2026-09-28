/**
 * Per-session queue depth + wedge regressions (fix/revanote-session-busy).
 *
 * Prod symptom: a Revanote review with 22 open comments dispatches them all at
 * once to one session. The queue admitted 1 in-flight + 1 waiter, so 20 were
 * dropped as `session_busy` on every retry wave, forever.
 *
 * Covers:
 *   - A burst larger than the old 1-waiter cap is QUEUED (FIFO), not dropped,
 *     and each reply promotes the next waiter in arrival order.
 *   - Re-enqueueing a token that is already queued/in-flight is a no-op
 *     (Revanote's retry sweep re-sends the same annotation).
 *   - Wedge: a waiter that queues while the head is between claim and send,
 *     when the head then parks offline or its send throws, is DISPATCHED —
 *     not silently moved into the in-flight slot with no finalize hook (which
 *     held the slot forever and made every later dispatch `session_busy`).
 *   - Hard ceiling: a `shouldFinalize` hook that never sees its envelope and
 *     gets no further messages is reaped by `reapTimedOutHooks`, freeing the
 *     slot and promoting the next waiter.
 */
import { describe, test, expect, beforeEach } from 'bun:test'

import { SessionQueue } from '../src/dispatch/session-queue.ts'
import { getGraceBuffer } from '../src/dispatch/grace.ts'
import {
  dispatch,
  onSessionReply,
  reapTimedOutHooks,
  getQueue,
  _reset as resetPipeline,
  type DispatchRequest,
  type PipelineDeps,
  type RunStore,
} from '../src/dispatch/pipeline.ts'

interface RecordingStore extends RunStore {
  opened: string[]
  skipped: Array<[string, string]>
  failed: Array<[string, string]>
  finalized: Array<[string, string]>
}

function recordingStore(shouldFinalize?: (c: string) => boolean): RecordingStore {
  const s: RecordingStore = {
    opened: [],
    skipped: [],
    failed: [],
    finalized: [],
    async open(req) {
      s.opened.push(req.token)
      return `run:${req.token}`
    },
    async markSkipped(token, reason) { s.skipped.push([token, reason]) },
    async markFailed(token, error) { s.failed.push([token, error]) },
    async onFinalize(token, content) { s.finalized.push([token, content]) },
    ...(shouldFinalize ? { shouldFinalize } : {}),
  }
  return s
}

function req(token: string): DispatchRequest {
  return { userId: 'u1', sessionId: 's1', token, prompt: `p-${token}` }
}

function mkDeps(over: Partial<PipelineDeps> = {}, shouldFinalize?: (c: string) => boolean) {
  const sends: string[] = []
  const store = recordingStore(shouldFinalize)
  const d: PipelineDeps = {
    gates: [],
    store,
    isOnline: () => true,
    send: async (r) => { sends.push(r.token) },
    replay: async () => {},
    ...over,
  }
  return { d, sends, store }
}

function deferred<T = void>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

describe('SessionQueue — configurable waiter depth', () => {
  test('default depth keeps the legacy 1-waiter contract', () => {
    const q = new SessionQueue()
    expect(q.enqueue('s1', 'r1')).toBe('dispatched')
    expect(q.enqueue('s1', 'r2')).toBe('queued')
    expect(q.enqueue('s1', 'r3')).toBe('dropped')
  })

  test('deeper queue admits N waiters FIFO and drops only past the cap', () => {
    const q = new SessionQueue(3)
    expect(q.enqueue('s1', 'r1')).toBe('dispatched')
    expect(q.enqueue('s1', 'r2')).toBe('queued')
    expect(q.enqueue('s1', 'r3')).toBe('queued')
    expect(q.enqueue('s1', 'r4')).toBe('queued')
    expect(q.enqueue('s1', 'r5')).toBe('dropped')
    expect(q.waiterCount('s1')).toBe(3)
    expect(q.markFinished('s1')).toBe('r2')
    expect(q.markFinished('s1')).toBe('r3')
    expect(q.markFinished('s1')).toBe('r4')
    expect(q.markFinished('s1')).toBe(null)
  })

  test('re-enqueueing a token already queued or in flight is a no-op', () => {
    const q = new SessionQueue(3)
    q.enqueue('s1', 'r1')
    q.enqueue('s1', 'r2')
    expect(q.enqueue('s1', 'r1')).toBe('queued')
    expect(q.enqueue('s1', 'r2')).toBe('queued')
    expect(q.waiterCount('s1')).toBe(1)
  })

  test('releaseAndTakeNext frees the slot and hands back the next waiter without claiming it', () => {
    const q = new SessionQueue(3)
    q.enqueue('s1', 'r1')
    q.enqueue('s1', 'r2')
    q.enqueue('s1', 'r3')
    expect(q.releaseAndTakeNext('s1')).toBe('r2')
    expect(q.currentInFlight('s1')).toBe(null)
    expect(q.waiterCount('s1')).toBe(1)
    // The caller re-dispatches r2, which claims the free slot.
    expect(q.enqueue('s1', 'r2')).toBe('dispatched')
  })
})

describe('dispatch/pipeline — burst larger than the old waiter cap', () => {
  beforeEach(() => resetPipeline())

  test('22 comments on one session: none dropped, all sent in arrival order', async () => {
    const { d, sends, store } = mkDeps()
    const outs = []
    for (let i = 1; i <= 22; i++) outs.push(await dispatch(req(`t${i}`), d))
    expect(outs[0]).toEqual({ kind: 'dispatched', runId: 'run:t1' })
    expect(outs.slice(1).every((o) => o.kind === 'queued')).toBe(true)
    expect(store.skipped).toEqual([])

    for (let i = 1; i <= 22; i++) await onSessionReply('s1', `reply-${i}`)
    expect(sends).toEqual(Array.from({ length: 22 }, (_, i) => `t${i + 1}`))
    expect(store.finalized.map(([t]) => t)).toEqual(Array.from({ length: 22 }, (_, i) => `run:t${i + 1}`))
    expect(getQueue().currentInFlight('s1')).toBe(null)
  })
})

describe('dispatch/pipeline — no stranded promotion (wedge regression)', () => {
  beforeEach(() => {
    resetPipeline()
    ;(getGraceBuffer() as any)._reset()
  })

  test('head parks offline while a waiter queued → waiter is dispatched, slot not wedged', async () => {
    const gate = deferred<boolean>()
    let calls = 0
    const { d, sends } = mkDeps({
      // t1's online check is slow and reports offline; t2's is instant+online.
      isOnline: () => (++calls === 1 ? gate.promise : true),
    })
    const p1 = dispatch(req('t1'), d)
    const out2 = await dispatch(req('t2'), d) // arrives while t1 is mid-claim
    expect(out2).toEqual({ kind: 'queued' })
    gate.resolve(false)
    expect(await p1).toEqual({ kind: 'parked_offline' })
    await Bun.sleep(0)

    expect(sends).toEqual(['t2'])
    expect(getQueue().currentInFlight('s1')).toBe('t2')
    // And the slot really frees when t2 replies — the old code wedged here.
    await onSessionReply('s1', 'done-2')
    expect(getQueue().currentInFlight('s1')).toBe(null)
    const out3 = await dispatch(req('t3'), d)
    expect(out3).toEqual({ kind: 'dispatched', runId: 'run:t3' })
  })

  test('head send throws while a waiter queued → waiter is dispatched, slot not wedged', async () => {
    const gate = deferred()
    let calls = 0
    const sends: string[] = []
    const { d } = mkDeps({
      send: async (r) => {
        if (++calls === 1) {
          await gate.promise
          throw new Error('socket_gone')
        }
        sends.push(r.token)
      },
    })
    const p1 = dispatch(req('t1'), d)
    await Bun.sleep(0)
    expect(await dispatch(req('t2'), d)).toEqual({ kind: 'queued' })
    gate.resolve()
    expect(await p1).toEqual({ kind: 'failed', reason: 'socket_gone' })
    await Bun.sleep(0)

    expect(sends).toEqual(['t2'])
    await onSessionReply('s1', 'done-2')
    expect(getQueue().currentInFlight('s1')).toBe(null)
  })
})

describe('dispatch/pipeline — hard ceiling on a silent shouldFinalize hook', () => {
  beforeEach(() => resetPipeline())

  const ENVELOPE_RE = /<<JSON>>([\s\S]*?)<<END>>/i

  test('reapTimedOutHooks finalizes a hook past the ceiling and promotes the next waiter', async () => {
    const { d, sends, store } = mkDeps({ hookMaxMs: 1000 }, (c) => ENVELOPE_RE.test(c))
    await dispatch(req('t1'), d)
    await dispatch(req('t2'), d)
    // Agent said "done" without the envelope, then went silent.
    await onSessionReply('s1', 'done, verified')
    expect(store.finalized).toEqual([])

    // Before the ceiling: nothing reaped.
    expect(await reapTimedOutHooks(Date.now())).toBe(0)
    expect(store.finalized).toEqual([])

    // Past the ceiling: reaped with empty content, t2 promoted and sent.
    expect(await reapTimedOutHooks(Date.now() + 1001)).toBe(1)
    expect(store.finalized).toEqual([['run:t1', '']])
    expect(sends).toEqual(['t1', 't2'])
    expect(getQueue().currentInFlight('s1')).toBe('t2')
  })

  test('stores without shouldFinalize are never reaped (one-shot semantics unchanged)', async () => {
    const { d, store } = mkDeps({ hookMaxMs: 1 })
    await dispatch(req('t1'), d)
    expect(await reapTimedOutHooks(Date.now() + 10_000)).toBe(0)
    expect(store.finalized).toEqual([])
  })
})
