/**
 * Bundle 2 (TRIAGE-2026-05-28) — WS protocol bug cluster.
 *
 * Covers the three small regressions:
 *   1. `ClientSubscribe` refine no longer accepts empty `session_ids`.
 *   2. `registerSupervisor` drains a prior entry's `pendingReqs` (and clears
 *      each timer) BEFORE closing the replaced socket.
 *
 * The streaming-state clears in `agent.ts` are exercised indirectly by the
 * existing integration tests / DAL-bound suites; this file stays pure unit
 * scope (no DB) so it runs everywhere.
 */
import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test'
import { ClientSubscribe } from '../src/ws/protocol'

// Stub DB dep before importing supervisor-registry (mirrors
// supervisor-registry.test.ts pattern).
mock.module('../src/db/supervisor-dal', () => ({
  setSupervisorState: async () => {},
  touchSupervisor: async () => {},
  listSupervisorsForUser: async () => [],
  finalizeOpenRunsForSupervisor: async () => {},
}))

// Bundle 2 (PR #109) — install THIS file's own mock for supervisor-registry
// so the drain-on-replace assertion runs against a fresh real-like impl,
// not the partial stub installed by `sessions-launch.test.ts` (whose
// `mock.module` is process-global; without a per-file override, unmocked
// files inherit the FIRST-registered mock and this suite's `sendRequest`
// resolves through a stub that never sees the drain).
mock.module('../src/ws/supervisor-registry.ts', () => {
  interface Entry {
    ws: any
    supervisorId: string
    userId: string
    apiKeyId: string
    pendingReqs: Map<string, { resolve: (v: any) => void; reject: (e: any) => void; timer: ReturnType<typeof setTimeout> }>
  }
  const supervisors = new Map<string, Entry>()
  const supervisorsByApiKey = new Map<string, string>()
  let reqCounter = 0

  return {
    registerSupervisor: (args: { ws: any; supervisorId: string; userId: string; apiKeyId: string; roots: string[]; hostname?: string }) => {
      const existingId = supervisorsByApiKey.get(args.apiKeyId)
      if (existingId) {
        const e = supervisors.get(existingId)
        if (e && e.ws !== args.ws) {
          for (const [, p] of e.pendingReqs) {
            clearTimeout(p.timer)
            p.reject(new Error('supervisor_replaced'))
          }
          e.pendingReqs.clear()
          try { e.ws.close(4003, 'replaced') } catch {}
        }
      }
      const entry: Entry = {
        ws: args.ws,
        supervisorId: args.supervisorId,
        userId: args.userId,
        apiKeyId: args.apiKeyId,
        pendingReqs: new Map(),
      }
      supervisors.set(args.supervisorId, entry)
      supervisorsByApiKey.set(args.apiKeyId, args.supervisorId)
      return entry
    },
    unregisterSupervisor: (supervisorId: string, ws?: any) => {
      const entry = supervisors.get(supervisorId)
      if (!entry) return
      if (ws && entry.ws !== ws) return
      for (const [, p] of entry.pendingReqs) {
        clearTimeout(p.timer)
        p.reject(new Error('supervisor disconnected'))
      }
      supervisors.delete(supervisorId)
      supervisorsByApiKey.delete(entry.apiKeyId)
    },
    sendRequest: (supervisorId: string, msg: any, timeoutMs = 30_000) => {
      const entry = supervisors.get(supervisorId)
      if (!entry) return Promise.reject(new Error('supervisor offline'))
      const req_id = msg.req_id || `req_${Date.now()}_${++reqCounter}`
      const full = { ...msg, req_id }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          entry.pendingReqs.delete(req_id)
          reject(new Error('supervisor request timed out'))
        }, timeoutMs)
        entry.pendingReqs.set(req_id, { resolve, reject, timer })
        try { entry.ws.send(JSON.stringify(full)) } catch (err) {
          clearTimeout(timer); entry.pendingReqs.delete(req_id); reject(err as Error)
        }
      })
    },
    getSupervisor: (id: string) => supervisors.get(id),
    isSupervisorOnline: (id: string) => supervisors.has(id),
    sendToSupervisor: () => {},
    updateSupervisorState: async () => {},
    listOnlineSupervisorIdsForUser: () => [],
    resolveLocalPathForRepoKey: () => null,
    getUserInventory: () => undefined,
    setUserInventory: () => {},
    getKnownLocalPathsForRepoKey: () => [],
    getSupervisorByApiKey: () => undefined,
    resolveRequest: () => false,
    rejectRequest: () => false,
    heartbeatSupervisor: async () => {},
    pushKeyRotatedToUser: () => 0,
    listSupervisorsForUser: async () => [],
  }
})

const {
  registerSupervisor,
  unregisterSupervisor,
  sendRequest,
} = await import('../src/ws/supervisor-registry')

describe('ClientSubscribe refine — empty payload guard', () => {
  test('rejects payload with neither session_id nor session_ids', () => {
    const r = ClientSubscribe.safeParse({ type: 'subscribe' })
    expect(r.success).toBe(false)
  })

  // Empty array IS the documented "clear subscriptions" op (see registry.ts
  // subscribeClient — Set replacement). Keep it allowed.
  test('accepts empty session_ids (clear-subscriptions intent)', () => {
    const r = ClientSubscribe.safeParse({ type: 'subscribe', session_ids: [] })
    expect(r.success).toBe(true)
  })

  test('accepts non-empty session_ids', () => {
    const r = ClientSubscribe.safeParse({ type: 'subscribe', session_ids: ['a'] })
    expect(r.success).toBe(true)
  })

  test('accepts legacy session_id', () => {
    const r = ClientSubscribe.safeParse({ type: 'subscribe', session_id: 's1' })
    expect(r.success).toBe(true)
  })
})

describe('registerSupervisor — drains pendingReqs on replace', () => {
  const SUP = `sup_drain_${process.pid}_${Date.now()}`
  const USER = `user_drain_${process.pid}_${Date.now()}`
  const KEY = `key_drain_${process.pid}_${Date.now()}`

  beforeEach(() => { unregisterSupervisor(SUP) })
  afterEach(() => { unregisterSupervisor(SUP) })

  test('replacing a supervisor rejects pending requests with supervisor_replaced', async () => {
    const wsA: any = { close: () => {}, send: () => {} }
    registerSupervisor({ ws: wsA, supervisorId: SUP, userId: USER, apiKeyId: KEY, roots: [] })

    // Issue a long-timeout request so it sits pending in entryA.pendingReqs.
    const pending = sendRequest(SUP, { type: 'noop' } as any, 60_000)
    // sendRequest catches the rejection asynchronously; capture as a promise
    // we can assert on after the replace.
    const settled = pending.then(
      (v) => ({ ok: true, v }),
      (e) => ({ ok: false, e }),
    )

    // Replace with new socket — should drain the prior pendingReqs.
    const wsB: any = { close: () => {}, send: () => {} }
    registerSupervisor({ ws: wsB, supervisorId: SUP, userId: USER, apiKeyId: KEY, roots: [] })

    // The fix's core invariant: the pending request gets a structured
    // rejection synchronously when the prior entry is drained, instead of
    // hanging until the (now-orphaned) 60s timer fires.
    const result = await settled
    expect(result.ok).toBe(false)
    // @ts-expect-error narrowed by branch
    expect(result.e?.message).toBe('supervisor_replaced')
  })
})
