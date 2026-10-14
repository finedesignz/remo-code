/**
 * PTYCAP-04-03 Task 4: pipeline-level reserve / release / idempotency / promotion /
 * final-check semantics, with the controls module LEAF-MOCKED by a controllable
 * preSendGuard spy plus a tiny in-memory ledger. (The real SQL of the controls module
 * is covered by automation-controls-core.test.ts and the CI-only Postgres checks.)
 */
import { describe, test, expect, beforeEach, afterAll, mock } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const guardCalls: Array<{ req: any; opts: any }> = []
const finalCalls: any[] = []
const released: Array<{ counterKey: string; token: string }> = []
/** in-memory ledger: one row per (counterKey|token), like the unique index */
const ledger = new Map<string, { released: boolean }>()
let guardResult: any = null // null => emulate the ledger
let finalResult: any = { ok: true }

mock.module('../src/dispatch/automation-controls.ts', () => ({
  preSendGuard: async (req: any, opts: any) => {
    guardCalls.push({ req, opts })
    if (guardResult) return guardResult
    if (!req.counterKey) return { ok: true, reserved: false }
    const k = `${req.counterKey}|${req.token}`
    if (!ledger.has(k)) ledger.set(k, { released: false })
    else ledger.get(k)!.released = false // token idempotency: same row re-used
    return { ok: true, reserved: true }
  },
  finalHaltCheck: async (req: any) => {
    finalCalls.push(req)
    return finalResult
  },
  releaseInject: async (a: any) => {
    released.push(a)
    const row = ledger.get(`${a.counterKey}|${a.token}`)
    if (row) row.released = true
  },
}))

const pipeline = await import(`../src/dispatch/pipeline.ts?t=${Date.now()}`)
const { dispatch, onSessionReply, _reset, KILL_SWITCH_GATE_NAME } = pipeline

let halted = false
const killGate = {
  name: KILL_SWITCH_GATE_NAME,
  check: async () => (halted ? { ok: false as const, reason: 'automation_halted:global' } : { ok: true as const }),
}
const plainGate = { name: 'threshold', check: async () => ({ ok: true as const }) }

function makeDeps(opts: { gates?: any[]; sendThrows?: boolean } = {}) {
  const sent: string[] = []
  const skipped: Array<[string, string]> = []
  const deps: any = {
    gates: opts.gates ?? [],
    store: {
      open: async (r: any) => `run-${r.token}`,
      markDispatched: async () => {},
      markSkipped: async (t: string, why: string) => {
        skipped.push([t, why])
      },
      markFailed: async () => {},
      onFinalize: async () => {},
    },
    isOnline: () => true,
    replay: async () => {},
    send: async (r: any) => {
      if (opts.sendThrows) throw new Error('send_boom')
      sent.push(r.token)
    },
  }
  return { deps, sent, skipped }
}
const R = (token: string, session = 's-r', extra: Record<string, unknown> = {}) => ({
  userId: 'u1',
  sessionId: session,
  token,
  prompt: 'p',
  ...extra,
})

beforeEach(() => {
  _reset()
  guardCalls.length = 0
  finalCalls.length = 0
  released.length = 0
  ledger.clear()
  guardResult = null
  finalResult = { ok: true }
  halted = false
})
afterAll(() => {
  mock.restore()
})

describe('dispatch reserve semantics (D-02, D-03, D-09, D-10, D-18)', () => {
  test('no counterKey and no kill-switch gate: preSendGuard is never called', async () => {
    const { deps } = makeDeps({ gates: [plainGate] })
    const out = await dispatch(R('a1'), deps)
    expect(out.kind).toBe('dispatched')
    expect(guardCalls).toHaveLength(0)
    expect(finalCalls).toHaveLength(0)
  })

  test('counterKey: preSendGuard once with machine false; kill-switch gate: machine true even without a key, and the final re-check runs', async () => {
    const keyed = makeDeps({ gates: [plainGate] })
    await dispatch(R('b1', 's-b1', { counterKey: 'task:T' }), keyed.deps)
    expect(guardCalls).toHaveLength(1)
    expect(guardCalls[0].opts.machine).toBe(false)
    expect(finalCalls).toHaveLength(0)

    guardCalls.length = 0
    const killOnly = makeDeps({ gates: [killGate] })
    await dispatch(R('b2', 's-b2'), killOnly.deps)
    expect(guardCalls).toHaveLength(1)
    expect(guardCalls[0].opts.machine).toBe(true)
    expect(finalCalls).toHaveLength(1) // kill-only adapters still get the final re-check (D-09c)
  })

  test('guard block: skipped with the guard reason, markSkipped called, slot freed for the next dispatch', async () => {
    const { deps, skipped, sent } = makeDeps({ gates: [killGate] })
    guardResult = { ok: false, reason: 'lifetime_inject_exhausted:3>=3' }
    const out = await dispatch(R('c1', 's-c', { counterKey: 'task:T' }), deps)
    expect(out).toEqual({ kind: 'skipped', reason: 'lifetime_inject_exhausted:3>=3' })
    expect(skipped).toEqual([['c1', 'lifetime_inject_exhausted:3>=3']])
    expect(sent).toHaveLength(0)
    guardResult = null
    const next = await dispatch(R('c2', 's-c', { counterKey: 'task:T' }), deps)
    expect(next.kind).toBe('dispatched')
  })

  test('same token twice (second after the first finished): same token reaches the guard both times, ONE ledger row', async () => {
    const { deps } = makeDeps({ gates: [killGate] })
    expect((await dispatch(R('tok-1', 's-d', { counterKey: 'task:T' }), deps)).kind).toBe('dispatched')
    await onSessionReply('s-d', 'done')
    expect((await dispatch(R('tok-1', 's-d', { counterKey: 'task:T' }), deps)).kind).toBe('dispatched')
    expect(guardCalls.map((c) => c.req.token)).toEqual(['tok-1', 'tok-1'])
    expect(ledger.size).toBe(1)
  })

  test('a queued waiter promoted after the head finishes is RE-GATED: a halt engaged between enqueue and promotion drops it', async () => {
    const { deps, skipped, sent } = makeDeps({ gates: [killGate] })
    const head = await dispatch(R('h1', 's-e', { counterKey: 'task:T' }), deps)
    const waiter = await dispatch(R('w1', 's-e', { counterKey: 'task:T' }), deps)
    expect(head.kind).toBe('dispatched')
    expect(waiter.kind).toBe('queued')
    expect(guardCalls).toHaveLength(1) // a queued request is never counted
    halted = true // engage between enqueue and promotion
    await onSessionReply('s-e', 'head done')
    expect(sent).toEqual(['h1']) // the waiter never sent
    expect(skipped).toEqual([['w1', 'automation_halted:global']])
    expect(ledger.has('task:T|w1')).toBe(false)
  })

  test('a queued waiter promoted with no halt is gated again, counted once, and sent', async () => {
    const { deps, sent } = makeDeps({ gates: [killGate] })
    await dispatch(R('h2', 's-f', { counterKey: 'task:T' }), deps)
    await dispatch(R('w2', 's-f', { counterKey: 'task:T' }), deps)
    await onSessionReply('s-f', 'head done')
    expect(sent).toEqual(['h2', 'w2'])
    expect(guardCalls.map((c) => c.req.token)).toEqual(['h2', 'w2'])
    expect(ledger.size).toBe(2)
  })

  test('send throws: releaseInject once with counterKey and token; send ok: not released', async () => {
    const ok = makeDeps({ gates: [killGate] })
    await dispatch(R('g1', 's-g1', { counterKey: 'task:T' }), ok.deps)
    expect(released).toHaveLength(0)

    const bad = makeDeps({ gates: [killGate], sendThrows: true })
    const out = await dispatch(R('g2', 's-g2', { counterKey: 'task:T' }), bad.deps)
    expect(out).toEqual({ kind: 'failed', reason: 'send_boom' })
    expect(released).toEqual([{ counterKey: 'task:T', token: 'g2' }])
    expect(ledger.get('task:T|g2')!.released).toBe(true)
  })

  test('final halt after open releases the reservation and sends nothing', async () => {
    const { deps, sent } = makeDeps({ gates: [killGate] })
    finalResult = { ok: false, reason: 'automation_halted:user' }
    const out = await dispatch(R('i1', 's-i', { counterKey: 'task:T' }), deps)
    expect(out).toEqual({ kind: 'skipped', reason: 'automation_halted:user' })
    expect(sent).toHaveLength(0)
    expect(released).toEqual([{ counterKey: 'task:T', token: 'i1' }])
  })

  test('reason prefix contract (D-12): the controls module emits exactly automation_halted:<scope> and lifetime_inject_exhausted:<n>>=<cap>', () => {
    const src = readFileSync(join(import.meta.dir, '..', 'src', 'dispatch', 'automation-controls.ts'), 'utf8')
    expect(src).toContain('`automation_halted:${')
    expect(src).toContain('`lifetime_inject_exhausted:${')
    expect(src).toMatch(/lifetime_inject_exhausted:\$\{[^}]+\}>=\$\{[^}]+\}/)
  })
})
