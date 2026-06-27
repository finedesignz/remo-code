/**
 * Milestone BSA — Phase BSA-02: inject launch seam.
 *
 * Drives `injectOrchestratorPrompt`'s offline branch through fully-injected deps
 * (no DB / no WS) to prove:
 *   - OFF / empty-allowlist / non-build ⇒ STRICT no-op (`no_session`, NO launch).
 *   - the full AND-chain, gate by gate, maps to the right typed refusal.
 *   - chain satisfied ⇒ launch fires, prompt parked in grace, `autospawn_launched`.
 *   - the daily TOKEN gate is in the ONLINE dispatch gate list ALONGSIDE the cost cap.
 *
 * Reqs: BSA-02, BSA-04 (token gate wiring), BSA-05 (no-op proof).
 */
import { describe, test, expect, afterEach } from 'bun:test'
import {
  injectOrchestratorPrompt,
  type InjectDeps,
  type InjectInput,
} from '../src/orchestrator/inject.ts'

afterEach(() => {
  delete process.env.REMO_ORCHESTRATOR_ENABLED
  delete process.env.REMO_ORCHESTRATOR_AUTOSPAWN
})

type Calls = {
  launched: number
  dispatched: Array<{ gates: string[] }>
  runLogs: string[]
}

function makeDeps(over: Partial<InjectDeps>, calls: Calls): InjectDeps {
  return {
    // Offline session: no channel.
    getChannel: () => null,
    // Default: both gates ON (tests flip via process.env through the real fns OR
    // override here). We override the predicates directly for determinism.
    isOrchestratorEnabled: () => true,
    isAutospawnEnabled: () => true,
    // Shadow OFF by default — these cases exercise the REAL spawn path (OBSRV-04).
    isAutospawnShadowEnabled: () => false,
    isRepoAutospawnAllowed: async () => true,
    getTokenCapStatus: async () => ({ over: false, tokens: 0, cap: 50_000_000 }),
    countAutospawnLaunchesToday: async () => 0,
    supervisorOnlineForUser: async () => true,
    graceParkPending: () => false,
    appendRunLog: (async (e: any) => {
      calls.runLogs.push(e.command)
      return {} as any
    }) as any,
    launchSessionForUser: (async () => {
      calls.launched++
      return { ok: true, runId: 'run-1', supervisorId: 'sup-1', hostname: 'h', repoPath: '/srv/demo' }
    }) as any,
    dispatch: (async (_req: any, deps: any) => {
      calls.dispatched.push({ gates: (deps.gates ?? []).map((g: any) => g.name) })
      // Simulate offline → pipeline parks in grace.
      return { kind: 'parked_offline' as const }
    }) as any,
    ...over,
  }
}

function input(over: Partial<InjectInput> = {}): InjectInput {
  return {
    userId: 'u1',
    sessionId: 's1',
    token: 'orch:s1:macro:dev:1',
    prompt: 'do the build',
    autospawn: { isBuild: true, repoIdent: 'github://finedesignz/demo' },
    ...over,
  }
}

describe('BSA-02 autospawn inject seam', () => {
  test('NO-OP: no autospawn context ⇒ no_session, no launch', async () => {
    const calls: Calls = { launched: 0, dispatched: [], runLogs: [] }
    const deps = makeDeps({}, calls)
    const out = await injectOrchestratorPrompt(input({ autospawn: undefined }), deps)
    expect(out.kind).toBe('no_session')
    expect(calls.launched).toBe(0)
    expect(calls.dispatched.length).toBe(0)
  })

  test('NO-OP: autospawn DISABLED (env OFF) ⇒ no_session, no launch', async () => {
    const calls: Calls = { launched: 0, dispatched: [], runLogs: [] }
    const deps = makeDeps({ isAutospawnEnabled: () => false }, calls)
    const out = await injectOrchestratorPrompt(input(), deps)
    expect(out.kind).toBe('no_session')
    expect(calls.launched).toBe(0)
  })

  test('NO-OP: orchestrator DISABLED ⇒ no_session, no launch', async () => {
    const calls: Calls = { launched: 0, dispatched: [], runLogs: [] }
    const deps = makeDeps({ isOrchestratorEnabled: () => false }, calls)
    const out = await injectOrchestratorPrompt(input(), deps)
    expect(out.kind).toBe('no_session')
    expect(calls.launched).toBe(0)
  })

  test('NO-OP: non-build macro (isBuild=false) ⇒ no_session, no launch', async () => {
    const calls: Calls = { launched: 0, dispatched: [], runLogs: [] }
    const deps = makeDeps({}, calls)
    const out = await injectOrchestratorPrompt(
      input({ autospawn: { isBuild: false, repoIdent: 'github://finedesignz/demo' } }),
      deps,
    )
    expect(out.kind).toBe('no_session')
    expect(calls.launched).toBe(0)
  })

  test('REFUSE: empty allowlist ⇒ refused:not_allowlisted, no launch', async () => {
    const calls: Calls = { launched: 0, dispatched: [], runLogs: [] }
    const deps = makeDeps({ isRepoAutospawnAllowed: async () => false }, calls)
    const out = await injectOrchestratorPrompt(input(), deps)
    expect(out).toEqual({ kind: 'refused', reason: 'not_allowlisted' })
    expect(calls.launched).toBe(0)
  })

  test('REFUSE: supervisor offline ⇒ refused:supervisor_offline, no launch', async () => {
    const calls: Calls = { launched: 0, dispatched: [], runLogs: [] }
    const deps = makeDeps({ supervisorOnlineForUser: async () => false }, calls)
    const out = await injectOrchestratorPrompt(input(), deps)
    expect(out).toEqual({ kind: 'refused', reason: 'supervisor_offline' })
    expect(calls.launched).toBe(0)
  })

  test('REFUSE: over token cap ⇒ refused:over_token_cap, no launch', async () => {
    const calls: Calls = { launched: 0, dispatched: [], runLogs: [] }
    const deps = makeDeps(
      { getTokenCapStatus: async () => ({ over: true, tokens: 99, cap: 50 }) },
      calls,
    )
    const out = await injectOrchestratorPrompt(input(), deps)
    expect(out).toEqual({ kind: 'refused', reason: 'over_token_cap' })
    expect(calls.launched).toBe(0)
  })

  test('REFUSE: over per-day launch cap ⇒ refused:launch_cap, no launch', async () => {
    const calls: Calls = { launched: 0, dispatched: [], runLogs: [] }
    // Default cap is 20; report 20 launched today ⇒ over.
    const deps = makeDeps({ countAutospawnLaunchesToday: async () => 20 }, calls)
    const out = await injectOrchestratorPrompt(input(), deps)
    expect(out).toEqual({ kind: 'refused', reason: 'launch_cap' })
    expect(calls.launched).toBe(0)
  })

  test('LAUNCH: full chain satisfied ⇒ spawns, parks, autospawn_launched + ledger row', async () => {
    const calls: Calls = { launched: 0, dispatched: [], runLogs: [] }
    const deps = makeDeps({}, calls)
    const out = await injectOrchestratorPrompt(input(), deps)
    expect(out.kind).toBe('autospawn_launched')
    expect(calls.launched).toBe(1)
    expect(calls.dispatched.length).toBe(1)
    // BSA-04: the daily TOKEN gate is in the dispatch gate list ALONGSIDE the cost cap.
    expect(calls.dispatched[0].gates).toContain('daily_cost_cap')
    expect(calls.dispatched[0].gates).toContain('daily_token_cap')
    // Ledger row written for the launch-count cap.
    expect(calls.runLogs).toContain('autospawn-launch')
  })

  test('DEDUP: a live grace entry ⇒ autospawn_parked, no duplicate launch', async () => {
    const calls: Calls = { launched: 0, dispatched: [], runLogs: [] }
    const deps = makeDeps({ graceParkPending: () => true }, calls)
    const out = await injectOrchestratorPrompt(input(), deps)
    expect(out.kind).toBe('autospawn_parked')
    expect(calls.launched).toBe(0)
  })

  test('ONLINE path: token gate present alongside cost gate', async () => {
    const calls: Calls = { launched: 0, dispatched: [], runLogs: [] }
    // Online session: getChannel returns a truthy channel ⇒ direct dispatch.
    const deps = makeDeps(
      {
        getChannel: (() => ({ ws: { send() {} } })) as any,
        dispatch: (async (_req: any, d: any) => {
          calls.dispatched.push({ gates: (d.gates ?? []).map((g: any) => g.name) })
          return { kind: 'dispatched' as const }
        }) as any,
      },
      calls,
    )
    const out = await injectOrchestratorPrompt(input(), deps)
    expect(out.kind).toBe('dispatched')
    expect(calls.launched).toBe(0)
    expect(calls.dispatched[0].gates).toContain('daily_cost_cap')
    expect(calls.dispatched[0].gates).toContain('daily_token_cap')
  })
})
