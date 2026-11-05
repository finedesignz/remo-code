// PTYCAP-05-07 task 2 + QC round 1 (codex #3): disarm is ONE transaction that engages the session
// kill switch BEFORE the terminal transition (atomic, never a terminal-but-dispatchable window);
// enable only works on an armed run. Fakes only.
import { describe, expect, mock, test } from 'bun:test'
import { disarmProof, enableProof, type ProofDisarmDeps, type ProofEnableDeps } from '../src/orchestrator/proof-arm.ts'
import { createProofFakeSql } from './fixtures/proof-fake-sql.ts'

const RUN = { id: 'run-1', user_id: 'user-1', task_id: 'task-1', session_id: 'sess-1', repo_ident: 'github://acme/proof' } as any

function disarmHarness(over: Partial<ProofDisarmDeps> = {}) {
  const calls: { disarm: any[] } = { disarm: [] }
  const deps: ProofDisarmDeps = {
    disarmTx: async (a) => {
      calls.disarm.push(a)
      return { disarmed: true, run: RUN }
    },
    ...over,
  }
  return { deps, calls }
}

describe('disarmProof', () => {
  test('a disarm reports the kill switch as engaged (it happened inside the transaction)', async () => {
    const h = disarmHarness()
    const r = await disarmProof({ userId: 'user-1' }, h.deps)
    expect(r).toMatchObject({ disarmed: true, killSwitch: { engaged: true } })
    expect(h.calls.disarm[0]).toMatchObject({ userId: 'user-1' })
  })

  test('with no active run it returns disarmed:false', async () => {
    const h = disarmHarness({ disarmTx: async () => ({ disarmed: false }) })
    expect(await disarmProof({ userId: 'user-1' }, h.deps)).toEqual({ disarmed: false })
  })

  test('a disarm transaction failure propagates', async () => {
    const h = disarmHarness({
      disarmTx: async () => {
        throw new Error('tx failed')
      },
    })
    await expect(disarmProof({ userId: 'user-1' }, h.deps)).rejects.toThrow('tx failed')
  })

  test('only the exact user is passed through: no repo, task or other-user widening', async () => {
    const h = disarmHarness()
    await disarmProof({ userId: 'user-1', detail: 'rollback' }, h.deps)
    expect(Object.keys(h.calls.disarm[0]).sort()).toEqual(['detail', 'userId'])
    expect(h.calls.disarm[0].detail).toBe('rollback')
  })
})

describe('disarmProofRunTx: the kill switch is engaged BEFORE the terminal transition, in the same tx', () => {
  const fake = createProofFakeSql()
  mock.module('../src/db/postgres.ts', () => ({ sql: fake.sql }))
  const base = {
    id: 'r1', user_id: 'user-1', task_id: 't1', session_id: 'sess-1', repo_ident: 'github://acme/proof', status: 'running',
  }

  test('statement order inside ONE transaction: lock, kill-switch insert, THEN the run UPDATE to disarmed', async () => {
    const D = await import(`../src/db/orchestrator-proof-dal.ts?t=${Date.now()}`)
    fake.state.runs = [{ ...base }]
    fake.state.tasks = [{ id: 't1', user_id: 'user-1', session_id: 'sess-1', task_type: 'orchestrator', enabled: true, macro_task_type: 'dev' }]
    fake.state.statements.length = 0
    fake.state.beginCalls = 0
    const r = await D.disarmProofRunTx({ userId: 'user-1' })
    expect(r.disarmed).toBe(true)
    expect(fake.state.beginCalls).toBe(1)
    const kill = fake.state.statements.findIndex((t) => t.includes('INSERT INTO automation_kill_switch'))
    const term = fake.state.statements.findIndex((t) => t.includes("UPDATE orchestrator_proof_runs SET status = 'disarmed'"))
    expect(kill).toBeGreaterThan(-1)
    expect(term).toBeGreaterThan(kill)
    expect(fake.state.kill).toEqual([expect.objectContaining({ session_id: 'sess-1', engaged: true })])
    expect(fake.state.unknown).toEqual([])
  })

  test('a failure of the terminal update rolls the kill switch back too (atomic)', async () => {
    const D = await import(`../src/db/orchestrator-proof-dal.ts?t=${Date.now()}b`)
    fake.state.runs = [{ ...base }]
    fake.state.kill = []
    fake.state.failOn = (t) => t.includes("UPDATE orchestrator_proof_runs SET status = 'disarmed'")
    await expect(D.disarmProofRunTx({ userId: 'user-1' })).rejects.toThrow('fake_sql_failure')
    fake.state.failOn = null
    expect(fake.state.kill).toEqual([])
    expect(fake.state.runs[0].status).toBe('running')
  })

  test('no active run -> nothing engaged', async () => {
    const D = await import(`../src/db/orchestrator-proof-dal.ts?t=${Date.now()}c`)
    fake.state.runs = []
    fake.state.kill = []
    expect(await D.disarmProofRunTx({ userId: 'user-1' })).toEqual({ disarmed: false })
    expect(fake.state.kill).toEqual([])
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
