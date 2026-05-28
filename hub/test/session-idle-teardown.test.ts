/**
 * Bug B (2026-05-28) — idle-teardown grace timer.
 *
 * The module exports its mutable state via test-only helpers so we can
 * exercise the scheduling logic without a real WebSocket. The teardownSession
 * step (sending `shutdown` to the agent channel) is also covered via a
 * fake channel registration.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import {
  noteSubscriberCount,
  getSubscriberCount,
  isTeardownScheduled,
  _resetIdleTeardownStateForTests,
  _forceTeardownNowForTests,
} from '../src/ws/idle-teardown'
import { registerChannel, unregisterChannel, getChannel } from '../src/ws/registry'

function makeChannelStub() {
  const sent: string[] = []
  const closed: Array<{ code?: number; reason?: string }> = []
  const ws = {
    send: (s: string) => { sent.push(s); return s.length },
    close: (code?: number, reason?: string) => { closed.push({ code, reason }) },
  } as any
  return { ws, sent, closed }
}

describe('noteSubscriberCount — scheduling', () => {
  beforeEach(() => {
    _resetIdleTeardownStateForTests()
  })
  afterEach(() => {
    _resetIdleTeardownStateForTests()
  })

  test('count > 0 does not schedule a teardown', () => {
    noteSubscriberCount('s1', 2)
    expect(isTeardownScheduled('s1')).toBe(false)
    expect(getSubscriberCount('s1')).toBe(2)
  })

  test('count = 0 schedules a teardown', () => {
    noteSubscriberCount('s2', 0)
    expect(isTeardownScheduled('s2')).toBe(true)
    expect(getSubscriberCount('s2')).toBe(0)
  })

  test('resubscribe (count→positive) cancels pending teardown', () => {
    noteSubscriberCount('s3', 0)
    expect(isTeardownScheduled('s3')).toBe(true)
    noteSubscriberCount('s3', 1)
    expect(isTeardownScheduled('s3')).toBe(false)
  })

  test('redundant zero-count does not double-schedule', () => {
    noteSubscriberCount('s4', 0)
    noteSubscriberCount('s4', 0)
    // Still scheduled, but only one timer.
    expect(isTeardownScheduled('s4')).toBe(true)
  })

  test('negative count clamps to 0', () => {
    noteSubscriberCount('s5', -3)
    expect(getSubscriberCount('s5')).toBe(0)
    expect(isTeardownScheduled('s5')).toBe(true)
  })
})

describe('teardown — sends shutdown to agent channel', () => {
  beforeEach(() => {
    _resetIdleTeardownStateForTests()
  })
  afterEach(() => {
    _resetIdleTeardownStateForTests()
    unregisterChannel('sess_kill_me')
  })

  test('expired timer sends shutdown(idle_no_subscribers) to channel', () => {
    const { ws, sent } = makeChannelStub()
    registerChannel('sess_kill_me', 'user_x', ws)
    noteSubscriberCount('sess_kill_me', 0)
    _forceTeardownNowForTests('sess_kill_me')
    expect(sent.length).toBe(1)
    const payload = JSON.parse(sent[0])
    expect(payload.type).toBe('shutdown')
    expect(payload.reason).toBe('idle_no_subscribers')
    expect(isTeardownScheduled('sess_kill_me')).toBe(false)
  })

  test('no channel → silently no-op (does not throw)', () => {
    noteSubscriberCount('sess_no_chan', 0)
    expect(() => _forceTeardownNowForTests('sess_no_chan')).not.toThrow()
  })

  test('resubscribe before timer fires prevents shutdown', () => {
    const { ws, sent } = makeChannelStub()
    registerChannel('sess_resub', 'user_x', ws)
    noteSubscriberCount('sess_resub', 0)
    expect(isTeardownScheduled('sess_resub')).toBe(true)
    noteSubscriberCount('sess_resub', 1) // simulates a re-subscribe
    expect(isTeardownScheduled('sess_resub')).toBe(false)
    // Force the (now-cancelled) timer would be a no-op since the entry is gone.
    _forceTeardownNowForTests('sess_resub')
    expect(sent.length).toBe(0)
  })
})
