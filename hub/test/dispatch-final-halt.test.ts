/**
 * PTYCAP-04: dispatch() wiring of the automation controls (REAL pipeline, the
 * controls module leaf-mocked with controllable spies):
 *   - preSendGuard before store.open (machine list and/or counterKey),
 *   - finalHaltCheck immediately before deps.send (after store.open/markDispatched),
 *   - releaseInject + slot release on every refusal/failure.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'

let factoryRuns = 0
const calls: string[] = []
const guardCalls: Array<{ req: any; opts: any }> = []
let guardResult: any = { ok: true, reserved: true }
let finalResult: any = { ok: true }
let onFinalCheck: (() => void) | null = null
const released: Array<{ counterKey: string; token: string }> = []

mock.module('../src/dispatch/automation-controls.ts', () => {
  factoryRuns++
  return {
    preSendGuard: async (req: any, opts: any) => {
      guardCalls.push({ req, opts })
      calls.push('guard')
      return guardResult
    },
    finalHaltCheck: async () => {
      calls.push('final')
      onFinalCheck?.()
      return finalResult
    },
    releaseInject: async (a: any) => {
      calls.push('release')
      released.push(a)
    },
  }
})

const pipeline = await import(`../src/dispatch/pipeline.ts?t=${Date.now()}`)
const { dispatch, _reset, KILL_SWITCH_GATE_NAME, SESSION_INJECT_RATE_GATE_NAME } = pipeline

const gate = (name: string) => ({ name, check: async () => ({ ok: true as const }) })
const makeDeps = (opts: { gates?: any[]; sendThrows?: boolean } = {}) => {
  const sent: string[] = []
  const skipped: Array<[string, string]> = []
  const failed: Array<[string, string]> = []
  const deps: any = {
    gates: opts.gates ?? [],
    store: {
      open: async (r: any) => {
        calls.push('open')
        return `run-${r.token}`
      },
      markDispatched: async () => {
        calls.push('markDispatched')
      },
      markSkipped: async (t: string, why: string) => {
        calls.push('markSkipped')
        skipped.push([t, why])
      },
      markFailed: async (t: string, why: string) => {
        failed.push([t, why])
      },
      onFinalize: async () => {},
    },
    isOnline: () => true,
    replay: async () => {},
    send: async (r: any) => {
      calls.push('send')
      if (opts.sendThrows) throw new Error('send_boom')
      sent.push(r.token)
    },
  }
  return { deps, sent, skipped, failed }
}
const R = (token: string, session = 's-fh', extra: Record<string, unknown> = {}) => ({
  userId: 'u1',
  sessionId: session,
  token,
  prompt: 'p',
  ...extra,
})

beforeEach(() => {
  _reset()
  calls.length = 0
  guardCalls.length = 0
  released.length = 0
  guardResult = { ok: true, reserved: true }
  finalResult = { ok: true }
  onFinalCheck = null
})
afterAll(() => {
  mock.restore()
})

describe('dispatch automation wiring', () => {
  test('a list containing the kill-switch gate (machine) with no counterKey calls preSendGuard with machine true', async () => {
    const { deps } = makeDeps({ gates: [gate(KILL_SWITCH_GATE_NAME)] })
    guardResult = { ok: true, reserved: false }
    const out = await dispatch(R('a'), deps)
    expect(out.kind).toBe('dispatched')
    expect(guardCalls.length).toBe(1)
    expect(guardCalls[0]!.opts.machine).toBe(true)
  })

  test('a list without the kill-switch gate and no counterKey never imports or calls the controls module', async () => {
    const before = factoryRuns
    const { deps } = makeDeps({ gates: [gate('threshold')] })
    const out = await dispatch(R('b', 's-plain'), deps)
    expect(out.kind).toBe('dispatched')
    expect(guardCalls.length).toBe(0)
    expect(calls).not.toContain('guard')
    expect(calls).not.toContain('final')
    expect(factoryRuns).toBe(before) // not even imported by THIS dispatch
  })

  test('the session inject-rate gate in the list sets enforceRate true; without it false', async () => {
    const withRate = makeDeps({ gates: [gate(KILL_SWITCH_GATE_NAME), gate(SESSION_INJECT_RATE_GATE_NAME)] })
    await dispatch(R('c1', 's-rate1', { counterKey: 'task:T' }), withRate.deps)
    expect(guardCalls[0]!.opts).toEqual({ machine: true, enforceRate: true })
    const noRate = makeDeps({ gates: [gate(KILL_SWITCH_GATE_NAME)] })
    await dispatch(R('c2', 's-rate2', { counterKey: 'task:T' }), noRate.deps)
    expect(guardCalls[1]!.opts).toEqual({ machine: true, enforceRate: false })
  })

  test('a guard block -> skipped with the reason, markSkipped(token, reason), and the slot is freed', async () => {
    const { deps, skipped, sent } = makeDeps({ gates: [gate(KILL_SWITCH_GATE_NAME)] })
    guardResult = { ok: false, reason: 'lifetime_inject_exhausted:3>=3' }
    const out = await dispatch(R('d1', 's-slot', { counterKey: 'task:T' }), deps)
    expect(out).toEqual({ kind: 'skipped', reason: 'lifetime_inject_exhausted:3>=3' })
    expect(skipped).toEqual([['d1', 'lifetime_inject_exhausted:3>=3']])
    expect(calls).not.toContain('open') // refused BEFORE the run row opens
    expect(sent.length).toBe(0)
    guardResult = { ok: true, reserved: true }
    const next = await dispatch(R('d2', 's-slot', { counterKey: 'task:T' }), deps)
    expect(next.kind).toBe('dispatched') // not session_busy
  })

  test('a halt that flips AFTER store.open/markDispatched blocks the send, releases the reservation, marks the opened run skipped, frees the slot', async () => {
    const { deps, skipped, sent } = makeDeps({ gates: [gate(KILL_SWITCH_GATE_NAME)] })
    finalResult = { ok: false, reason: 'automation_halted:global' }
    const out = await dispatch(R('e1', 's-halt', { counterKey: 'task:T' }), deps)
    expect(out).toEqual({ kind: 'skipped', reason: 'automation_halted:global' })
    expect(sent.length).toBe(0)
    expect(calls).not.toContain('send')
    expect(released).toEqual([{ counterKey: 'task:T', token: 'e1' }])
    expect(skipped).toEqual([['run-e1', 'automation_halted:global']]) // the OPENED run id
    // order proof: guard -> open -> markDispatched -> final, no send
    expect(calls.slice(0, 4)).toEqual(['guard', 'open', 'markDispatched', 'final'])
    finalResult = { ok: true }
    const next = await dispatch(R('e2', 's-halt', { counterKey: 'task:T' }), deps)
    expect(next.kind).toBe('dispatched')
  })

  test('halt without a reservation (no counterKey) does not call releaseInject', async () => {
    const { deps } = makeDeps({ gates: [gate(KILL_SWITCH_GATE_NAME)] })
    guardResult = { ok: true, reserved: false }
    finalResult = { ok: false, reason: 'automation_halted:user' }
    const out = await dispatch(R('f1', 's-halt2'), deps)
    expect(out.kind).toBe('skipped')
    expect(released.length).toBe(0)
  })

  test('final check passes -> send runs once; a send throw releases the reservation once and fails', async () => {
    const ok = makeDeps({ gates: [gate(KILL_SWITCH_GATE_NAME)] })
    const first = await dispatch(R('g1', 's-send1', { counterKey: 'task:T' }), ok.deps)
    expect(first.kind).toBe('dispatched')
    expect(ok.sent).toEqual(['g1'])
    expect(released.length).toBe(0)

    const bad = makeDeps({ gates: [gate(KILL_SWITCH_GATE_NAME)], sendThrows: true })
    const out = await dispatch(R('g2', 's-send2', { counterKey: 'task:T' }), bad.deps)
    expect(out).toEqual({ kind: 'failed', reason: 'send_boom' })
    expect(released).toEqual([{ counterKey: 'task:T', token: 'g2' }])
    expect(bad.failed).toEqual([['run-g2', 'send_boom']])
    const next = await dispatch(R('g3', 's-send2', { counterKey: 'task:T' }), ok.deps)
    expect(next.kind).toBe('dispatched') // slot freed after the failure
  })

  test('a counterKey on a non-machine list reserves with machine false', async () => {
    const { deps } = makeDeps({ gates: [gate('threshold')] })
    const out = await dispatch(R('h1', 's-key', { counterKey: 'session:s-key' }), deps)
    expect(out.kind).toBe('dispatched')
    expect(guardCalls[0]!.opts).toEqual({ machine: false, enforceRate: false })
    expect(calls).not.toContain('final') // final halt check is machine-only
  })
})
