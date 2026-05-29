/**
 * SessionQueue unit tests (Round-2 collapse relocation).
 *
 * These cases were RELOCATED VERBATIM (behavioral assertions preserved) from
 * the old `scheduler/session-queue` describe-block in `scheduler.test.ts` when
 * the back-compat functional shim (`hub/src/scheduler/session-queue.ts`) was
 * deleted. They now exercise the `SessionQueue` CLASS directly
 * (`hub/src/dispatch/session-queue.ts`) — instantiate, call instance methods.
 *
 * FIFO/promotion contract:
 *   - AT MOST 1 in-flight + 1 waiter per session; further enqueues drop.
 *   - `markFinished` promotes the waiter to in-flight and RETURNS its token
 *     (or null when there was no waiter); the caller decides what to do with
 *     the promotion (the old shim's `setOnPromote`/`onSessionIdleAndPromote`
 *     callback seam was a shim-only convenience over this exact return value).
 *
 * `dispatch-pipeline.test.ts` ALSO mirrors these same queue semantics against
 * the class as part of the pipeline contract — that's intentional redundancy
 * so the queue's behavior stays pinned from both the standalone and the
 * pipeline-integration angle.
 */
import { describe, test, expect } from 'bun:test'

import { SessionQueue } from '../src/dispatch/session-queue.ts'

describe('SessionQueue', () => {
  test('1st enqueue dispatches, 2nd queues, 3rd drops', () => {
    const q = new SessionQueue()
    expect(q.enqueue('s1', 'r1')).toBe('dispatched')
    expect(q.enqueue('s1', 'r2')).toBe('queued')
    expect(q.enqueue('s1', 'r3')).toBe('dropped')
    expect(q.currentInFlight('s1')).toBe('r1')
  })

  test('markFinished promotes the waiter to in-flight', () => {
    const q = new SessionQueue()
    q.enqueue('s1', 'r1')
    q.enqueue('s1', 'r2')
    const promoted = q.markFinished('s1')
    expect(promoted).toBe('r2')
    expect(q.currentInFlight('s1')).toBe('r2')
  })

  test('markFinished with no waiter clears the slot', () => {
    const q = new SessionQueue()
    q.enqueue('s1', 'r1')
    const promoted = q.markFinished('s1')
    expect(promoted).toBe(null)
    expect(q.currentInFlight('s1')).toBe(null)
  })

  // The old shim exposed `onSessionIdleAndPromote(sessionId)` which called
  // `markFinished` and then invoked a registered `setOnPromote` handler with
  // the promoted (sessionId, token). The class returns the promoted token; the
  // caller fires the handler. This test preserves the original behavioral
  // assertion — promotion returns 'r2' and the handler observes ['s1','r2'].
  test('promotion returns the waiter token and lets the caller fire a handler', () => {
    const q = new SessionQueue()
    const calls: Array<[string, string]> = []
    const promoteAndNotify = (sessionId: string): string | null => {
      const promoted = q.markFinished(sessionId)
      if (promoted) calls.push([sessionId, promoted])
      return promoted
    }
    q.enqueue('s1', 'r1')
    q.enqueue('s1', 'r2')
    const promoted = promoteAndNotify('s1')
    expect(promoted).toBe('r2')
    expect(calls).toEqual([['s1', 'r2']])
  })

  test('separate sessions have independent slots', () => {
    const q = new SessionQueue()
    expect(q.enqueue('a', 'ra1')).toBe('dispatched')
    expect(q.enqueue('b', 'rb1')).toBe('dispatched')
    expect(q.enqueue('a', 'ra2')).toBe('queued')
    expect(q.currentInFlight('a')).toBe('ra1')
    expect(q.currentInFlight('b')).toBe('rb1')
  })

  test('abandon clears a session slot', () => {
    const q = new SessionQueue()
    q.enqueue('s1', 'r1')
    q.enqueue('s1', 'r2')
    q.abandon('s1')
    expect(q.currentInFlight('s1')).toBe(null)
    expect(q.enqueue('s1', 'r3')).toBe('dispatched')
  })

  test('_reset clears all slots', () => {
    const q = new SessionQueue()
    q.enqueue('s1', 'r1')
    q.enqueue('s2', 'r2')
    q._reset()
    expect(q.currentInFlight('s1')).toBe(null)
    expect(q.currentInFlight('s2')).toBe(null)
  })
})
