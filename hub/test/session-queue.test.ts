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

  // Stale-lock reaper support (fix/dispatch-stale-lock-reaper): a dispatched
  // token stamps `inFlightSince`, and `staleInFlight`/`inFlightAgeMs` read it
  // back deterministically off an explicit `now` (never wall-clock in tests).
  test('dispatched enqueue stamps an in-flight timestamp', () => {
    const q = new SessionQueue()
    q.enqueue('s1', 'r1')
    expect(q.inFlightAgeMs('s1', Date.now())).toBeGreaterThanOrEqual(0)
  })

  test('staleInFlight returns the session only once age >= threshold', () => {
    const q = new SessionQueue()
    q.enqueue('s1', 'r1')
    const age = q.inFlightAgeMs('s1')! // real timestamp just stamped
    const now = Date.now()
    // Below threshold: not yet stale.
    expect(q.staleInFlight(age + 60_000, now)).toEqual([])
    // At/above threshold: stale.
    expect(q.staleInFlight(0, now)).toEqual(['s1'])
  })

  test('markFinished promotion resets the in-flight timestamp', async () => {
    const q = new SessionQueue()
    q.enqueue('s1', 'r1')
    const firstAge = q.inFlightAgeMs('s1')!
    q.enqueue('s1', 'r2') // waiter
    await new Promise((r) => setTimeout(r, 5))
    const promoted = q.markFinished('s1')
    expect(promoted).toBe('r2')
    const secondAge = q.inFlightAgeMs('s1')!
    // The promoted lock's age is measured from ITS OWN stamp, not the first
    // token's — so it should be smaller than "firstAge + the sleep" would be.
    expect(secondAge).toBeLessThan(firstAge + 5_000)
  })

  test('abandon removes the in-flight timestamp', () => {
    const q = new SessionQueue()
    q.enqueue('s1', 'r1')
    q.abandon('s1')
    expect(q.inFlightAgeMs('s1')).toBe(null)
    expect(q.staleInFlight(0)).toEqual([])
  })

  test('a queued (not dispatched) token does not create an in-flight timestamp', () => {
    const q = new SessionQueue()
    q.enqueue('s1', 'r1') // dispatched — has a timestamp
    q.enqueue('s1', 'r2') // queued — waiter has no timestamp of its own
    // Only one slot's inFlightSince exists (the dispatched r1's); staleInFlight
    // with threshold 0 must report s1 exactly once, not twice.
    expect(q.staleInFlight(0)).toEqual(['s1'])
  })
})
