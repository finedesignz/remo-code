/**
 * PTYCAP-05 plan 05: proofBudgetGate + proofProtectionGate over injectable deps.
 * DB-free, network-free, no mock.module.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  makeProofBudgetGate,
  makeProofProtectionGate,
  proofBudgetGate,
  proofProtectionGate,
  type ProofGateDeps,
} from '../src/orchestrator/proof-gates.ts'
import type { ProofRun } from '../src/orchestrator/proof-types.ts'
import type { DispatchRequest } from '../src/dispatch/pipeline.ts'
import { evaluateProtection, type FrozenProtection } from '../src/orchestrator/proof-protection.ts'
import { defaultScenario, makeFakeProofGithub } from './fixtures/proof-fake-github.ts'

const FLAGS = ['REMO_ORCHESTRATOR_PROOF', 'REMO_ORCHESTRATOR_ENABLED', 'REMO_ORCHESTRATOR_AUTOSPAWN'] as const
const saved: Record<string, string | undefined> = {}
beforeEach(() => {
  for (const k of FLAGS) {
    saved[k] = process.env[k]
    delete process.env[k]
  }
})
afterEach(() => {
  for (const k of FLAGS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})
const flagsOn = () => {
  for (const k of FLAGS) process.env[k] = '1'
}

const T0 = Date.parse('2026-10-13T00:00:00Z')

function run(over: Partial<ProofRun> = {}): ProofRun {
  return {
    id: 'r1',
    user_id: 'u1',
    task_id: 't1',
    session_id: 's1',
    repo_ident: 'github://acme/proof',
    counter_key: 'task:t1',
    branch: 'proof/r1',
    installation_id: 42,
    repo_owner: 'acme',
    repo_name: 'proof',
    default_branch: 'main',
    base_sha: 'a'.repeat(40),
    ruleset_ids: ['1'],
    ruleset_digest: 'd',
    ruleset_updated_at: '2026-10-01T00:00:00Z',
    protection_shape: 'branch_lock',
    required_contexts: ['ci'],
    arm_preconditions: {},
    max_injects: 5,
    max_tokens: 1000,
    max_wall_ms: 60_000,
    status: 'running',
    outcome: null,
    outcome_detail: null,
    pr_url: null,
    pr_number: null,
    last_ci_state: null,
    last_inject_outcome: null,
    tokens_hwm: 0,
    armed_at: new Date(T0 - 10_000).toISOString(),
    updated_at: new Date(T0).toISOString(),
    started_at: new Date(T0 - 5_000).toISOString(),
    terminal_at: null,
    ...over,
  } as ProofRun
}

const req = (over: Partial<DispatchRequest> = {}): DispatchRequest =>
  ({ userId: 'u1', sessionId: 's1', token: 'tok', prompt: 'p', counterKey: 'task:t1', proofRunId: 'r1', ...over }) as DispatchRequest

interface Spy extends ProofGateDeps {
  calls: string[]
  observed: number[]
}
function deps(over: Partial<ProofGateDeps> & { run?: ProofRun | null } = {}): Spy {
  const calls: string[] = []
  const observed: number[] = []
  const r = over.run === undefined ? run() : over.run
  const d: Spy = {
    calls,
    observed,
    findRun: over.findRun ?? (async () => (calls.push('findRun'), r)),
    countInjects: over.countInjects ?? (async () => (calls.push('countInjects'), 0)),
    sumTokens: over.sumTokens ?? (async () => (calls.push('sumTokens'), { tokens: 0, sessionExists: true })),
    recordTokens:
      over.recordTokens ??
      (async (_id, t) => {
        calls.push('recordTokens')
        observed.push(t)
      }),
    githubFor: over.githubFor ?? (() => (calls.push('githubFor'), makeFakeProofGithub())),
    reassert: over.reassert ?? (async () => (calls.push('reassert'), { ok: true })),
    now: over.now ?? (() => T0),
  }
  return d
}

describe('flag OFF is a true no-op (D-03)', () => {
  test('both gates pass with zero dep calls for every partial flag state', async () => {
    const states: Array<Array<(typeof FLAGS)[number]>> = [[], ['REMO_ORCHESTRATOR_PROOF'], ['REMO_ORCHESTRATOR_PROOF', 'REMO_ORCHESTRATOR_ENABLED']]
    for (const on of states) {
      for (const k of FLAGS) delete process.env[k]
      for (const k of on) process.env[k] = '1'
      const d = deps()
      expect(await makeProofBudgetGate(d).check(req())).toEqual({ ok: true })
      expect(await makeProofProtectionGate(d).check(req())).toEqual({ ok: true })
      expect(d.calls).toEqual([])
    }
  })

  test('default instances are inert with the flag OFF (no real dep resolution)', async () => {
    expect(proofBudgetGate.name).toBe('proof_budget')
    expect(proofProtectionGate.name).toBe('proof_protection')
    expect(await proofBudgetGate.check(req())).toEqual({ ok: true })
    expect(await proofProtectionGate.check(req())).toEqual({ ok: true })
  })
})

describe('proofBudgetGate (flag ON)', () => {
  beforeEach(flagsOn)

  test('QC r1: no run for the request is REFUSED while proof mode is on (exclusive)', async () => {
    expect(await makeProofBudgetGate(deps({ run: null })).check(req())).toEqual({ ok: false, reason: 'proof_mode_non_proof_task' })
  })

  test('under every cap passes and counts nothing extra', async () => {
    const d = deps()
    expect(await makeProofBudgetGate(d).check(req())).toEqual({ ok: true })
    expect(d.observed).toEqual([])
  })

  test('lifetime_counter_key_missing: undefined key, session: key, or another task key', async () => {
    for (const k of [undefined, 'session:s1', 'task:other']) {
      const g = makeProofBudgetGate(deps())
      expect(await g.check(req({ counterKey: k }))).toEqual({ ok: false, reason: 'lifetime_counter_key_missing' })
    }
  })

  test('lifetime_counter_key_missing when the stored key is not task:<task_id>', async () => {
    const g = makeProofBudgetGate(deps({ run: run({ counter_key: 'session:s1' }) }))
    expect(await g.check(req({ counterKey: 'session:s1' }))).toEqual({ ok: false, reason: 'lifetime_counter_key_missing' })
  })

  test('proof_run_terminal blocks a replay keyed to a terminal run even with the flag ON', async () => {
    const g = makeProofBudgetGate(deps({ run: run({ status: 'terminated', outcome: 'terminated:budget_wall' as never }) }))
    expect(await g.check(req())).toEqual({ ok: false, reason: 'proof_run_terminal:terminated:budget_wall' })
  })

  test('an armed (unstarted) run passes the budget gate', async () => {
    const d = deps({ run: run({ status: 'armed', started_at: null }) })
    expect(await makeProofBudgetGate(d).check(req())).toEqual({ ok: true })
  })

  test('proof_budget_wall at and after the cap', async () => {
    const g = makeProofBudgetGate(deps({ now: () => T0 - 5_000 + 60_000 }))
    expect(await g.check(req())).toEqual({ ok: false, reason: 'proof_budget_wall' })
    const g2 = makeProofBudgetGate(deps({ now: () => T0 - 5_000 + 59_999 }))
    expect(await g2.check(req())).toEqual({ ok: true })
  })

  test('proof_budget_injects at the cap, with the observed count in the reason', async () => {
    const g = makeProofBudgetGate(deps({ countInjects: async () => 5 }))
    expect(await g.check(req())).toEqual({ ok: false, reason: 'proof_budget_injects:5>=5' })
    const g2 = makeProofBudgetGate(deps({ countInjects: async () => 4 }))
    expect(await g2.check(req())).toEqual({ ok: true })
  })

  test('proof_budget_tokens uses the larger of the monotone hwm and the live sum', async () => {
    const live = makeProofBudgetGate(deps({ sumTokens: async () => ({ tokens: 1000, sessionExists: true }) }))
    expect(await live.check(req())).toEqual({ ok: false, reason: 'proof_budget_tokens:1000>=1000' })
    // sum shrank (rows deleted) but the stored high-water mark still blocks
    const hwm = makeProofBudgetGate(
      deps({ run: run({ tokens_hwm: 1500 }), sumTokens: async () => ({ tokens: 10, sessionExists: true }) }),
    )
    expect(await hwm.check(req())).toEqual({ ok: false, reason: 'proof_budget_tokens:1500>=1000' })
  })

  test('observed tokens are written back monotonically (only when they rise)', async () => {
    const d = deps({ sumTokens: async () => ({ tokens: 400, sessionExists: true }) })
    expect(await makeProofBudgetGate(d).check(req())).toEqual({ ok: true })
    expect(d.observed).toEqual([400])
    const d2 = deps({ run: run({ tokens_hwm: 500 }), sumTokens: async () => ({ tokens: 400, sessionExists: true }) })
    await makeProofBudgetGate(d2).check(req())
    expect(d2.observed).toEqual([])
  })

  test('a failing hwm write does not change the verdict', async () => {
    const d = deps({
      sumTokens: async () => ({ tokens: 400, sessionExists: true }),
      recordTokens: async () => {
        throw new Error('db down')
      },
    })
    expect(await makeProofBudgetGate(d).check(req())).toEqual({ ok: true })
  })

  test('proof_budget_attribution_lost when the session row is gone (never under-counts)', async () => {
    const g = makeProofBudgetGate(deps({ sumTokens: async () => ({ tokens: 0, sessionExists: false }) }))
    expect(await g.check(req())).toEqual({ ok: false, reason: 'proof_budget_attribution_lost' })
  })

  test('first block wins: key, then wall, then injects, then tokens', async () => {
    const all = deps({
      now: () => T0 + 10 * 60_000,
      countInjects: async () => 99,
      sumTokens: async () => ({ tokens: 9999, sessionExists: true }),
    })
    expect(await makeProofBudgetGate(all).check(req())).toEqual({ ok: false, reason: 'proof_budget_wall' })
    const noWall = deps({ countInjects: async () => 99, sumTokens: async () => ({ tokens: 9999, sessionExists: true }) })
    expect((await makeProofBudgetGate(noWall).check(req())) as { reason: string }).toMatchObject({ reason: 'proof_budget_injects:99>=5' })
  })

  test('every lookup error fails closed as proof_budget_unverifiable, never thrown', async () => {
    const boom = async () => {
      throw new Error('db down')
    }
    for (const over of [{ findRun: boom }, { countInjects: boom }, { sumTokens: boom }] as Array<Partial<ProofGateDeps>>) {
      expect(await makeProofBudgetGate(deps(over)).check(req())).toEqual({ ok: false, reason: 'proof_budget_unverifiable' })
    }
  })
})

describe('proofProtectionGate (flag ON)', () => {
  beforeEach(flagsOn)

  test('no run, or a terminal run, passes (the budget gate owns those verdicts)', async () => {
    expect(await makeProofProtectionGate(deps({ run: null })).check(req())).toEqual({ ok: true })
    const d = deps({ run: run({ status: 'succeeded' }) })
    expect(await makeProofProtectionGate(d).check(req())).toEqual({ ok: true })
    expect(d.calls).not.toContain('reassert')
  })

  test('active run re-asserts and passes when protection is intact', async () => {
    const d = deps()
    expect(await makeProofProtectionGate(d).check(req())).toEqual({ ok: true })
    expect(d.calls).toContain('reassert')
  })

  test('re-asserts on EVERY call (a replay is not cached)', async () => {
    const d = deps()
    const g = makeProofProtectionGate(d)
    await g.check(req())
    await g.check(req())
    expect(d.calls.filter((c) => c === 'reassert')).toHaveLength(2)
  })

  test('drift blocks with proof_protection_drift', async () => {
    const g = makeProofProtectionGate(
      deps({ reassert: async () => ({ ok: false, reason: 'proof_protection_drift', detail: 'digest_changed' }) }),
    )
    expect(await g.check(req())).toEqual({ ok: false, reason: 'proof_protection_drift' })
  })

  test('unverifiable blocks with proof_protection_unverifiable', async () => {
    const g = makeProofProtectionGate(
      deps({ reassert: async () => ({ ok: false, reason: 'proof_protection_unverifiable', detail: 'github_forbidden' }) }),
    )
    expect(await g.check(req())).toEqual({ ok: false, reason: 'proof_protection_unverifiable' })
  })

  test('a throwing dep fails closed as proof_protection_unverifiable', async () => {
    const g = makeProofProtectionGate(
      deps({
        reassert: async () => {
          throw new Error('boom')
        },
      }),
    )
    expect(await g.check(req())).toEqual({ ok: false, reason: 'proof_protection_unverifiable' })
    const g2 = makeProofProtectionGate(
      deps({
        findRun: async () => {
          throw new Error('db down')
        },
      }),
    )
    expect(await g2.check(req())).toEqual({ ok: false, reason: 'proof_protection_unverifiable' })
  })

  test('end to end against the shared fake GitHub: intact passes, a changed ruleset is drift', async () => {
    const lockSc = (updatedAt: string, contexts = ['ci']) => {
      const rsc = { type: 'required_status_checks', parameters: { required_status_checks: contexts.map((context) => ({ context })) } }
      return {
      effectiveRules: [
        { type: 'update', rulesetId: 1, rulesetSourceType: 'Repository', parameters: null },
        { ...rsc, rulesetId: 1, rulesetSourceType: 'Repository' },
      ],
      rulesets: {
        1: {
          ...defaultScenario().rulesets[1]!,
          rules: [{ type: 'update', parameters: null }, rsc],
          updatedAt,
        },
      },
    }
    }
    const fake = makeFakeProofGithub(lockSc('2026-10-01T00:00:00Z') as never)
    const ev = await evaluateProtection(fake, { owner: 'acme', repo: 'proof', defaultBranch: 'main' })
    expect(ev.ok).toBe(true)
    const f = (ev as { frozen: FrozenProtection }).frozen
    // The DB hands timestamptz back as a Date: the gate must not read that as drift.
    const row = run({
      ruleset_ids: f.rulesetIds.map(String),
      ruleset_digest: f.digest,
      ruleset_updated_at: new Date(f.updatedAt) as never,
      required_contexts: f.requiredContexts,
      protection_shape: f.shape,
    })
    const real = (await import('../src/orchestrator/proof-protection.ts')).reassertProtection
    const mk = (gh = fake) => makeProofProtectionGate(deps({ run: row, githubFor: () => gh, reassert: real }))
    expect(await mk().check(req())).toEqual({ ok: true })

    const weaker = makeFakeProofGithub(lockSc('2026-10-02T00:00:00Z', ['ci', 'extra']) as never)
    expect(await mk(weaker).check(req())).toMatchObject({ ok: false, reason: 'proof_protection_drift' })
  })
})
