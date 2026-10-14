/**
 * PTYCAP-04 TRACER: one orchestrator inject (online path) is counted in a durable
 * ledger BEFORE the send, refused once the lifetime cap is reached, refused when a
 * kill-switch row is engaged, re-checked for halt immediately before the send,
 * released on failure, and never strands the in-flight slot.
 *
 * REAL dispatch() pipeline, REAL automation-controls, REAL injectOrchestratorPrompt;
 * only the sql tag (in-memory fake), the persisted chat message and the spend
 * gates are stand-ins. The real SQL is proven against Postgres by
 * test/e2e/automation-controls-checks.ts (called from an existing e2e test).
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { createFakeSql } from './fixtures/automation-fake-sql.ts'

const fake = createFakeSql()
const { state } = fake

mock.module('../src/db/postgres.ts', () => ({ sql: fake.sql }))

// Spend gates: pass-through with their REAL names (they are not under test here).
const realGates = await import(`../src/dispatch/gates.ts?t=${Date.now()}`)
const pass = (name: string) => ({ name, check: async () => ({ ok: true as const }) })
mock.module('../src/dispatch/gates.ts', () => ({
  ...realGates,
  thresholdGate: pass(realGates.thresholdGate.name),
  dailyCostCapGate: pass(realGates.dailyCostCapGate.name),
  dailyTokenCapGate: pass(realGates.dailyTokenCapGate.name),
  sessionInjectRateGate: pass(realGates.sessionInjectRateGate.name),
}))
const pages: any[] = []
const realNotify = await import(`../src/orchestrator/notify.ts?t=${Date.now()}`)
mock.module('../src/orchestrator/notify.ts', () => ({
  ...realNotify,
  fanOutNotify: async (i: any) => {
    pages.push(i)
    return { delivered: [] }
  },
}))
const realDal = await import(`../src/db/dal.ts?t=${Date.now()}`)
mock.module('../src/db/dal.ts', () => ({
  ...realDal,
  insertMessage: async () => ({ id: 'm1', created_at: new Date().toISOString() }),
}))

const { injectOrchestratorPrompt } = await import(`../src/orchestrator/inject.ts?t=${Date.now()}`)
const { _reset, onSessionReply, dispatch } = await import('../src/dispatch/pipeline.ts')
const C = await import('../src/dispatch/automation-controls.ts')

const ENV = ['REMO_AUTOMATION_LIFETIME_INJECT_CAP', 'REMO_AUTOMATION_KILL_SWITCH', 'REMO_ORCHESTRATOR_MAX_INJECTS_PER_HOUR']
const saved: Record<string, string | undefined> = {}
let wsSends: string[] = []
let wsThrows = false

function deps(over: Record<string, unknown> = {}): any {
  return {
    dispatch,
    getChannel: () => ({
      ws: {
        send: (frame: string) => {
          if (wsThrows) throw new Error('ws_boom')
          wsSends.push(frame)
        },
      },
    }),
    isSessionLive: async () => true,
    resolveCounterKey: async () => 'task:T1',
    ...over,
  }
}
const input = (token: string, over: Record<string, unknown> = {}) => ({
  userId: 'u1',
  sessionId: 's1',
  token,
  prompt: 'do the thing',
  ...over,
})
/** inject, then finalize the turn so the session slot frees (real reply path) */
async function injectAndFinish(token: string, d: any = deps()) {
  const out = await injectOrchestratorPrompt(input(token), d)
  if (out.kind === 'dispatched') await onSessionReply('s1', 'done')
  return out
}
const injectRows = () => state.ledger.filter((r) => r.kind === 'inject')

beforeEach(() => {
  for (const k of ENV) {
    saved[k] = process.env[k]
    delete process.env[k]
  }
  process.env.REMO_ORCHESTRATOR_MAX_INJECTS_PER_HOUR = '100'
  _reset()
  state.ledger.length = 0
  state.kill.length = 0
  state.runlog.length = 0
  state.tasks.length = 0
  state.statements.length = 0
  state.unknown.length = 0
  state.failOn = null
  state.hook = null
  state.seq = 0
  pages.length = 0
  wsSends = []
  wsThrows = false
})
afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  _reset()
  expect(state.unknown).toEqual([])
})
afterAll(() => {
  mock.restore()
})

describe('PTYCAP-04 tracer (real dispatch + real controls + real inject)', () => {
  test('cap 2: a and b dispatch, c is refused lifetime_inject_exhausted:2>=2; ledger holds exactly 2 rows; send ran twice', async () => {
    process.env.REMO_AUTOMATION_LIFETIME_INJECT_CAP = '2'
    expect((await injectAndFinish('orch:s1:a')).kind).toBe('dispatched')
    expect((await injectAndFinish('orch:s1:b')).kind).toBe('dispatched')
    const c = await injectAndFinish('orch:s1:c')
    expect(c).toEqual({ kind: 'refused', reason: 'lifetime_inject_exhausted:2>=2' })
    expect(injectRows().length).toBe(2)
    expect(injectRows().map((r) => r.token)).toEqual(['orch:s1:a', 'orch:s1:b'])
    expect(injectRows().every((r) => r.counter_key === 'task:T1' && r.released_at === null)).toBe(true)
    expect(wsSends.length).toBe(2)
    // one 80 percent warning page (at b) and one exhaustion page (at c), nothing more
    expect(pages.length).toBe(2)
    expect(pages[0].detail).toContain('80 percent warning')
    expect(pages[1].detail).toContain('EXHAUSTED')
    expect((await injectAndFinish('orch:s1:d')).kind).toBe('refused')
    expect(pages.length).toBe(2)
  })

  test('the reservation is written BEFORE the send reaches the agent socket', async () => {
    let ledgerAtSend = -1
    const d = deps({
      getChannel: () => ({ ws: { send: () => { ledgerAtSend = injectRows().length; wsSends.push('x') } } }),
    })
    expect((await injectAndFinish('orch:s1:a', d)).kind).toBe('dispatched')
    expect(ledgerAtSend).toBe(1)
  })

  test('the same token twice is one ledger row and an idempotent proceed', async () => {
    expect((await injectAndFinish('orch:s1:same')).kind).toBe('dispatched')
    expect((await injectAndFinish('orch:s1:same')).kind).toBe('dispatched')
    expect(injectRows().length).toBe(1)
    expect(wsSends.length).toBe(2)
  })

  test('an engaged global kill-switch row refuses automation_halted:global; no send, zero ledger rows', async () => {
    await C.engageKillSwitch({ scope: 'global', engagedBy: 'admin' })
    const out = await injectOrchestratorPrompt(input('orch:s1:a'), deps())
    expect(out).toEqual({ kind: 'refused', reason: 'automation_halted:global' })
    expect(wsSends.length).toBe(0)
    expect(state.ledger.length).toBe(0)
  })

  test('a kill-switch select that throws refuses (fail closed); no send', async () => {
    state.failOn = (t) => t.includes('FROM automation_kill_switch')
    const out = await injectOrchestratorPrompt(input('orch:s1:a'), deps())
    expect(out).toEqual({ kind: 'refused', reason: 'automation_halted:error' })
    expect(wsSends.length).toBe(0)
    expect(state.ledger.length).toBe(0)
  })

  test('a halt that lands AFTER the run row opened never sends; the reservation is released; the slot is freed', async () => {
    // Engage the global switch the instant the reservation row is written: the gate
    // stage and the pre-send guard already passed, only the final check can stop it.
    state.hook = (text) => {
      if (text.includes("'inject')") && state.kill.length === 0) {
        state.kill.push({
          id: 'ks', scope: 'global', user_id: null, session_id: null, engaged: true, reason: 'test',
          engaged_by: 'admin', engaged_at: Date.now(), released_by: null, released_at: null,
        })
      }
    }
    const out = await injectOrchestratorPrompt(input('orch:s1:a'), deps())
    expect(out).toEqual({ kind: 'refused', reason: 'automation_halted:global' })
    expect(wsSends.length).toBe(0)
    expect(injectRows().length).toBe(1)
    expect(injectRows()[0]!.released_at).not.toBeNull() // append-only compensation
    state.hook = null
    await C.releaseKillSwitch({ scope: 'global', releasedBy: 'admin' })
    expect((await injectAndFinish('orch:s1:b')).kind).toBe('dispatched') // not session_busy
    expect(wsSends.length).toBe(1)
  })

  test('a send that throws -> failed; released_at stamped; the count excludes it; the next inject dispatches', async () => {
    process.env.REMO_AUTOMATION_LIFETIME_INJECT_CAP = '1'
    wsThrows = true
    const out = await injectOrchestratorPrompt(input('orch:s1:a'), deps())
    expect(out.kind).toBe('failed')
    expect(injectRows().length).toBe(1)
    expect(injectRows()[0]!.released_at).not.toBeNull()
    expect(await C.lifetimeCounterCheck({ userId: 'u1', sessionId: 's1', token: 'x', prompt: '', counterKey: 'task:T1' })).toEqual({ ok: true })
    wsThrows = false
    expect((await injectAndFinish('orch:s1:b')).kind).toBe('dispatched') // cap 1, but the failed one was released
    expect(wsSends.length).toBe(1)
  })

  test('an exhaustion refusal does not strand the slot: after the cap is raised the next dispatch proceeds (not session_busy)', async () => {
    process.env.REMO_AUTOMATION_LIFETIME_INJECT_CAP = '1'
    expect((await injectAndFinish('orch:s1:a')).kind).toBe('dispatched')
    expect((await injectAndFinish('orch:s1:b')).kind).toBe('refused')
    process.env.REMO_AUTOMATION_LIFETIME_INJECT_CAP = '2'
    expect((await injectAndFinish('orch:s1:b')).kind).toBe('dispatched')
    expect(injectRows().length).toBe(2)
  })

  test('cap env garbage -> lifetimeInjectCap() is 1000', () => {
    process.env.REMO_AUTOMATION_LIFETIME_INJECT_CAP = 'garbage'
    expect(C.lifetimeInjectCap()).toBe(1000)
  })

  test('a counter-key resolver failure fails closed: no dispatch, no send', async () => {
    const out = await injectOrchestratorPrompt(
      input('orch:s1:a'),
      deps({ resolveCounterKey: async () => { throw new Error('db_down') } }),
    )
    expect(out.kind).toBe('failed')
    expect((out as any).reason).toContain('counter_key_unresolved')
    expect(wsSends.length).toBe(0)
    expect(state.ledger.length).toBe(0)
  })

  test('with no taskId the default resolver uses the 1:1 orchestrator task: the ledger key is task:<id>', async () => {
    state.tasks.push({ id: 'T77', session_id: 's1', task_type: 'orchestrator' })
    const d = deps()
    delete d.resolveCounterKey
    expect((await injectAndFinish('orch:s1:a', d)).kind).toBe('dispatched')
    expect(injectRows()[0]!.counter_key).toBe('task:T77')
    const d2 = deps()
    delete d2.resolveCounterKey
    expect((await injectOrchestratorPrompt({ ...input('orch:s1:b'), taskId: 'T9' }, d2)).kind).toBe('dispatched')
    expect(injectRows().map((r) => r.counter_key)).toEqual(['task:T77', 'task:T9'])
  })
})
