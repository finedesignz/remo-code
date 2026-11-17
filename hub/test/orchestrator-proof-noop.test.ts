/**
 * PTYCAP-05 plan 08 task 1 (D-03, D-16): the flag-OFF differential matrix.
 *
 * With the proof flag stack not fully ON the orchestrator must behave EXACTLY like today:
 * zero SQL, zero fetch, no proof hook / guard / verifier / github call, identical inject
 * arguments, gates pass through with zero dep calls, merge routing unchanged. This file
 * exists to make that falsifiable: a DB read or side-effecting import added ahead of the
 * flag check fails here.
 *
 * Single process, self-contained (Bun mock.module is process-global): db/postgres.ts is
 * replaced by a recording sql that THROWS on any use, and the proof guard / verifier /
 * github modules are replaced by recorders so a stray dynamic import is detected.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'

const FLAGS = ['REMO_ORCHESTRATOR_PROOF', 'REMO_ORCHESTRATOR_ENABLED', 'REMO_ORCHESTRATOR_AUTOSPAWN'] as const

const rec = { sql: 0, fetch: 0, guardLoads: 0, verifier: 0, github: 0, proofHooks: 0 }

const sqlTrap: any = new Proxy(function () {}, {
  apply() {
    rec.sql++
    throw new Error('sql used while proof flag stack OFF')
  },
  get(_t, p) {
    rec.sql++
    throw new Error(`sql.${String(p)} touched while proof flag stack OFF`)
  },
})

let macro: typeof import('../src/orchestrator/macro-cycle.ts')
let types: typeof import('../src/orchestrator/proof-types.ts')
let controller: typeof import('../src/orchestrator/controller.ts')
let gates: typeof import('../src/orchestrator/proof-gates.ts')
let merge: typeof import('../src/orchestrator/merge-command.ts')
let tasks: typeof import('../src/orchestrator/task-macros.ts')
const realFetch = globalThis.fetch

beforeAll(async () => {
  mock.module('../src/db/postgres.ts', () => ({ sql: sqlTrap }))
  mock.module('../src/orchestrator/proof-guard.ts', () => ({
    realProofHooks: async () => {
      rec.guardLoads++
      throw new Error('proof guard loaded while proof flag stack OFF')
    },
  }))
  mock.module('../src/orchestrator/proof-verifier.ts', () => ({
    verifyProof: async () => {
      rec.verifier++
      throw new Error('verifier called while proof flag stack OFF')
    },
  }))
  mock.module('../src/orchestrator/proof-github.ts', () => ({
    makeProofGithub: () => {
      rec.github++
      throw new Error('github adapter built while proof flag stack OFF')
    },
  }))
  types = await import('../src/orchestrator/proof-types.ts')
  controller = await import('../src/orchestrator/controller.ts')
  macro = await import('../src/orchestrator/macro-cycle.ts')
  gates = await import('../src/orchestrator/proof-gates.ts')
  merge = await import('../src/orchestrator/merge-command.ts')
  tasks = await import('../src/orchestrator/task-macros.ts')
})

afterAll(() => {
  globalThis.fetch = realFetch
  mock.restore()
})

const saved: Record<string, string | undefined> = {}
beforeEach(() => {
  for (const k of FLAGS) {
    saved[k] = process.env[k]
    delete process.env[k]
  }
  rec.sql = rec.fetch = rec.guardLoads = rec.verifier = rec.github = rec.proofHooks = 0
  globalThis.fetch = (async () => {
    rec.fetch++
    throw new Error('fetch used while proof flag stack OFF')
  }) as any
})
afterEach(() => {
  globalThis.fetch = realFetch
  for (const k of FLAGS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})

/** All 8 combinations of [proof, orchestrator, autospawn]; index 7 is all-on. */
const COMBOS: Array<Record<(typeof FLAGS)[number], boolean>> = Array.from({ length: 8 }, (_, i) => ({
  REMO_ORCHESTRATOR_PROOF: (i & 1) !== 0,
  REMO_ORCHESTRATOR_ENABLED: (i & 2) !== 0,
  REMO_ORCHESTRATOR_AUTOSPAWN: (i & 4) !== 0,
}))
const OFF_COMBOS = COMBOS.filter((c) => !FLAGS.every((k) => c[k]))
const label = (c: Record<string, boolean>) => FLAGS.map((k) => `${k.replace('REMO_ORCHESTRATOR_', '')}=${c[k] ? 1 : 0}`).join(' ')
function applyCombo(c: Record<string, boolean>) {
  for (const k of FLAGS) {
    if (c[k]) process.env[k] = '1'
    else delete process.env[k]
  }
}

function input(): import('../src/orchestrator/macro-cycle.ts').MacroCycleInput {
  return {
    userId: 'u1',
    sessionId: 's1',
    taskId: 't1',
    macroTaskType: 'dev',
    stage: 'development',
    repoPath: '/srv/repos/acme',
    repoIdent: 'github://acme/acme',
    repoKey: 'github://acme/acme',
  }
}

function cycleDeps() {
  const injected: any[] = []
  const proofHooks = {
    guard: async () => {
      rec.proofHooks++
      return { kind: 'pass_through' as const }
    },
    render: () => {
      rec.proofHooks++
      return 'x'
    },
    observeInject: async () => {
      rec.proofHooks++
    },
    abort: async () => {
      rec.proofHooks++
    },
  }
  const deps: import('../src/orchestrator/macro-cycle.ts').MacroCycleDeps = {
    getLatestAssistantReply: async () => null,
    appendRunLog: (async (e: any) => ({ id: 'rl', ...e, created_at: '' })) as any,
    inject: (async (i: any) => {
      injected.push(i)
      return { kind: 'dispatched' as const }
    }) as any,
    fanOut: (async () => ({ delivered: [] })) as any,
    isRunLive: () => false,
    refreshCapGauges: (async () => {}) as any,
    getCapStatuses: (async () => ({ costStatus: null, tokenStatus: null })) as any,
    proof: proofHooks,
  }
  return { deps, injected }
}

const norm = (i: any) => ({ ...i, token: String(i.token).replace(/\d+$/, '<ts>') })

describe('flag stack predicate (parity with the controller predicates)', () => {
  test('only all-on is true; every other combination is false', () => {
    for (const c of COMBOS) {
      applyCombo(c)
      expect(types.isProofEnabled()).toBe(FLAGS.every((k) => c[k]))
    }
    expect(OFF_COMBOS).toHaveLength(7)
  })

  test('accepted spellings match the controller predicates; garbage and unset are off', () => {
    const accepted = ['1', 'true', 'TRUE', 'Yes', 'on', 'ON', '  on  ', ' 1 ']
    const rejected = ['', '0', 'false', 'off', 'no', 'enabled', '2', 'truee', 'y']
    for (const v of [...accepted, ...rejected]) {
      process.env.REMO_ORCHESTRATOR_ENABLED = v
      process.env.REMO_ORCHESTRATOR_AUTOSPAWN = v
      process.env.REMO_ORCHESTRATOR_PROOF = v
      const expected = accepted.includes(v)
      expect(controller.isOrchestratorEnabled()).toBe(expected)
      expect(controller.isAutospawnEnabled()).toBe(expected)
      expect(types.isProofFlagOn()).toBe(expected)
      expect(types.isProofEnabled()).toBe(expected)
    }
    for (const k of FLAGS) delete process.env[k]
    expect(types.isProofEnabled()).toBe(false)
  })
})

describe('differential: flag OFF == today (7 OFF combinations)', () => {
  test('baseline: injected args equal the independently rendered dev macro', async () => {
    const { deps, injected } = cycleDeps()
    const r = await macro.runMacroCycle(input(), deps)
    const expected = tasks.renderMacro('dev', {
      repo_path: '/srv/repos/acme',
      repo_ident: 'github://acme/acme',
      lifecycle_stage: 'development',
    }).prompt
    expect(r.injected).toBe(true)
    expect(r.proofDecision).toBeUndefined()
    expect(injected).toHaveLength(1)
    expect(norm(injected[0])).toEqual({
      userId: 'u1',
      sessionId: 's1',
      token: 'orch:s1:macro:dev:<ts>',
      prompt: expected,
      autospawn: { isBuild: true, repoIdent: 'github://acme/acme', tz: undefined },
      taskId: 't1',
    })
  })

  for (const combo of OFF_COMBOS) {
    test(`runMacroCycle [${label(combo)}]: zero sql, zero fetch, no proof code, identical inject args`, async () => {
      // baseline captured with every flag unset (the proof code paths are unreachable)
      const base = cycleDeps()
      const baseRes = await macro.runMacroCycle(input(), base.deps)

      applyCombo(combo)
      const { deps, injected } = cycleDeps()
      const r = await macro.runMacroCycle(input(), deps)

      expect(r).toEqual(baseRes)
      expect(r.proofDecision).toBeUndefined()
      expect(injected).toHaveLength(1)
      expect(norm(injected[0])).toEqual(norm(base.injected[0]))
      expect(rec.proofHooks).toBe(0) // deps.proof never called
      expect(rec.sql).toBe(0)
      expect(rec.fetch).toBe(0)
      expect(rec.guardLoads).toBe(0)
      expect(rec.verifier).toBe(0)
      expect(rec.github).toBe(0)
    })

    test(`runMacroCycle without injected proof hooks [${label(combo)}]: the real guard module is never loaded`, async () => {
      applyCombo(combo)
      const { deps, injected } = cycleDeps()
      delete (deps as any).proof
      const r = await macro.runMacroCycle(input(), deps)
      expect(r.injected).toBe(true)
      expect(r.proofDecision).toBeUndefined()
      expect(injected).toHaveLength(1)
      expect(rec.guardLoads).toBe(0)
      expect(rec.verifier).toBe(0)
      expect(rec.github).toBe(0)
      expect(rec.sql).toBe(0)
      expect(rec.fetch).toBe(0)
    })

    test(`gates pass through with zero dep calls [${label(combo)}]`, async () => {
      applyCombo(combo)
      const calls = { n: 0 }
      const tripwire: any = new Proxy(
        {},
        {
          get(_t, p) {
            calls.n++
            throw new Error(`gate dep ${String(p)} touched while OFF`)
          },
        },
      )
      const req = { userId: 'u1', sessionId: 's1', token: 't', prompt: 'p', counterKey: 'task:t1' }
      // injected-deps variants (a tripwire deps object) and the real default instances
      expect(await gates.makeProofBudgetGate(tripwire).check(req)).toEqual({ ok: true })
      expect(await gates.makeProofProtectionGate(tripwire).check(req)).toEqual({ ok: true })
      expect(await gates.proofBudgetGate.check(req)).toEqual({ ok: true })
      expect(await gates.proofProtectionGate.check(req)).toEqual({ ok: true })
      expect(calls.n).toBe(0)
      expect(rec.sql).toBe(0)
      expect(rec.fetch).toBe(0)
      expect(rec.github).toBe(0)
    })

    test(`merge routing unchanged [${label(combo)}]: no proof lookup, dispatched`, async () => {
      applyCombo(combo)
      const ctx = { sessionId: 's1', userId: 'u1', repoKey: 'github://acme/proof', scheduleRule: null, tz: 'UTC' }
      const injected: any[] = []
      const lookups: string[] = []
      const deps: import('../src/orchestrator/merge-command.ts').MergeDeps = {
        now: () => new Date('2026-10-13T03:00:00Z'),
        recentRunLog: async () =>
          [{ session_id: 's1', command: 'execute', pr_url: 'https://gh/pr/1', reviewer_verdict: 'PASS', repo_key: ctx.repoKey }] as any,
        listUnconsumedApprovals: async () => [],
        markApprovalConsumed: async () => null as any,
        injectOrchestratorPrompt: async (i: any) => {
          injected.push(i)
          return { kind: 'dispatched' } as any
        },
        notifyChatSurface: async () => {},
        appendRunLog: async (e: any) => e,
        findActiveProofRunForRepo: async (r: string) => {
          lookups.push(r)
          return { id: 'r1', status: 'running' } as any
        },
      }
      const out = await merge.runMergeToMain(ctx, deps)
      expect(out.kind).toBe('dispatched')
      expect(injected).toHaveLength(1)
      expect(lookups).toEqual([])
      expect(rec.sql).toBe(0)
      expect(rec.fetch).toBe(0)
    })

    test(`merge without a lookup dep [${label(combo)}]: the proof DAL is never reached`, async () => {
      applyCombo(combo)
      const ctx = { sessionId: 's1', userId: 'u1', repoKey: 'github://acme/proof', scheduleRule: null, tz: 'UTC' }
      const deps: import('../src/orchestrator/merge-command.ts').MergeDeps = {
        now: () => new Date('2026-10-13T03:00:00Z'),
        recentRunLog: async () =>
          [{ session_id: 's1', command: 'execute', pr_url: 'https://gh/pr/1', reviewer_verdict: 'PASS', repo_key: ctx.repoKey }] as any,
        listUnconsumedApprovals: async () => [],
        markApprovalConsumed: async () => null as any,
        injectOrchestratorPrompt: async () => ({ kind: 'dispatched' }) as any,
        notifyChatSurface: async () => {},
        appendRunLog: async (e: any) => e,
      }
      const out = await merge.runMergeToMain(ctx, deps)
      expect(out.kind).toBe('dispatched')
      expect(rec.sql).toBe(0)
      expect(rec.fetch).toBe(0)
    })
  }

  test('sanity: the sql trap really records (all-on merge without a lookup dep reaches the DAL and fails closed)', async () => {
    applyCombo(COMBOS[7])
    const ctx = { sessionId: 's1', userId: 'u1', repoKey: 'github://acme/proof', scheduleRule: null, tz: 'UTC' }
    const deps: import('../src/orchestrator/merge-command.ts').MergeDeps = {
      now: () => new Date('2026-10-13T03:00:00Z'),
      recentRunLog: async () =>
        [{ session_id: 's1', command: 'execute', pr_url: 'https://gh/pr/1', reviewer_verdict: 'PASS', repo_key: ctx.repoKey }] as any,
      listUnconsumedApprovals: async () => [],
      markApprovalConsumed: async () => null as any,
      injectOrchestratorPrompt: async () => ({ kind: 'dispatched' }) as any,
      notifyChatSurface: async () => {},
      appendRunLog: async (e: any) => e,
    }
    const out = await merge.runMergeToMain(ctx, deps)
    expect(out.kind).toBe('refused')
    expect(rec.sql).toBeGreaterThan(0)
  })
})
