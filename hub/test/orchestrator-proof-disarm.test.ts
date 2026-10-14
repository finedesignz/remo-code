// PTYCAP-05-07 task 2: disarm runs the transaction FIRST, then the kill switch best-effort
// (verdict F3-4 rollback ordering); enable only works on an armed run. Fakes only.
import { describe, expect, test } from 'bun:test'
import { disarmProof, enableProof, type ProofDisarmDeps, type ProofEnableDeps } from '../src/orchestrator/proof-arm.ts'

const RUN = { id: 'run-1', user_id: 'user-1', task_id: 'task-1', session_id: 'sess-1', repo_ident: 'github://acme/proof' } as any

function disarmHarness(over: Partial<ProofDisarmDeps> = {}) {
  const order: string[] = []
  const calls: { disarm: any[]; kill: any[] } = { disarm: [], kill: [] }
  const deps: ProofDisarmDeps = {
    disarmTx: async (a) => {
      order.push('disarm')
      calls.disarm.push(a)
      return { disarmed: true, run: RUN }
    },
    engageKillSwitch: async (a) => {
      order.push('kill')
      calls.kill.push(a)
      return { engaged: true, alreadyEngaged: false }
    },
    ...over,
  }
  return { deps, order, calls }
}

describe('disarmProof', () => {
  test('the disarm transaction precedes the kill switch (call-order array)', async () => {
    const h = disarmHarness()
    const r = await disarmProof({ userId: 'user-1' }, h.deps)
    expect(h.order).toEqual(['disarm', 'kill'])
    expect(r).toMatchObject({ disarmed: true, killSwitch: { engaged: true } })
  })

  test('kill switch targets the session scope, user and the proof session', async () => {
    const h = disarmHarness()
    await disarmProof({ userId: 'user-1' }, h.deps)
    expect(h.calls.kill[0]).toMatchObject({ scope: 'session', userId: 'user-1', sessionId: 'sess-1' })
    expect(h.calls.disarm[0]).toMatchObject({ userId: 'user-1' })
  })

  test('a rejecting kill switch is reported, never throws, and the disarm stands', async () => {
    const h = disarmHarness({
      engageKillSwitch: async () => {
        throw new Error('db down')
      },
    })
    const r = await disarmProof({ userId: 'user-1' }, h.deps)
    expect(r.disarmed).toBe(true)
    if (!r.disarmed) return
    expect(r.killSwitch.engaged).toBe(false)
    expect(r.killSwitch.error).toContain('db down')
    expect(h.order).toEqual(['disarm'])
  })

  test('with no active run it returns disarmed:false and engages nothing', async () => {
    const h = disarmHarness({
      disarmTx: async () => {
        h.order.push('disarm')
        return { disarmed: false }
      },
    })
    const r = await disarmProof({ userId: 'user-1' }, h.deps)
    expect(r).toEqual({ disarmed: false })
    expect(h.order).toEqual(['disarm'])
  })

  test('a second disarm is idempotent (disarmed:false, no second kill)', async () => {
    let n = 0
    const h = disarmHarness({
      disarmTx: async () => {
        n++
        h.order.push('disarm')
        return n === 1 ? { disarmed: true, run: RUN } : { disarmed: false }
      },
    })
    expect((await disarmProof({ userId: 'user-1' }, h.deps)).disarmed).toBe(true)
    expect((await disarmProof({ userId: 'user-1' }, h.deps)).disarmed).toBe(false)
    expect(h.order).toEqual(['disarm', 'kill', 'disarm'])
  })

  test('a disarm transaction failure propagates and engages no kill switch', async () => {
    const h = disarmHarness({
      disarmTx: async () => {
        h.order.push('disarm')
        throw new Error('tx failed')
      },
    })
    await expect(disarmProof({ userId: 'user-1' }, h.deps)).rejects.toThrow('tx failed')
    expect(h.order).toEqual(['disarm'])
  })

  test('only the exact user is passed through: no repo, task or other-user widening', async () => {
    const h = disarmHarness()
    await disarmProof({ userId: 'user-1', detail: 'rollback' }, h.deps)
    expect(Object.keys(h.calls.disarm[0]).sort()).toEqual(['detail', 'userId'])
    expect(h.calls.disarm[0].detail).toBe('rollback')
  })
})

describe('enableProof', () => {
  const enableHarness = (over: Partial<ProofEnableDeps> = {}) => {
    const calls: any[] = []
    const deps: ProofEnableDeps = {
      enableTx: async (a) => {
        calls.push(a)
        return { run: RUN }
      },
      ...over,
    }
    return { deps, calls }
  }

  test('calls enableTx once for an armed run and says the first tick spawns the build session', async () => {
    const h = enableHarness()
    const r = await enableProof({ userId: 'user-1' }, h.deps)
    expect(h.calls.length).toBe(1)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.message.toLowerCase()).toContain('first tick')
    expect(r.message.toLowerCase()).toContain('build session')
  })

  test('proof_not_armed is surfaced as a code (also for a second enable of a running run)', async () => {
    const h = enableHarness({
      enableTx: async () => {
        const e: any = new Error('proof_not_armed')
        e.name = 'ProofStateError'
        e.code = 'proof_not_armed'
        throw e
      },
    })
    const r = await enableProof({ userId: 'user-1' }, h.deps)
    expect(r).toMatchObject({ ok: false, code: 'proof_not_armed' })
  })

  test('an unexpected error is rethrown', async () => {
    const h = enableHarness({
      enableTx: async () => {
        throw new Error('boom')
      },
    })
    await expect(enableProof({ userId: 'user-1' }, h.deps)).rejects.toThrow('boom')
  })
})
