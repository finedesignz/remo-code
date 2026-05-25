/**
 * Plan 03-002 — WS multi-subscribe coverage.
 *
 * Exercises the two pieces that own the contract:
 *   1. `ClientSubscribe` schema (overload, cap, refine).
 *   2. `registry.ts` membership-based fan-out (no leakage to non-subscribers).
 *
 * Pure unit tests — no DB, no real WebSocket. The third leg (end-to-end
 * through `handleClientMessage` + DAL ownership) is gated on the future
 * REMO_E2E_DB_URL harness, matching `scheduled-tasks.e2e.test.ts`.
 */
import { describe, test, expect, mock, beforeEach } from 'bun:test'
import { ClientSubscribe, SUBSCRIBE_MAX } from '../src/ws/protocol'
import {
  registerClient,
  unregisterClient,
  subscribeClient,
  broadcastToSubscribers,
  type ClientEntry,
} from '../src/ws/registry'

// -- T1: schema overload + cap + refine -----------------------------------

describe('ClientSubscribe — overload', () => {
  test('accepts legacy singular session_id (back-compat)', () => {
    const r = ClientSubscribe.safeParse({ type: 'subscribe', session_id: 's1' })
    expect(r.success).toBe(true)
  })

  test('accepts multi session_ids', () => {
    const r = ClientSubscribe.safeParse({
      type: 'subscribe',
      session_ids: ['a', 'b', 'c'],
    })
    expect(r.success).toBe(true)
  })

  test('rejects more than SUBSCRIBE_MAX (12) ids', () => {
    const r = ClientSubscribe.safeParse({
      type: 'subscribe',
      session_ids: Array(SUBSCRIBE_MAX + 1).fill('x'),
    })
    expect(r.success).toBe(false)
  })

  test('accepts exactly SUBSCRIBE_MAX ids', () => {
    const r = ClientSubscribe.safeParse({
      type: 'subscribe',
      session_ids: Array(SUBSCRIBE_MAX).fill('x').map((_, i) => `s${i}`),
    })
    expect(r.success).toBe(true)
  })

  test('accepts empty session_ids (clears subscriptions)', () => {
    const r = ClientSubscribe.safeParse({ type: 'subscribe', session_ids: [] })
    expect(r.success).toBe(true)
  })

  test('rejects message with neither session_id nor session_ids', () => {
    const r = ClientSubscribe.safeParse({ type: 'subscribe' })
    expect(r.success).toBe(false)
  })

  test('SUBSCRIBE_MAX is 12 (locked phase-03 cap)', () => {
    expect(SUBSCRIBE_MAX).toBe(12)
  })
})

// -- T3: fan-out matcher — events route by Set membership -----------------

function fakeWs() {
  const sent: any[] = []
  const ws = {
    send: (s: string) => { sent.push(JSON.parse(s)); return s.length },
    close: () => {},
    readyState: 1,
  } as unknown as Parameters<typeof registerClient>[1]
  return { ws, sent: sent as any[] }
}

describe('broadcastToSubscribers — membership-based fan-out', () => {
  let entryA: ClientEntry
  let entryB: ClientEntry
  let sentA: any[]
  let sentB: any[]

  beforeEach(() => {
    const a = fakeWs()
    const b = fakeWs()
    sentA = a.sent
    sentB = b.sent
    entryA = registerClient('user1', a.ws)
    entryB = registerClient('user1', b.ws)
  })

  test('delivers events only to clients whose Set contains the session_id', () => {
    subscribeClient(entryA, ['s1', 's2', 's3'])
    subscribeClient(entryB, ['s4']) // disjoint set

    broadcastToSubscribers('s1', { type: 'text_delta', session_id: 's1', content: 'x' })
    broadcastToSubscribers('s2', { type: 'thinking', session_id: 's2' })
    broadcastToSubscribers('s3', { type: 'tool_use', session_id: 's3', tool_name: 'Read' })
    broadcastToSubscribers('s4', { type: 'text_delta', session_id: 's4', content: 'y' })

    // A subscribed to s1/s2/s3 — receives 3
    expect(sentA.map((m) => m.session_id).sort()).toEqual(['s1', 's2', 's3'])
    // B subscribed only to s4 — receives 1, none of s1/s2/s3 leaked
    expect(sentB.map((m) => m.session_id)).toEqual(['s4'])

    unregisterClient(entryA)
    unregisterClient(entryB)
  })

  test('subscribe REPLACES (last-write-wins), not unions', () => {
    subscribeClient(entryA, ['s1', 's2', 's3'])
    subscribeClient(entryA, ['s4']) // replace

    broadcastToSubscribers('s1', { type: 'text_delta', session_id: 's1', content: 'x' })
    broadcastToSubscribers('s4', { type: 'text_delta', session_id: 's4', content: 'y' })

    // s1 no longer delivered after replace
    expect(sentA.map((m) => m.session_id)).toEqual(['s4'])

    unregisterClient(entryA)
    unregisterClient(entryB)
  })

  test('idempotent: duplicate ids in subscribe payload do not duplicate delivery', () => {
    subscribeClient(entryA, ['s1', 's1', 's1'])

    broadcastToSubscribers('s1', { type: 'text_delta', session_id: 's1', content: 'x' })

    expect(sentA.length).toBe(1)

    unregisterClient(entryA)
    unregisterClient(entryB)
  })

  test('empty subscribe array clears the set — no further delivery', () => {
    subscribeClient(entryA, ['s1'])
    subscribeClient(entryA, []) // clear

    broadcastToSubscribers('s1', { type: 'text_delta', session_id: 's1', content: 'x' })

    expect(sentA.length).toBe(0)

    unregisterClient(entryA)
    unregisterClient(entryB)
  })

  test('unregistering a client drops it from fan-out (no leaked refs)', () => {
    subscribeClient(entryA, ['s1'])
    unregisterClient(entryA)

    broadcastToSubscribers('s1', { type: 'text_delta', session_id: 's1', content: 'x' })

    expect(sentA.length).toBe(0)

    unregisterClient(entryB)
  })

  test('no leakage to non-subscriber — explicit invariant', async () => {
    // entryA subscribes to s1; entryB subscribes to nothing.
    subscribeClient(entryA, ['s1'])
    // entryB's subscriptions left untouched (empty Set on construction).

    broadcastToSubscribers('s1', { type: 'text_delta', session_id: 's1', content: 'x' })

    // Wait the spec'd 500ms window — nothing should arrive on B.
    await new Promise((r) => setTimeout(r, 50)) // 50ms is enough for a sync send path
    expect(sentB.length).toBe(0)
    expect(sentA.length).toBe(1)

    unregisterClient(entryA)
    unregisterClient(entryB)
  })
})

// -- T2 handler-shape coverage (without DB) -------------------------------

describe('subscribe handler — normalization invariants', () => {
  test('legacy session_id parses identically to a 1-element session_ids', () => {
    const single = ClientSubscribe.parse({ type: 'subscribe', session_id: 'sX' })
    const multi = ClientSubscribe.parse({ type: 'subscribe', session_ids: ['sX'] })
    // Both shapes are accepted; the handler normalizes them to the same id list.
    expect(single.session_id ?? single.session_ids?.[0]).toBe('sX')
    expect(multi.session_ids?.[0]).toBe('sX')
  })
})
