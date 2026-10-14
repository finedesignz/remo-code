/**
 * PTYCAP-05 plan 06 task 1: the ordered evaluator chain (kill switch, repo match, protection,
 * verifier, agent-declined, budget) incl. tick-side budget termination and budget outcome naming.
 * DB-free: shared fake GitHub + in-memory deps. No mock.module.
 */
import { describe, expect, test } from 'bun:test'
import {
  defaultProofEvaluators,
  frozenFromRun,
  selectBudgetOutcome,
  type ProofEvaluatorDeps,
} from '../src/orchestrator/proof-evaluators.ts'
import { agentDeclinedEvaluator, proofGuard, type ProofEvaluatorCtx, type ProofEvaluatorVerdict, type ProofGuardDeps } from '../src/orchestrator/proof-guard.ts'
import { evaluateProtection } from '../src/orchestrator/proof-protection.ts'
import type { ProofGuardInput, ProofRun } from '../src/orchestrator/proof-types.ts'
import { greenPr, makeFakeProofGithub, mainAdvanced, redPr, type FakeProofGithub } from './fixtures/proof-fake-github.ts'


const CI_RULES = [
  { type: 'update', parameters: null },
  { type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'ci' }] } },
]
/** The shared fake with a protection shape that passes evaluateProtection (branch_lock + required 'ci'). */
function fakeGh(patch: Parameters<typeof makeFakeProofGithub>[0] = {}): FakeProofGithub {
  const base = makeFakeProofGithub()
  const rs = { ...base.scenario.rulesets[1], rules: CI_RULES }
  return makeFakeProofGithub({
    effectiveRules: CI_RULES.map((r) => ({ ...r, rulesetId: 1, rulesetSourceType: 'Repository' })) as any,
    rulesets: { 1: rs },
    ...patch,
  })
}

const T0 = 1_000_000
const NOW = T0 + 10_000

async function armedRun(fake: FakeProofGithub, over: Partial<ProofRun> = {}): Promise<ProofRun> {
  const ev = await evaluateProtection(fake, { owner: 'acme', repo: 'proof', defaultBranch: 'main' })
  if (!ev.ok) throw new Error(`fixture protection not ok: ${ev.detail}`)
  const f = ev.frozen
  return {
    id: 'run1',
    user_id: 'u1',
    task_id: 't1',
    session_id: 's1',
    repo_ident: 'github://acme/proof',
    counter_key: 'task:t1',
    branch: 'proof/run1',
    installation_id: 99,
    repo_owner: 'acme',
    repo_name: 'proof',
    default_branch: 'main',
    base_sha: 'a'.repeat(40),
    ruleset_ids: f.rulesetIds,
    ruleset_digest: f.digest,
    ruleset_updated_at: f.updatedAt,
    protection_shape: f.shape,
    required_contexts: f.requiredContexts,
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
    armed_at: new Date(T0).toISOString(),
    updated_at: new Date(T0).toISOString(),
    started_at: new Date(T0).toISOString(),
    terminal_at: null,
    ...over,
  }
}

function input(over: Partial<ProofGuardInput> = {}): ProofGuardInput {
  return { userId: 'u1', sessionId: 's1', taskId: 't1', repoIdent: 'github://acme/proof', repoKey: 'github://acme/proof', sentinels: null, runLive: false, ...over }
}

function mkDeps(fake: FakeProofGithub, st: { halted?: boolean; haltThrows?: boolean; injects?: number; tokens?: number; sessionExists?: boolean; attributionLost?: boolean } = {}) {
  const rec = { observed: [] as any[] }
  const state = { halted: false, haltThrows: false, injects: 0, tokens: 0, sessionExists: true, ...st }
  const deps: ProofEvaluatorDeps = {
    isHalted: async () => {
      if (state.haltThrows) throw new Error('db_down')
      return { halted: state.halted }
    },
    githubFor: () => fake,
    recordObservation: async (id, patch) => {
      rec.observed.push([id, patch])
    },
    countInjects: async () => state.injects,
    sumTokens: async () => ({ tokens: state.tokens, sessionExists: state.sessionExists, ...(state.attributionLost ? { attributionLost: true } : {}) }),
  }
  return { deps, rec, state }
}

/** Mirrors the guard loop: one shared ctx, first non-continue verdict wins. */
async function chain(deps: ProofEvaluatorDeps, run: ProofRun, inp: ProofGuardInput, now = NOW): Promise<ProofEvaluatorVerdict> {
  const ctx: ProofEvaluatorCtx = { run, input: inp, now }
  for (const ev of defaultProofEvaluators(deps)) {
    const v = await ev(ctx)
    if (v.kind !== 'continue') return v
  }
  return { kind: 'continue' }
}

describe('evaluator order', () => {
  test('exactly: killSwitch, repoMatch, protection, verifier, agentDeclined, budget', () => {
    const fake = fakeGh()
    const names = defaultProofEvaluators(mkDeps(fake).deps).map((e) => e.name)
    expect(names).toEqual(['killSwitch', 'repoMatch', 'protection', 'verifier', 'agentDeclined', 'budget'])
  })

  test('the first non-continue verdict wins (kill switch beats a green PR)', async () => {
    const fake = fakeGh(greenPr())
    const { deps } = mkDeps(fake, { halted: true })
    const run = await armedRun(fake)
    const before = fake.calls.length
    const v = await chain(deps, run, input())
    expect(v).toMatchObject({ kind: 'terminal', outcome: 'nothing:kill_switch' })
    expect(fake.calls.length).toBe(before) // no GitHub read after the kill switch
  })
})

describe('killSwitch / repoMatch', () => {
  test('halted -> nothing:kill_switch', async () => {
    const fake = fakeGh()
    const v = await chain(mkDeps(fake, { halted: true }).deps, await armedRun(fake), input())
    expect(v).toMatchObject({ kind: 'terminal', outcome: 'nothing:kill_switch' })
  })

  test('kill switch read throws -> nothing:guard_error (fail closed)', async () => {
    const fake = fakeGh()
    const v = await chain(mkDeps(fake, { haltThrows: true }).deps, await armedRun(fake), input())
    expect(v).toMatchObject({ kind: 'terminal', outcome: 'nothing:guard_error' })
  })

  test('task repo differs from the run repo -> nothing:repo_mismatch', async () => {
    const fake = fakeGh()
    const v = await chain(mkDeps(fake).deps, await armedRun(fake), input({ repoIdent: 'github://acme/other' }))
    expect(v).toMatchObject({ kind: 'terminal', outcome: 'nothing:repo_mismatch' })
  })
})

describe('protection (every tick, before the verifier)', () => {
  test('frozenFromRun fills owner/repo from the run row', async () => {
    const fake = fakeGh()
    const f = frozenFromRun(await armedRun(fake))
    expect(f.owner).toBe('acme')
    expect(f.repo).toBe('proof')
    expect(f.defaultBranch).toBe('main')
  })

  test('intact protection continues to the verifier', async () => {
    const fake = fakeGh()
    const v = await chain(mkDeps(fake).deps, await armedRun(fake), input())
    expect(v).toEqual({ kind: 'continue' })
  })

  test('ruleset changed since arm -> terminated:proof_protection_drift, verifier never ran', async () => {
    const fake = fakeGh(greenPr())
    const run = await armedRun(fake)
    fake.scenario.rulesets[1] = { ...fake.scenario.rulesets[1], rules: [{ type: 'update', parameters: null }, { type: 'deletion', parameters: null }], updatedAt: '2026-10-02T00:00:00Z' }
    const v = await chain(mkDeps(fake).deps, run, input())
    expect(v).toMatchObject({ kind: 'terminal', outcome: 'terminated:proof_protection_drift' })
    expect(fake.calls.some((c) => c.method === 'listPullsWithHeadPrefix')).toBe(false)
  })

  test('ruleset unreadable -> terminated:proof_protection_unverifiable', async () => {
    const fake = fakeGh()
    const run = await armedRun(fake)
    const { ProofGithubError } = await import('../src/orchestrator/proof-types.ts')
    fake.apply({ fail: { getRuleset: new ProofGithubError('forbidden', 403), getEffectiveBranchRules: new ProofGithubError('forbidden', 403) } })
    const v = await chain(mkDeps(fake).deps, run, input())
    expect(v).toMatchObject({ kind: 'terminal', outcome: 'terminated:proof_protection_unverifiable' })
  })

  test('a Date-typed ruleset_updated_at (timestamptz round trip) is not drift', async () => {
    const fake = fakeGh()
    const run = await armedRun(fake)
    run.ruleset_updated_at = new Date(String(run.ruleset_updated_at))
    expect(await chain(mkDeps(fake).deps, run, input())).toEqual({ kind: 'continue' })
  })
})

describe('verifier', () => {
  test('green PR -> terminal pr_open_green carrying the PR url', async () => {
    const fake = fakeGh(greenPr())
    const v = await chain(mkDeps(fake).deps, await armedRun(fake), input())
    expect(v).toMatchObject({ kind: 'terminal', outcome: 'pr_open_green', prUrl: 'https://github.com/acme/proof/pull/1', prNumber: 1 })
  })

  test('main advanced -> terminated:main_advanced', async () => {
    const fake = fakeGh(mainAdvanced())
    const v = await chain(mkDeps(fake).deps, await armedRun(fake), input())
    expect(v).toMatchObject({ kind: 'terminal', outcome: 'terminated:main_advanced' })
  })

  test('pending observation is persisted and the chain continues', async () => {
    const fake = fakeGh(redPr())
    const { deps, rec } = mkDeps(fake)
    const v = await chain(deps, await armedRun(fake), input())
    expect(v).toEqual({ kind: 'continue' })
    expect(rec.observed).toEqual([['run1', { pr_url: 'https://github.com/acme/proof/pull/1', pr_number: 1, last_ci_state: 'ci_red' }]])
  })
})

describe('agentDeclined', () => {
  const declined = { state: { last_action: 'nothing - cannot reach the repo' } } as any

  test('declines with no PR -> nothing:agent_declined, detail truncated to 200', async () => {
    const fake = fakeGh()
    const long = 'x'.repeat(500)
    const v = await chain(mkDeps(fake).deps, await armedRun(fake), input({ sentinels: { state: { last_action: `nothing - ${long}` } } as any }))
    expect(v).toMatchObject({ kind: 'terminal', outcome: 'nothing:agent_declined' })
    expect((v as any).detail).toHaveLength(200)
  })

  test('the claim is IGNORED when a PR exists', async () => {
    const fake = fakeGh(redPr())
    const v = await chain(mkDeps(fake).deps, await armedRun(fake), input({ sentinels: declined }))
    expect(v).toEqual({ kind: 'continue' })
  })

  test('a non-nothing last_action never ends the run', async () => {
    const fake = fakeGh()
    const v = await chain(mkDeps(fake).deps, await armedRun(fake), input({ sentinels: { state: { last_action: 'opened pull request' } } as any }))
    expect(v).toEqual({ kind: 'continue' })
  })

  test('the tracer-era standalone evaluator still works', () => {
    expect(agentDeclinedEvaluator({ run: {} as any, input: input({ sentinels: declined }), now: 0 })).toMatchObject({ kind: 'terminal' })
  })
})

describe('budget (tick-side)', () => {
  test('wall exceeded with NO inject attempted -> terminal on the tick', async () => {
    const fake = fakeGh()
    const v = await chain(mkDeps(fake).deps, await armedRun(fake), input(), T0 + 60_001)
    expect(v).toMatchObject({ kind: 'terminal', outcome: 'nothing:no_pr_produced_within_budget' })
  })

  test('wall exceeded terminates even with CI pending (wall never waits)', async () => {
    const fake = fakeGh({
      pulls: greenPr().pulls,
      checks: { ['b'.repeat(40)]: { checkRuns: [{ name: 'ci', status: 'in_progress', conclusion: null }], statuses: [], truncated: false } },
    })
    const v = await chain(mkDeps(fake).deps, await armedRun(fake), input(), T0 + 61_000)
    expect(v).toMatchObject({ kind: 'terminal', outcome: 'terminated:budget_wall' })
  })

  test('naming x4: red PR / open non-red PR / no PR recoverable / no PR other', async () => {
    const red = selectBudgetOutcome({ reason: 'budget_injects', ciState: 'ci_red', hasPr: true, lastInject: null })
    expect(red).toBe('terminated:pr_open_ci_red')
    expect(selectBudgetOutcome({ reason: 'budget_tokens', ciState: 'ci_unverifiable', hasPr: true, lastInject: null })).toBe('terminated:budget_tokens')
    expect(selectBudgetOutcome({ reason: 'budget_wall', ciState: 'no_pr', hasPr: false, lastInject: 'refused:supervisor_offline' })).toBe('nothing:supervisor_offline')
    expect(selectBudgetOutcome({ reason: 'budget_wall', ciState: 'no_pr', hasPr: false, lastInject: 'no_session' })).toBe('nothing:no_session')
    expect(selectBudgetOutcome({ reason: 'budget_wall', ciState: 'no_pr', hasPr: false, lastInject: 'refused:launch_cap' })).toBe('nothing:launch_cap')
    expect(selectBudgetOutcome({ reason: 'budget_wall', ciState: 'no_pr', hasPr: false, lastInject: 'refused:autospawn_launch_x' })).toBe('nothing:no_pr_produced_within_budget')
    expect(selectBudgetOutcome({ reason: 'budget_wall', ciState: null, hasPr: false, lastInject: 'dispatched' })).toBe('nothing:no_pr_produced_within_budget')
  })

  test('injects spent + red PR -> terminated:pr_open_ci_red; injects spent + no PR -> nothing', async () => {
    const red = fakeGh(redPr())
    const a = await chain(mkDeps(red, { injects: 5 }).deps, await armedRun(red), input())
    expect(a).toMatchObject({ kind: 'terminal', outcome: 'terminated:pr_open_ci_red' })
    const none = fakeGh()
    const b = await chain(mkDeps(none, { injects: 5 }).deps, await armedRun(none), input())
    expect(b).toMatchObject({ kind: 'terminal', outcome: 'nothing:no_pr_produced_within_budget' })
  })

  test('tokens spent (hwm counts) with a closed PR -> terminated:budget_tokens', async () => {
    const fake = fakeGh({ pulls: [{ ...greenPr().pulls![0], state: 'closed' }] })
    const v = await chain(mkDeps(fake, { tokens: 0 }).deps, await armedRun(fake, { tokens_hwm: 1000 }), input())
    expect(v).toMatchObject({ kind: 'terminal', outcome: 'terminated:budget_tokens' })
  })

  test('spent + turn still live -> wait (no terminal, no inject)', async () => {
    const fake = fakeGh()
    const v = await chain(mkDeps(fake, { injects: 5 }).deps, await armedRun(fake), input({ runLive: true }))
    expect(v).toEqual({ kind: 'wait' })
  })

  test('spent + CI pending on an open PR -> wait', async () => {
    const fake = fakeGh({
      pulls: greenPr().pulls,
      checks: { ['b'.repeat(40)]: { checkRuns: [{ name: 'ci', status: 'in_progress', conclusion: null }], statuses: [], truncated: false } },
    })
    const v = await chain(mkDeps(fake, { injects: 5 }).deps, await armedRun(fake), input())
    expect(v).toEqual({ kind: 'wait' })
  })

  test('nothing spent: CI pending -> wait; no PR / red -> continue (proceed)', async () => {
    const pend = fakeGh({
      pulls: greenPr().pulls,
      checks: { ['b'.repeat(40)]: { checkRuns: [{ name: 'ci', status: 'queued', conclusion: null }], statuses: [], truncated: false } },
    })
    expect(await chain(mkDeps(pend).deps, await armedRun(pend), input())).toEqual({ kind: 'wait' })
    const none = fakeGh()
    expect(await chain(mkDeps(none).deps, await armedRun(none), input())).toEqual({ kind: 'continue' })
    const red = fakeGh(redPr())
    expect(await chain(mkDeps(red).deps, await armedRun(red), input())).toEqual({ kind: 'continue' })
  })

  test('session row gone -> terminated:budget_attribution_lost', async () => {
    const fake = fakeGh()
    const v = await chain(mkDeps(fake, { sessionExists: false }).deps, await armedRun(fake), input())
    expect(v).toMatchObject({ kind: 'terminal', outcome: 'terminated:budget_attribution_lost' })
  })

  test('live session but a usage persist failed -> terminated:budget_attribution_lost (codex #4)', async () => {
    const fake = fakeGh()
    const v = await chain(mkDeps(fake, { attributionLost: true }).deps, await armedRun(fake), input())
    expect(v).toMatchObject({ kind: 'terminal', outcome: 'terminated:budget_attribution_lost' })
  })

  test('tokens high-water mark only ever rises and is persisted', async () => {
    const fake = fakeGh()
    const { deps, rec } = mkDeps(fake, { tokens: 400 })
    await chain(deps, await armedRun(fake, { tokens_hwm: 100 }), input())
    expect(rec.observed.at(-1)).toEqual(['run1', { tokens: 400 }])
    const before = rec.observed.length
    await chain(deps, await armedRun(fake, { tokens_hwm: 900 }), input())
    expect(rec.observed.length).toBe(before + 1) // only the verifier's observation, no lower hwm write
  })
})

describe('an evaluator throw is caught by the guard -> nothing:guard_error', () => {
  test('github throwing a non-typed error in the verifier never injects', async () => {
    const fake = fakeGh()
    const run = await armedRun(fake)
    const { deps } = mkDeps(fake)
    deps.verify = async () => {
      throw new Error('boom')
    }
    const terminals: any[] = []
    const gd: ProofGuardDeps = {
      isEnabled: () => true,
      claimActiveRun: async () => run,
      taskHasAnyRun: async () => true,
      terminalize: async (a) => (terminals.push(a), { ...run, status: 'nothing' } as ProofRun),
      terminalizeByTask: async () => null,
      disableTask: async () => {},
      engageSessionKill: async () => {},
      appendRunLog: async () => {},
      fanOut: async () => {},
      recordInjectOutcome: async () => {},
      evaluators: defaultProofEvaluators(deps),
      now: () => NOW,
    }
    const d = await proofGuard(gd, input())
    expect(d).toMatchObject({ kind: 'terminal', outcome: 'nothing:guard_error' })
    expect(terminals).toHaveLength(1)
  })
})

describe('hygiene', () => {
  test('no timer / sleep in proof-evaluators.ts (rule 23)', async () => {
    const src = await Bun.file(new URL('../src/orchestrator/proof-evaluators.ts', import.meta.url)).text()
    expect(/setTimeout|setInterval|sleep/.test(src)).toBe(false)
  })
})
