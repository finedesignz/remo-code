/**
 * PTYCAP-05 plan 06 task 3: the full SC-1/SC-2 state machine, tick by tick, over fakes.
 * runMacroCycle + makeProofHooks + the REAL defaultProofEvaluators + the shared fake GitHub and
 * an in-memory run store. Each scenario asserts the injected prompts, the per-tick decisions, the
 * final outcome and EXACTLY-ONCE side effects (run-log row, notification, task disable, session kill).
 * No sql, no network, no mock.module.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { runMacroCycle, type MacroCycleDeps, type MacroCycleInput } from '../src/orchestrator/macro-cycle.ts'
import { defaultProofEvaluators } from '../src/orchestrator/proof-evaluators.ts'
import { makeProofHooks, proofGuard, type ProofGuardDeps } from '../src/orchestrator/proof-guard.ts'
import { evaluateProtection } from '../src/orchestrator/proof-protection.ts'
import { outcomeToStatus, type ProofGuardInput, type ProofRun } from '../src/orchestrator/proof-types.ts'
import { greenPr, mainAdvanced, makeFakeProofGithub, redPr, type FakeProofGithub } from './fixtures/proof-fake-github.ts'

const FLAGS = ['REMO_ORCHESTRATOR_PROOF', 'REMO_ORCHESTRATOR_ENABLED', 'REMO_ORCHESTRATOR_AUTOSPAWN'] as const
const saved: Record<string, string | undefined> = {}
beforeEach(() => {
  for (const k of FLAGS) {
    saved[k] = process.env[k]
    process.env[k] = '1'
  }
})
afterEach(() => {
  for (const k of FLAGS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})

const CI_RULES = [
  { type: 'update', parameters: null },
  { type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'ci' }] } },
]
function fakeGh(patch: Parameters<typeof makeFakeProofGithub>[0] = {}): FakeProofGithub {
  const base = makeFakeProofGithub()
  return makeFakeProofGithub({
    effectiveRules: CI_RULES.map((r) => ({ ...r, rulesetId: 1, rulesetSourceType: 'Repository' })) as any,
    rulesets: { 1: { ...base.scenario.rulesets[1], rules: CI_RULES } },
    ...patch,
  })
}
const pendingChecks = () => ({
  pulls: greenPr().pulls,
  checks: { ['b'.repeat(40)]: { checkRuns: [{ name: 'ci', status: 'in_progress', conclusion: null }], statuses: [], truncated: false } },
})

const T0 = Date.parse('2026-10-13T00:00:00Z')
const MAX_WALL = 60_000

interface HarnessOpts {
  maxInjects?: number
  halted?: boolean
  claimThrows?: boolean
  reply?: string | null
}

async function harness(fake: FakeProofGithub, opts: HarnessOpts = {}) {
  const ev = await evaluateProtection(fake, { owner: 'acme', repo: 'proof', defaultBranch: 'main' })
  if (!ev.ok) throw new Error(`fixture protection not ok: ${ev.detail}`)
  const f = ev.frozen
  const row: ProofRun = {
    id: 'run1',
    user_id: 'u1',
    task_id: 'T1',
    session_id: 's1',
    repo_ident: 'github://acme/proof',
    counter_key: 'task:T1',
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
    max_injects: opts.maxInjects ?? 5,
    max_tokens: 10_000,
    max_wall_ms: MAX_WALL,
    status: 'armed',
    outcome: null,
    outcome_detail: null,
    pr_url: null,
    pr_number: null,
    last_ci_state: null,
    last_inject_outcome: null,
    tokens_hwm: 0,
    armed_at: new Date(T0).toISOString(),
    updated_at: new Date(T0).toISOString(),
    started_at: null,
    terminal_at: null,
  }
  const st = { clock: T0 + 1_000, halted: opts.halted ?? false, nextInject: { kind: 'dispatched' } as any, reply: opts.reply ?? null, injected: 0 }
  const fx = { runLog: [] as any[], notify: [] as any[], disabled: [] as string[], kill: [] as any[], observed: [] as string[], terminalized: 0 }
  const active = () => row.status === 'armed' || row.status === 'running'

  const guardDeps: ProofGuardDeps = {
    isEnabled: () => true,
    claimActiveRun: async (taskId) => {
      if (opts.claimThrows) throw new Error('db_down')
      if (taskId !== row.task_id || !active()) return null
      row.status = 'running'
      row.started_at = row.started_at ?? new Date(st.clock).toISOString()
      return { ...row }
    },
    taskHasAnyRun: async (taskId) => taskId === row.task_id,
    terminalize: async (a) => {
      await Promise.resolve()
      if (!active()) return null
      fx.terminalized++
      row.status = outcomeToStatus(a.outcome)
      row.outcome = a.outcome
      row.outcome_detail = a.detail
      row.pr_url = a.prUrl ?? row.pr_url
      return { ...row }
    },
    terminalizeByTask: async (a) => {
      if (!active()) return null
      fx.terminalized++
      row.status = outcomeToStatus(a.outcome)
      row.outcome = a.outcome
      row.outcome_detail = a.detail
      return { ...row }
    },
    disableTask: async (_u, t) => {
      fx.disabled.push(t)
    },
    engageSessionKill: async (a) => {
      fx.kill.push(a)
    },
    appendRunLog: async (e) => {
      fx.runLog.push(e)
    },
    fanOut: async (n) => {
      fx.notify.push(n)
    },
    recordInjectOutcome: async (_id, kind) => {
      fx.observed.push(kind)
      row.last_inject_outcome = kind
    },
    evaluators: defaultProofEvaluators({
      isHalted: async () => ({ halted: st.halted }),
      githubFor: () => fake,
      recordObservation: async (_id, p) => {
        if (!active()) return
        row.pr_url = p.pr_url ?? row.pr_url
        row.pr_number = p.pr_number ?? row.pr_number
        row.last_ci_state = p.last_ci_state ?? row.last_ci_state
      },
      countInjects: async () => st.injected,
      sumTokens: async () => ({ tokens: 0, sessionExists: true }),
    }),
    now: () => st.clock,
  }

  const log = { injects: [] as any[], macroNotifies: [] as any[] }
  const cycle: MacroCycleDeps = {
    getLatestAssistantReply: async () => st.reply,
    appendRunLog: (async (e: any) => ({ id: 'rl', ...e, created_at: '' })) as any,
    inject: (async (i: any) => {
      log.injects.push(i)
      if (st.nextInject.kind === 'dispatched' || st.nextInject.kind === 'queued') st.injected++
      return st.nextInject
    }) as any,
    fanOut: (async (n: any) => {
      log.macroNotifies.push(n)
      return { delivered: [] }
    }) as any,
    isRunLive: () => false,
    refreshCapGauges: (async () => {}) as any,
    getCapStatuses: (async () => ({ costStatus: null, tokenStatus: null })) as any,
    proof: makeProofHooks(guardDeps),
  }
  const input: MacroCycleInput = {
    userId: 'u1',
    sessionId: 's1',
    taskId: 'T1',
    macroTaskType: 'dev',
    stage: 'development',
    repoPath: '/srv/repos/proof',
    repoIdent: 'github://acme/proof',
    repoKey: 'github://acme/proof',
  }
  const tick = async (advanceMs = 5_000) => {
    st.clock += advanceMs
    return runMacroCycle(input, cycle)
  }
  const guardInput: ProofGuardInput = { userId: 'u1', sessionId: 's1', taskId: 'T1', repoIdent: 'github://acme/proof', repoKey: 'github://acme/proof', sentinels: null, runLive: false }
  return { row, st, fx, log, tick, guardDeps, guardInput }
}

/** Exactly-once side effects after a run ended. */
function expectOnce(h: Awaited<ReturnType<typeof harness>>) {
  expect(h.fx.runLog.filter((e) => e.command === 'proof-outcome')).toHaveLength(1)
  expect(h.fx.notify).toHaveLength(1)
  expect(h.fx.disabled).toEqual(['T1'])
  expect(h.fx.kill).toHaveLength(1)
}

describe('proof cycle scenarios', () => {
  test('success: inject, then green -> pr_open_green (ship, all channels, PR url in the notification)', async () => {
    const fake = fakeGh()
    const h = await harness(fake)
    const t1 = await h.tick()
    expect(t1.proofDecision).toBe('proceed')
    expect(h.log.injects).toHaveLength(1)
    fake.apply(greenPr())
    const t2 = await h.tick()
    expect(t2.proofDecision).toBe('terminal')
    expect(h.log.injects).toHaveLength(1) // no further inject
    expect(h.row.outcome).toBe('pr_open_green')
    expect(h.row.status).toBe('succeeded')
    expectOnce(h)
    expect(h.fx.notify[0].event).toBe('ship')
    expect([...h.fx.notify[0].channels].sort()).toEqual(['email', 'inapp', 'push', 'telegram'])
    expect(h.fx.notify[0].detail).toContain('https://github.com/acme/proof/pull/1')
    expect(h.log.macroNotifies).toHaveLength(0)
  })

  test('red PR with budget left: proceed with a fix inject', async () => {
    const fake = fakeGh()
    const h = await harness(fake, { maxInjects: 3 })
    await h.tick()
    fake.apply(redPr())
    const t2 = await h.tick()
    expect(t2.proofDecision).toBe('proceed')
    expect(h.log.injects).toHaveLength(2)
    expect(h.row.status).toBe('running')
    expect(h.fx.notify).toHaveLength(0)
  })

  test('red PR with budget spent -> terminated:pr_open_ci_red', async () => {
    const fake = fakeGh()
    const h = await harness(fake, { maxInjects: 2 })
    await h.tick()
    fake.apply(redPr())
    await h.tick() // fix inject (2 of 2)
    const t3 = await h.tick()
    expect(t3.proofDecision).toBe('terminal')
    expect(h.log.injects).toHaveLength(2)
    expect(h.row.outcome).toBe('terminated:pr_open_ci_red')
    expectOnce(h)
    expect(h.fx.notify[0].event).toBe('failure')
  })

  test('CI pending: wait twice (no inject, no terminal), then green', async () => {
    const fake = fakeGh()
    const h = await harness(fake)
    await h.tick()
    fake.apply(pendingChecks())
    expect((await h.tick()).proofDecision).toBe('wait')
    expect((await h.tick()).proofDecision).toBe('wait')
    expect(h.log.injects).toHaveLength(1)
    expect(h.row.status).toBe('running')
    expect(h.fx.notify).toHaveLength(0)
    fake.apply(greenPr())
    expect((await h.tick()).proofDecision).toBe('terminal')
    expect(h.row.outcome).toBe('pr_open_green')
    expectOnce(h)
  })

  test('main advanced -> terminated:main_advanced (failure, all channels) and NO inject on later ticks', async () => {
    const fake = fakeGh()
    const h = await harness(fake)
    await h.tick()
    fake.apply(mainAdvanced())
    expect((await h.tick()).proofDecision).toBe('terminal')
    expect(h.row.outcome).toBe('terminated:main_advanced')
    expect(h.fx.notify[0].event).toBe('failure')
    expect([...h.fx.notify[0].channels].sort()).toEqual(['email', 'inapp', 'push', 'telegram'])
    expectOnce(h)
    const later = await h.tick()
    expect(later.proofDecision).toBe('blocked')
    expect(h.log.injects).toHaveLength(1)
    // the blocked tick re-disables the task idempotently but never re-pages or re-logs
    expect(h.fx.runLog.filter((e) => e.command === 'proof-outcome')).toHaveLength(1)
    expect(h.fx.notify).toHaveLength(1)
    expect(h.fx.kill).toHaveLength(1)
  })

  test('protection drift between ticks -> terminated:proof_protection_drift before any further inject', async () => {
    const fake = fakeGh()
    const h = await harness(fake)
    fake.scenario.rulesets[1] = { ...fake.scenario.rulesets[1], rules: [...CI_RULES, { type: 'deletion', parameters: null }], updatedAt: '2026-10-09T00:00:00Z' }
    const t1 = await h.tick()
    expect(t1.proofDecision).toBe('terminal')
    expect(h.log.injects).toHaveLength(0)
    expect(h.row.outcome).toBe('terminated:proof_protection_drift')
    expectOnce(h)
  })

  test('wall exceeded, no PR, last refusal supervisor_offline -> nothing:supervisor_offline (quiet: inapp + email)', async () => {
    const fake = fakeGh()
    const h = await harness(fake)
    h.st.nextInject = { kind: 'refused', reason: 'supervisor_offline' }
    const t1 = await h.tick()
    expect(t1.proofDecision).toBe('proceed')
    expect(h.row.status).toBe('running') // recoverable: the run keeps ticking
    expect(h.fx.notify).toHaveLength(0)
    const t2 = await h.tick(MAX_WALL + 1_000)
    expect(t2.proofDecision).toBe('terminal')
    expect(h.log.injects).toHaveLength(1) // terminated on the tick, no inject attempted
    expect(h.row.outcome).toBe('nothing:supervisor_offline')
    expectOnce(h)
    expect(h.fx.notify[0].event).toBe('info')
    expect([...h.fx.notify[0].channels].sort()).toEqual(['email', 'inapp'])
  })

  test('a class-ending refusal (not_allowlisted) ends the run once with one page', async () => {
    const fake = fakeGh()
    const h = await harness(fake)
    h.st.nextInject = { kind: 'refused', reason: 'not_allowlisted' }
    await h.tick()
    expect(h.row.outcome).toBe('nothing:not_allowlisted')
    expectOnce(h)
    expect(h.log.macroNotifies).toHaveLength(0)
  })

  test('guard error: the claim rejects -> nothing:guard_error, no inject, no exception', async () => {
    const fake = fakeGh()
    const h = await harness(fake, { claimThrows: true })
    const t1 = await h.tick()
    expect(t1.proofDecision).toBe('blocked')
    expect(h.log.injects).toHaveLength(0)
    expect(h.row.outcome).toBe('nothing:guard_error')
    expectOnce(h)
  })

  test('double terminalize: two racing guard calls with the same terminal verdict -> one row, one notification', async () => {
    const fake = fakeGh()
    const h = await harness(fake, { halted: true })
    const [a, b] = await Promise.all([proofGuard(h.guardDeps, h.guardInput), proofGuard(h.guardDeps, h.guardInput)])
    expect([a, b].filter((d) => d.kind === 'terminal' && d.won)).toHaveLength(1)
    expect(h.row.outcome).toBe('nothing:kill_switch')
    expect(h.fx.terminalized).toBe(1)
    expectOnce(h)
  })

  test('agent declines with no PR -> nothing:agent_declined; a decline is IGNORED once a PR exists', async () => {
    const reply = 'could not do it\n<<STATE\nlifecycle: development\nlast_action: nothing - repo is empty\nnext_action: none\nSTATE>>'
    const noPr = await harness(fakeGh(), { reply })
    await noPr.tick()
    expect(noPr.row.outcome).toBe('nothing:agent_declined')
    expectOnce(noPr)

    const fake = fakeGh(redPr())
    const withPr = await harness(fake, { reply })
    const t = await withPr.tick()
    expect(t.proofDecision).toBe('proceed')
    expect(withPr.row.status).toBe('running')
  })
})

describe('final injected string (F3-3)', () => {
  test('no banned token; every git push is `git push -u origin <run.branch>`; no other remote ref', async () => {
    const fake = fakeGh()
    const h = await harness(fake, { maxInjects: 4 })
    await h.tick()
    fake.apply(redPr())
    await h.tick()
    expect(h.log.injects.length).toBeGreaterThanOrEqual(2)
    for (const i of h.log.injects) {
      const p: string = i.prompt
      expect(p).toContain(h.row.branch)
      expect(/\b(merge|deploy|release|force)\b/i.test(p)).toBe(false)
      expect(p.includes('--admin')).toBe(false)
      for (const m of p.matchAll(/git push[^\n]*/g)) {
        expect(m[0].startsWith(`git push -u origin ${h.row.branch}`)).toBe(true)
        expect(m[0].slice(`git push -u origin ${h.row.branch}`.length).trim()).toBe('')
      }
      const refs = new Set([...p.matchAll(/\bproof\/[\w.-]+/g)].map((m) => m[0]))
      expect([...refs]).toEqual([h.row.branch])
    }
  })
})
