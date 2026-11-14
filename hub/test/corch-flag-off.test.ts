// CORCH-01 (CORCH-R1.2): with REMO_CORCH_ENABLED unset the dispatcher, reconciler and every trigger are
// a true no-op: zero store, launch, dispatch, notify, inventory and timer calls.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-chars-long-aaaaaaaa'

import { describe, test, expect, afterEach } from 'bun:test'
import { createCorchDispatcher, onSupervisorHello, onSupervisorClosed, onKillSwitchReleased, evaluateUserNow } from '../src/corch/dispatcher.ts'
import { startCorchReconciler, startCorch, reconcilePass } from '../src/corch/reconciler.ts'
import * as dispatcherModule from '../src/corch/dispatcher.ts'

const savedFlag = process.env.REMO_CORCH_ENABLED
afterEach(() => {
  if (savedFlag === undefined) delete process.env.REMO_CORCH_ENABLED
  else process.env.REMO_CORCH_ENABLED = savedFlag
})

/** An object whose every property is a spy that records its call and would fail the test's expectations. */
function spyObject(label: string, calls: string[]): any {
  return new Proxy(
    {},
    {
      get: (_t, prop) => (..._a: unknown[]) => {
        calls.push(`${label}.${String(prop)}`)
        throw new Error(`flag OFF but ${label}.${String(prop)} was called`)
      },
    },
  )
}

function spyDeps(calls: string[]): any {
  const fn = (label: string) => (..._a: unknown[]) => {
    calls.push(label)
    throw new Error(`flag OFF but ${label} was called`)
  }
  return {
    store: spyObject('store', calls),
    workspace: spyObject('workspace', calls),
    launch: spyObject('launch', calls),
    launchCommand: 'x',
    quota: spyObject('quota', calls),
    pipeline: spyObject('pipeline', calls),
    dispatch: fn('dispatch'),
    prLookup: spyObject('prLookup', calls),
    notify: fn('notify'),
    inventory: spyObject('inventory', calls),
    timers: { setTimeout: fn('timers.setTimeout'), clearTimeout: fn('timers.clearTimeout') },
  }
}

describe('flag OFF is a true no-op (CORCH-R1.2)', () => {
  test('evaluateUser, evaluateAll, armNotBeforeTimer touch nothing', async () => {
    delete process.env.REMO_CORCH_ENABLED
    const calls: string[] = []
    const d = createCorchDispatcher(spyDeps(calls))
    expect(await d.evaluateUser('u1')).toEqual({ kind: 'disabled' })
    await d.evaluateAll()
    await d.armNotBeforeTimer()
    await d.onSupervisorClosed('sup-1')
    expect(calls).toEqual([])
  })

  test('startCorchReconciler starts no interval and touches no dep', () => {
    delete process.env.REMO_CORCH_ENABLED
    const calls: string[] = []
    const realSetInterval = globalThis.setInterval
    let intervals = 0
    ;(globalThis as any).setInterval = (...a: unknown[]) => {
      intervals++
      return (realSetInterval as any)(...a)
    }
    try {
      const deps = spyDeps(calls)
      const stop = startCorchReconciler(deps, createCorchDispatcher(deps))
      expect(typeof stop).toBe('function')
      stop()
    } finally {
      ;(globalThis as any).setInterval = realSetInterval
    }
    expect(intervals).toBe(0)
    expect(calls).toEqual([])
  })

  test('reconcilePass reads nothing while OFF', async () => {
    delete process.env.REMO_CORCH_ENABLED
    const calls: string[] = []
    const deps = spyDeps(calls)
    await reconcilePass(deps, createCorchDispatcher(deps))
    expect(calls).toEqual([])
  })

  test('exported triggers resolve without constructing the singleton', async () => {
    delete process.env.REMO_CORCH_ENABLED
    expect(dispatcherModule.corchSingletonConstructed()).toBe(false)
    await onSupervisorHello('u1')
    await onSupervisorClosed('sup-1')
    await onKillSwitchReleased('global', 'u1')
    await onKillSwitchReleased('user', 'u1')
    await evaluateUserNow('u1')
    await startCorch()
    // getCorch() is the only constructor of the singleton and the real deps are built inside it.
    expect(dispatcherModule.corchSingletonConstructed()).toBe(false)
  })
})

describe('flag OFF: quota ingest still stores and never constructs the dispatcher (CORCH-02, LD-Q11)', () => {
  test('a successful POST stores the row, evaluates nothing, and builds no singleton', async () => {
    delete process.env.REMO_CORCH_ENABLED
    const { createQuotaRoutes, defaultQuotaEvaluate } = await import('../src/api/quota.ts')
    const upserts: string[] = []
    const app = createQuotaRoutes({
      verifyKey: async () => ({ id: 'k1', user_id: 'user-A', scopes: ['quota:publish'] }),
      store: { upsertSnapshot: async (u, a) => (upserts.push(u), a.length), accountsFor: async () => [] },
      ceilingPct: () => 55,
      evaluate: defaultQuotaEvaluate,
      now: () => new Date(),
    })
    const res = await app.request('/snapshot', {
      method: 'POST',
      headers: { Authorization: 'Bearer remokey_x' },
      body: JSON.stringify({ schema: 1, publisher: 'cug', generated_at: '2026-11-13T12:00:00Z', poll_interval_secs: 300, accounts: [] }),
    })
    expect(res.status).toBe(200)
    expect(upserts).toEqual(['user-A'])
    expect(dispatcherModule.corchSingletonConstructed()).toBe(false)
  })
})
