/**
 * PTYCAP-05 plan 06 task 2: (a) the proof inject counter key is pinned (runMacroCycle threads taskId;
 * the REAL injectOrchestratorPrompt builds task:<taskId> on the online AND autospawn paths), and
 * (b) every inject outcome lands in the closed outcome sets or is recorded as recoverable (observeInject).
 * DB-free: injected deps only. No mock.module.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { injectOrchestratorPrompt, type InjectDeps } from '../src/orchestrator/inject.ts'
import { runMacroCycle, type MacroCycleDeps, type MacroCycleInput } from '../src/orchestrator/macro-cycle.ts'
import { makeProofHooks, mapInjectOutcome, type ProofGuardDeps } from '../src/orchestrator/proof-guard.ts'
import { isProofOutcome, outcomeToStatus, type ProofGuardInput, type ProofOutcome, type ProofRun } from '../src/orchestrator/proof-types.ts'

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

function cycleInput(over: Partial<MacroCycleInput> = {}): MacroCycleInput {
  return {
    userId: 'u1',
    sessionId: 's1',
    taskId: 'T7',
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
    task_id: 'T7',
    session_id: 's1',
    repo_ident: 'github://acme/proof',
    counter_key: 'task:T7',
    branch: 'proof/run1',
    installation_id: 99,
    repo_owner: 'acme',
    repo_name: 'proof',
    default_branch: 'main',
    base_sha: 'a'.repeat(40),
    ruleset_ids: [1],
    ruleset_digest: 'd',
    ruleset_updated_at: null,
    protection_shape: 'branch_lock',
    required_contexts: ['ci'],
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

// ── (a) the counter-key pin ──────────────────────────────────────────────────

function injectDeps(online: boolean) {
  const rec = { reqs: [] as any[], resolverCalls: [] as any[], launched: 0 }
  const deps: InjectDeps = {
    getChannel: (() => (online ? { ws: { send() {} } } : null)) as any,
    isSessionLive: async () => online,
    isOrchestratorEnabled: () => true,
    isAutospawnEnabled: () => true,
    isRepoAutospawnAllowed: async () => true,
    getTokenCapStatus: async () => ({ over: false, tokens: 0, cap: 50_000_000 }),
    countAutospawnLaunchesToday: async () => 0,
    supervisorOnlineForUser: async () => true,
    graceParkPending: () => false,
    appendRunLog: (async () => ({}) as any) as any,
    launchSessionForUser: (async () => {
      rec.launched++
      return { ok: true, runId: 'r', supervisorId: 's', hostname: 'h', repoPath: '/x' }
    }) as any,
    resolveCounterKey: (async (a: any) => {
      rec.resolverCalls.push(a)
      return 'task:RESOLVED'
    }) as any,
    dispatch: (async (req: any) => {
      rec.reqs.push(req)
      return online ? { kind: 'dispatched' as const } : { kind: 'parked_offline' as const }
    }) as any,
  }
  return { deps, rec }
}

function cycleDeps(over: Partial<MacroCycleDeps> = {}) {
  const log = { injects: [] as any[], notifies: [] as any[] }
  const deps: MacroCycleDeps = {
    getLatestAssistantReply: async () => null,
    appendRunLog: (async (e: any) => ({ id: 'rl', ...e, created_at: '' })) as any,
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
    ...over,
  }
  return { deps, log }
}

describe('counter key pin (D-02, f)', () => {
  test('runMacroCycle passes input.taskId to the inject seam', async () => {
    const { deps, log } = cycleDeps()
    await runMacroCycle(cycleInput({ taskId: 'T7' }), deps)
    expect(log.injects).toHaveLength(1)
    expect(log.injects[0].taskId).toBe('T7')
  })

  for (const online of [true, false]) {
    const path = online ? 'online' : 'autospawn'
    test(`${path}: runMacroCycle + REAL injectOrchestratorPrompt -> counterKey is task:<taskId>`, async () => {
      const { deps: injDeps, rec } = injectDeps(online)
      const { deps } = cycleDeps({ inject: ((i: any) => injectOrchestratorPrompt(i, injDeps)) as any })
      await runMacroCycle(cycleInput({ taskId: 'T7' }), deps)
      expect(rec.reqs).toHaveLength(1)
      expect(rec.reqs[0].counterKey).toBe('task:T7')
      expect(rec.resolverCalls).toHaveLength(0)
    })
  }

  test('taskId omitted: the resolver is consulted (documented; the proof gate refuses a non-task: key)', async () => {
    const { deps, rec } = injectDeps(true)
    await injectOrchestratorPrompt({ userId: 'u1', sessionId: 's1', token: 't', prompt: 'p' }, deps)
    expect(rec.resolverCalls).toHaveLength(1)
    expect(rec.reqs[0].counterKey).toBe('task:RESOLVED')
  })
})

// ── (b) inject-outcome mapping onto the closed sets ──────────────────────────

const refused = (reason: string) => ({ kind: 'refused', reason })

// reason -> expected terminal outcome (undefined = recorded only, run keeps ticking)
const TABLE: Array<[string, any, ProofOutcome | undefined]> = [
  ['dispatched', { kind: 'dispatched' }, undefined],
  ['queued', { kind: 'queued' }, undefined],
  ['autospawn_launched', { kind: 'autospawn_launched' }, undefined],
  ['autospawn_parked', { kind: 'autospawn_parked' }, undefined],
  ['no_session', { kind: 'no_session' }, undefined],
  ['failed', { kind: 'failed', reason: 'boom' }, undefined],
  ['supervisor_offline', refused('supervisor_offline'), undefined],
  ['launch_cap', refused('launch_cap'), undefined],
  ['session_busy', refused('session_busy'), undefined],
  ['over_session_inject_rate', refused('over_session_inject_rate:5>=4'), undefined],
  ['autospawn_launch_x', refused('autospawn_launch_no_host'), undefined],
  ['proof_budget_injects', refused('proof_budget_injects:5>=5'), undefined],
  ['proof_budget_tokens', refused('proof_budget_tokens:9>=5'), undefined],
  ['unknown refusal', refused('something_new'), undefined],
  ['not_allowlisted', refused('not_allowlisted'), 'nothing:not_allowlisted'],
  ['over_token_cap', refused('over_token_cap'), 'nothing:over_token_cap'],
  ['refused_cost_cap', { kind: 'refused_cost_cap' }, 'nothing:cost_cap'],
  ['automation_halted', refused('automation_halted:global'), 'nothing:kill_switch'],
  ['lifetime_inject_exhausted', refused('lifetime_inject_exhausted:task:T7'), 'nothing:lifetime_exhausted'],
  ['proof_protection_drift', refused('proof_protection_drift'), 'terminated:proof_protection_drift'],
  ['proof_protection_unverifiable', refused('proof_protection_unverifiable'), 'terminated:proof_protection_unverifiable'],
  ['proof_budget_attribution_lost', refused('proof_budget_attribution_lost'), 'terminated:budget_attribution_lost'],
  ['proof_budget_wall (no PR)', refused('proof_budget_wall'), 'nothing:no_pr_produced_within_budget'],
  ['proof_budget_unverifiable', refused('proof_budget_unverifiable'), 'nothing:guard_error'],
  ['lifetime_counter_key_missing', refused('lifetime_counter_key_missing'), 'nothing:guard_error'],
]

describe('mapInjectOutcome (closed sets only, D-13)', () => {
  for (const [name, outcome, expected] of TABLE) {
    test(`${name} -> ${expected ?? 'recorded only'}`, () => {
      const m = mapInjectOutcome(outcome, runRow({ status: 'running' }))
      expect(m.terminal?.outcome).toBe(expected)
      if (m.terminal) expect(isProofOutcome(m.terminal.outcome)).toBe(true)
      expect(m.noop).toBeUndefined()
    })
  }

  test('record string is <kind> or <kind>:<reason>', () => {
    const run = runRow()
    expect(mapInjectOutcome({ kind: 'dispatched' }, run).record).toBe('dispatched')
    expect(mapInjectOutcome(refused('supervisor_offline'), run).record).toBe('refused:supervisor_offline')
    expect(mapInjectOutcome('queued', run).record).toBe('queued')
  })

  test('proof_run_terminal:* is a no-op', () => {
    expect(mapInjectOutcome(refused('proof_run_terminal:pr_open_green'), runRow()).noop).toBe(true)
  })

  test('proof_budget_wall names through the budget selector (red PR / open PR)', () => {
    expect(mapInjectOutcome(refused('proof_budget_wall'), runRow({ pr_number: 3, last_ci_state: 'ci_red' })).terminal?.outcome).toBe('terminated:pr_open_ci_red')
    expect(mapInjectOutcome(refused('proof_budget_wall'), runRow({ pr_number: 3, last_ci_state: 'ci_pending' })).terminal?.outcome).toBe('terminated:budget_wall')
    expect(mapInjectOutcome(refused('proof_budget_wall'), runRow({ last_inject_outcome: 'refused:supervisor_offline' })).terminal?.outcome).toBe('nothing:supervisor_offline')
  })
})

// ── observeInject through the real hooks over an in-memory store ─────────────

function store(runs: ProofRun[]) {
  const calls = { observed: [] as string[], runLog: [] as any[], notify: [] as any[], kill: 0, disabled: 0, terminalized: 0 }
  const active = (r: ProofRun) => r.status === 'armed' || r.status === 'running'
  const deps: ProofGuardDeps = {
    isEnabled: () => true,
    claimActiveRun: async (taskId) => {
      const r = runs.find((x) => x.task_id === taskId && active(x))
      if (!r) return null
      r.status = 'running'
      r.started_at = r.started_at ?? '2026-10-13T00:00:01Z'
      return { ...r }
    },
    taskHasAnyRun: async (taskId) => runs.some((x) => x.task_id === taskId),
    terminalize: async (a) => {
      const r = runs.find((x) => x.id === a.runId && active(x))
      if (!r) return null
      calls.terminalized++
      r.status = outcomeToStatus(a.outcome)
      r.outcome = a.outcome
      return { ...r }
    },
    terminalizeByTask: async () => null,
    disableTask: async () => {
      calls.disabled++
    },
    engageSessionKill: async () => {
      calls.kill++
    },
    appendRunLog: async (e) => {
      calls.runLog.push(e)
    },
    fanOut: async (n) => {
      calls.notify.push(n)
    },
    recordInjectOutcome: async (_id, kind) => {
      calls.observed.push(kind)
    },
    evaluators: [],
    now: () => 1_000,
  }
  return { deps, calls, runs }
}

const guardInput = (over: Partial<ProofGuardInput> = {}): ProofGuardInput => ({
  userId: 'u1',
  sessionId: 's1',
  taskId: 'T7',
  repoIdent: 'github://acme/proof',
  repoKey: 'github://acme/proof',
  sentinels: null,
  runLive: false,
  ...over,
})

describe('observeInject', () => {
  test('recoverable outcome: recorded, run stays active, nothing sent', async () => {
    const s = store([runRow({ status: 'running' })])
    await makeProofHooks(s.deps).observeInject(runRow({ status: 'running' }), refused('supervisor_offline'), guardInput())
    expect(s.calls.observed).toEqual(['refused:supervisor_offline'])
    expect(s.calls.terminalized).toBe(0)
    expect(s.calls.notify).toHaveLength(0)
    expect(s.runs[0].status).toBe('running')
  })

  test('class-ending refusal: ends the run once (row, notification, kill, disable)', async () => {
    const s = store([runRow({ status: 'running' })])
    const hooks = makeProofHooks(s.deps)
    await hooks.observeInject(runRow({ status: 'running' }), refused('not_allowlisted'), guardInput())
    await hooks.observeInject(runRow({ status: 'running' }), refused('not_allowlisted'), guardInput()) // lost the race
    expect(s.runs[0].outcome).toBe('nothing:not_allowlisted')
    expect(s.calls.runLog.filter((e) => e.command === 'proof-outcome')).toHaveLength(1)
    expect(s.calls.notify).toHaveLength(1)
    expect(s.calls.kill).toBe(1)
    expect(s.calls.disabled).toBe(1)
  })

  test('never throws, even when the store rejects', async () => {
    const s = store([runRow({ status: 'running' })])
    s.deps.recordInjectOutcome = async () => {
      throw new Error('db_down')
    }
    s.deps.terminalize = async () => {
      throw new Error('db_down')
    }
    await expect(makeProofHooks(s.deps).observeInject(runRow({ status: 'running' }), refused('over_token_cap'), guardInput())).resolves.toBeUndefined()
  })

  test('a refused proof tick through runMacroCycle pages exactly once (the terminalizer, not emitFailure)', async () => {
    flagsOn()
    const s = store([runRow()])
    const { deps, log } = cycleDeps({
      proof: makeProofHooks(s.deps),
      inject: (async () => refused('not_allowlisted')) as any,
    })
    const r = await runMacroCycle(cycleInput(), deps)
    expect(r.injected).toBe(false)
    expect(s.runs[0].outcome).toBe('nothing:not_allowlisted')
    expect(s.calls.notify).toHaveLength(1)
    expect(log.notifies).toHaveLength(0) // macro-cycle's own failure page is skipped for proof ticks
    expect(s.calls.runLog.filter((e) => e.command === 'proof-outcome')).toHaveLength(1)
  })

  test('a recoverable refused tick pages nothing at all and the run keeps going', async () => {
    flagsOn()
    const s = store([runRow()])
    const { deps, log } = cycleDeps({
      proof: makeProofHooks(s.deps),
      inject: (async () => refused('supervisor_offline')) as any,
    })
    await runMacroCycle(cycleInput(), deps)
    expect(s.runs[0].status).toBe('running')
    expect(s.calls.notify).toHaveLength(0)
    expect(log.notifies).toHaveLength(0)
    expect(s.calls.observed).toEqual(['refused:supervisor_offline'])
  })
})
