/**
 * PTYCAP-05 tracer: armed proof row -> claim -> proof prompt -> terminal ->
 * run-log + one notification + task disabled + session kill, and flag OFF == today.
 * DB-free: runMacroCycle is driven with fake MacroCycleDeps and fake ProofGuardDeps
 * (an in-memory store). No mock.module: nothing here touches postgres.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { runMacroCycle, type MacroCycleDeps, type MacroCycleInput } from '../src/orchestrator/macro-cycle.ts'
import { renderMacro } from '../src/orchestrator/task-macros.ts'
import {
  isProofEnabled,
  isProofFlagOn,
  outcomeToStatus,
  isProofOutcome,
  type ProofCycleHooks,
  type ProofOutcome,
  type ProofRun,
} from '../src/orchestrator/proof-types.ts'
import { renderProofPrompt } from '../src/orchestrator/proof-prompt.ts'
import {
  agentDeclinedEvaluator,
  makeProofHooks,
  type ProofEvaluator,
  type ProofGuardDeps,
} from '../src/orchestrator/proof-guard.ts'

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

function input(over: Partial<MacroCycleInput> = {}): MacroCycleInput {
  return {
    userId: 'u1',
    sessionId: 's1',
    taskId: 't1',
    macroTaskType: 'dev',
    stage: 'development',
    repoPath: '/srv/repos/proof',
    repoIdent: 'github://acme/proof',
    repoKey: 'github://acme/proof',
    ...over,
  }
}

function runRow(over: Partial<ProofRun> = {}): ProofRun {
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
    ruleset_ids: [1],
    ruleset_digest: 'd',
    ruleset_updated_at: null,
    protection_shape: 'update_restriction',
    required_contexts: [],
    arm_preconditions: {},
    max_injects: 5,
    max_tokens: 1000,
    max_wall_ms: 60000,
    status: 'armed',
    outcome: null,
    outcome_detail: null,
    pr_url: null,
    pr_number: null,
    last_ci_state: null,
    last_inject_outcome: null,
    tokens_hwm: 0,
    armed_at: '2026-10-13T00:00:00Z',
    updated_at: '2026-10-13T00:00:00Z',
    started_at: null,
    terminal_at: null,
    ...over,
  }
}

/** In-memory ProofGuardDeps over a run store; every call is recorded. */
function makeStore(runs: ProofRun[], opts: { evaluators?: ProofEvaluator[]; claimThrows?: boolean } = {}) {
  const calls = {
    claim: 0,
    hasAny: 0,
    terminalize: 0,
    terminalizeByTask: 0,
    disable: [] as string[],
    kill: [] as any[],
    runLog: [] as any[],
    notify: [] as any[],
    observed: [] as Array<[string, string]>,
  }
  const active = (r: ProofRun) => r.status === 'armed' || r.status === 'running'
  const end = (r: ProofRun, outcome: ProofOutcome, detail: string) => {
    r.status = outcomeToStatus(outcome)
    r.outcome = outcome
    r.outcome_detail = detail
    r.terminal_at = 'now'
    return r
  }
  const deps: ProofGuardDeps = {
    isEnabled: isProofEnabled,
    claimActiveRun: async (taskId) => {
      calls.claim++
      if (opts.claimThrows) throw new Error('db_down')
      const r = runs.find((x) => x.task_id === taskId && active(x))
      if (!r) return null
      r.status = 'running'
      r.started_at = r.started_at ?? 'now'
      return { ...r }
    },
    taskHasAnyRun: async (taskId) => {
      calls.hasAny++
      return runs.some((x) => x.task_id === taskId)
    },
    terminalize: async (a) => {
      calls.terminalize++
      const r = runs.find((x) => x.id === a.runId && active(x))
      return r ? { ...end(r, a.outcome, a.detail) } : null
    },
    terminalizeByTask: async (a) => {
      calls.terminalizeByTask++
      const r = runs.find((x) => x.task_id === a.taskId && active(x))
      return r ? { ...end(r, a.outcome, a.detail) } : null
    },
    disableTask: async (_u, taskId) => {
      calls.disable.push(taskId)
    },
    engageSessionKill: async (a) => {
      calls.kill.push(a)
    },
    appendRunLog: async (e) => {
      calls.runLog.push(e)
    },
    fanOut: async (n) => {
      calls.notify.push(n)
    },
    recordInjectOutcome: async (runId, kind) => {
      calls.observed.push([runId, kind])
    },
    evaluators: opts.evaluators ?? [agentDeclinedEvaluator],
    now: () => 1_000,
  }
  return { deps, calls, runs }
}

function cycleDeps(proof: ProofCycleHooks | undefined, over: Partial<MacroCycleDeps> = {}) {
  const log = { injects: [] as any[], runLogs: [] as any[], notifies: [] as any[] }
  const deps: MacroCycleDeps = {
    getLatestAssistantReply: async () => null,
    appendRunLog: (async (e: any) => {
      log.runLogs.push(e)
      return { id: 'rl', ...e, created_at: '' }
    }) as any,
    inject: (async (i: any) => {
      log.injects.push(i)
      return { kind: 'dispatched' as const }
    }) as any,
    fanOut: (async (n: any) => {
      log.notifies.push(n)
      return { delivered: [] }
    }) as any,
    isRunLive: () => false,
    refreshCapGauges: (async () => {}) as any,
    getCapStatuses: (async () => ({ costStatus: null, tokenStatus: null })) as any,
    proof,
    ...over,
  }
  return { deps, log }
}

const devPrompt = () =>
  renderMacro('dev', { repo_path: '/srv/repos/proof', repo_ident: 'github://acme/proof', lifecycle_stage: 'development' }).prompt

describe('proof flag stack', () => {
  test('on only when all three flags are 1|true|yes|on', () => {
    expect(isProofEnabled()).toBe(false)
    flagsOn()
    expect(isProofEnabled()).toBe(true)
    process.env.REMO_ORCHESTRATOR_PROOF = ' TRUE '
    expect(isProofFlagOn()).toBe(true)
    process.env.REMO_ORCHESTRATOR_PROOF = 'maybe'
    expect(isProofEnabled()).toBe(false)
    process.env.REMO_ORCHESTRATOR_PROOF = 'on'
    delete process.env.REMO_ORCHESTRATOR_AUTOSPAWN
    expect(isProofEnabled()).toBe(false)
  })

  test('outcome closed set maps to status', () => {
    expect(isProofOutcome('pr_open_green')).toBe(true)
    expect(isProofOutcome('nothing:agent_declined')).toBe(true)
    expect(isProofOutcome('terminated:main_advanced')).toBe(true)
    expect(isProofOutcome('nothing:bogus')).toBe(false)
    expect(outcomeToStatus('pr_open_green')).toBe('succeeded')
    expect(outcomeToStatus('nothing:guard_error')).toBe('nothing')
    expect(outcomeToStatus('terminated:budget_wall')).toBe('terminated')
  })
})

describe('flag OFF is a true no-op (each flag individually)', () => {
  for (const off of FLAGS) {
    test(`${off} unset: no proof hook touched, dev macro prompt injected`, async () => {
      flagsOn()
      delete process.env[off]
      const store = makeStore([runRow()])
      const hooks = makeProofHooks(store.deps)
      let touched = 0
      const spied: ProofCycleHooks = {
        guard: (i) => (touched++, hooks.guard(i)),
        render: (r) => (touched++, hooks.render(r)),
        observeInject: (r, k) => (touched++, hooks.observeInject(r, k)),
        abort: (r, a, b, c) => (touched++, hooks.abort(r, a, b, c)),
      }
      const { deps, log } = cycleDeps(spied)
      const r = await runMacroCycle(input(), deps)
      expect(touched).toBe(0)
      expect(store.calls.claim).toBe(0)
      expect(store.calls.hasAny).toBe(0)
      expect(r.proofDecision).toBeUndefined()
      expect(r.injected).toBe(true)
      expect(log.injects).toHaveLength(1)
      expect(log.injects[0].prompt).toBe(devPrompt())
      expect(log.injects[0].taskId).toBe('t1')
      expect(store.runs[0].status).toBe('armed')
    })
  }
})

describe('flag ON: claim + proof prompt', () => {
  test('armed run -> ONE claim, prompt rendered from the claimed snapshot, dev macro not used', async () => {
    flagsOn()
    const store = makeStore([runRow()])
    const { deps, log } = cycleDeps(makeProofHooks(store.deps))
    const r = await runMacroCycle(input(), deps)
    expect(r.proofDecision).toBe('proceed')
    expect(r.injected).toBe(true)
    expect(store.calls.claim).toBe(1)
    expect(store.calls.hasAny).toBe(0) // no second lookup between claim and render
    expect(store.runs[0].status).toBe('running')
    expect(log.injects).toHaveLength(1)
    expect(log.injects[0].prompt).toBe(renderProofPrompt({ ...runRow(), status: 'running', started_at: 'now' }))
    expect(log.injects[0].prompt).not.toBe(devPrompt())
    expect(log.injects[0].taskId).toBe('t1')
    expect(log.runLogs.some((e) => e.command === 'macro:dev')).toBe(true)
    expect(store.calls.observed).toEqual([['run1', 'dispatched']])
  })

  test('refused proof inject does not page from macro-cycle (proof terminalizer is the only reporter)', async () => {
    flagsOn()
    const store = makeStore([runRow()])
    const { deps, log } = cycleDeps(makeProofHooks(store.deps), {
      inject: (async () => ({ kind: 'refused' as const, reason: 'threshold' })) as any,
    })
    const r = await runMacroCycle(input(), deps)
    expect(r.injected).toBe(false)
    expect(log.notifies).toHaveLength(0)
  })

  test('terminal-only task is blocked: no inject, task disabled', async () => {
    flagsOn()
    const store = makeStore([runRow({ status: 'nothing', outcome: 'nothing:agent_declined', terminal_at: 'x' })])
    const { deps, log } = cycleDeps(makeProofHooks(store.deps))
    const r = await runMacroCycle(input(), deps)
    expect(r.proofDecision).toBe('blocked')
    expect(r.injected).toBe(false)
    expect(log.injects).toHaveLength(0)
    expect(store.calls.disable).toEqual(['t1'])
  })

  test('task with no proof run at all passes through to the ordinary macro', async () => {
    flagsOn()
    const store = makeStore([runRow({ task_id: 'other' })])
    const { deps, log } = cycleDeps(makeProofHooks(store.deps))
    const r = await runMacroCycle(input(), deps)
    expect(r.proofDecision).toBe('pass_through')
    expect(r.injected).toBe(true)
    expect(log.injects[0].prompt).toBe(devPrompt())
    expect(store.runs[0].status).toBe('armed')
  })

  test('evaluator wait: nothing injected, nothing terminalized, no run-log row', async () => {
    flagsOn()
    const store = makeStore([runRow()], { evaluators: [async () => ({ kind: 'wait' as const })] })
    const { deps, log } = cycleDeps(makeProofHooks(store.deps))
    const r = await runMacroCycle(input(), deps)
    expect(r.proofDecision).toBe('wait')
    expect(log.injects).toHaveLength(0)
    expect(log.runLogs).toHaveLength(0)
    expect(store.calls.terminalize).toBe(0)
    expect(store.calls.runLog).toHaveLength(0)
  })

  test('guard input carries runLive evaluated before the guard', async () => {
    flagsOn()
    let seen: boolean | null = null
    const store = makeStore([runRow()], {
      evaluators: [
        async (ctx) => {
          seen = ctx.input.runLive
          return { kind: 'wait' as const }
        },
      ],
    })
    const { deps } = cycleDeps(makeProofHooks(store.deps), { isRunLive: () => true })
    await runMacroCycle(input(), deps)
    expect(seen as boolean | null).toBe(true)
  })
})

describe('flag ON: fail closed, never the dev macro', () => {
  test('claim throws: no inject, run ended as nothing:guard_error, no exception escapes', async () => {
    flagsOn()
    const store = makeStore([runRow()], { claimThrows: true })
    const { deps, log } = cycleDeps(makeProofHooks(store.deps))
    const r = await runMacroCycle(input(), deps)
    expect(r.proofDecision).toBe('blocked')
    expect(log.injects).toHaveLength(0)
    expect(store.calls.terminalizeByTask).toBe(1)
    expect(store.runs[0].outcome).toBe('nothing:guard_error')
    expect(store.calls.runLog.filter((e) => e.command === 'proof-outcome')).toHaveLength(1)
  })

  test('render throws: no inject, run ended as nothing:guard_error', async () => {
    flagsOn()
    const store = makeStore([runRow()])
    const hooks: ProofCycleHooks = {
      ...makeProofHooks(store.deps),
      render: () => {
        throw new Error('render_boom')
      },
    }
    const { deps, log } = cycleDeps(hooks)
    const r = await runMacroCycle(input(), deps)
    expect(r.proofDecision).toBe('terminal')
    expect(log.injects).toHaveLength(0)
    expect(store.runs[0].outcome).toBe('nothing:guard_error')
    expect(store.calls.notify).toHaveLength(1)
  })

  test('hooks that throw are fail closed too', async () => {
    flagsOn()
    const store = makeStore([runRow()])
    const hooks: ProofCycleHooks = {
      ...makeProofHooks(store.deps),
      guard: async () => {
        throw new Error('guard_boom')
      },
    }
    const { deps, log } = cycleDeps(hooks)
    const r = await runMacroCycle(input(), deps)
    expect(r.proofDecision).toBe('blocked')
    expect(log.injects).toHaveLength(0)
  })
})

describe('declined path (D-13) and single-winner terminalizer (D-04, D-07)', () => {
  const declined = '<<STATE\nlifecycle: development\nlast_action: nothing - the repo looks unsafe to touch\nSTATE>>'

  test('tick 1 injects; tick 2 reconciles the decline into ONE terminal; tick 3 is blocked', async () => {
    flagsOn()
    const store = makeStore([runRow()])
    const hooks = makeProofHooks(store.deps)

    const t1 = cycleDeps(hooks)
    await runMacroCycle(input(), t1.deps)
    expect(t1.log.injects).toHaveLength(1)

    const t2 = cycleDeps(hooks, { getLatestAssistantReply: async () => declined })
    const r2 = await runMacroCycle(input(), t2.deps)
    expect(r2.proofDecision).toBe('terminal')
    expect(t2.log.injects).toHaveLength(0)
    expect(store.runs[0].status).toBe('nothing')
    expect(store.runs[0].outcome).toBe('nothing:agent_declined')
    expect(store.runs[0].outcome_detail).toBe('the repo looks unsafe to touch')
    const outcomeRows = store.calls.runLog.filter((e) => e.command === 'proof-outcome')
    expect(outcomeRows).toHaveLength(1)
    expect(outcomeRows[0].outcome).toBe('nothing:agent_declined')
    expect(store.calls.notify).toHaveLength(1)
    expect(store.calls.notify[0].event).toBe('info')
    expect(store.calls.notify[0].channels).toEqual(['inapp', 'email'])
    expect(store.calls.disable).toEqual(['t1'])
    expect(store.calls.kill).toHaveLength(1)
    expect(store.calls.kill[0]).toMatchObject({
      sessionId: 's1',
      userId: 'u1',
      engagedBy: 'proof-guard',
      reason: 'proof_terminal:nothing:agent_declined',
    })

    // second attempt: run terminal -> blocked, no second row / notification / kill
    const t3 = cycleDeps(hooks, { getLatestAssistantReply: async () => declined })
    const r3 = await runMacroCycle(input(), t3.deps)
    expect(r3.proofDecision).toBe('blocked')
    expect(t3.log.injects).toHaveLength(0)
    expect(store.calls.runLog.filter((e) => e.command === 'proof-outcome')).toHaveLength(1)
    expect(store.calls.notify).toHaveLength(1)
    expect(store.calls.kill).toHaveLength(1)
  })

  test('decline reason is truncated to 200 chars', async () => {
    flagsOn()
    const store = makeStore([runRow()])
    const long = 'x'.repeat(500)
    const t = cycleDeps(makeProofHooks(store.deps), {
      getLatestAssistantReply: async () => `<<STATE\nlast_action: nothing - ${long}\nSTATE>>`,
    })
    await runMacroCycle(input(), t.deps)
    expect(store.runs[0].outcome_detail).toBe('x'.repeat(200))
  })

  test('lost claim (terminalize resolves null): no run-log, no notification, no kill, no disable', async () => {
    flagsOn()
    const store = makeStore([runRow()])
    store.deps.terminalize = async () => null
    const t = cycleDeps(makeProofHooks(store.deps), { getLatestAssistantReply: async () => declined })
    const r = await runMacroCycle(input(), t.deps)
    expect(r.proofDecision).toBe('terminal')
    expect(store.calls.runLog).toHaveLength(0)
    expect(store.calls.notify).toHaveLength(0)
    expect(store.calls.kill).toHaveLength(0)
    expect(store.calls.disable).toHaveLength(0)
    expect(t.log.injects).toHaveLength(0)
  })
})

describe('renderProofPrompt', () => {
  const running = () => runRow({ status: 'running' })

  test('throws unless the run is running', () => {
    expect(() => renderProofPrompt(runRow({ status: 'armed' }))).toThrow()
    expect(() => renderProofPrompt(runRow({ status: 'succeeded' }))).toThrow()
  })

  test('names the branch, default branch and repo, and the STATE / decline protocol', () => {
    const p = renderProofPrompt(running())
    expect(p).toContain('proof/run1')
    expect(p).toContain('main')
    expect(p).toContain('github://acme/proof')
    expect(p).toContain('<<STATE')
    expect(p).toContain('last_action: nothing - <reason>')
    expect(p).toContain('docs/proof-run1.md')
  })

  test('FINAL string carries none of the banned tokens and pushes only the exact proof branch', () => {
    const p = renderProofPrompt(running())
    for (const banned of [/\bmerge/i, /\bdeploy/i, /\brelease/i, /--admin/i, /\bforce/i]) {
      expect(p).not.toMatch(banned)
    }
    const pushLines = p.split('\n').filter((l) => /\bpush/i.test(l))
    expect(pushLines.length).toBeGreaterThan(0)
    for (const l of pushLines) {
      // every push sentence names the proof branch or forbids pushing the default branch
      expect(/proof\/run1|never push to it/.test(l)).toBe(true)
    }
    expect(p).not.toMatch(/push[^.\n]*origin main/i)
  })
})
