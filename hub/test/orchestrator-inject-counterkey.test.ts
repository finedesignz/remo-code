/**
 * PTYCAP-04-03 Task 1: orchestrator inject counter key, gate-list composition and
 * replay re-entry on BOTH the online and the autospawn path. DB-free: every dep is
 * injected (the resolver included), dispatch is a spy.
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

const EXPECTED_GATES = [
  'automation_kill_switch',
  'threshold',
  'daily_cost_cap',
  'daily_token_cap',
  'session_inject_rate',
  'lifetime_counter',
]

type Rec = {
  reqs: any[]
  deps: any[]
  resolverCalls: Array<{ userId: string; sessionId: string; taskId?: string }>
  launched: number
  rawSends: number
}

function mk(online: boolean, over: Partial<InjectDeps> = {}): { deps: InjectDeps; rec: Rec } {
  const rec: Rec = { reqs: [], deps: [], resolverCalls: [], launched: 0, rawSends: 0 }
  const deps: InjectDeps = {
    getChannel: (() => (online ? { ws: { send() { rec.rawSends++ } } } : null)) as any,
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
    dispatch: (async (req: any, d: any) => {
      rec.reqs.push(req)
      rec.deps.push(d)
      return online ? { kind: 'dispatched' as const } : { kind: 'parked_offline' as const }
    }) as any,
    ...over,
  }
  return { deps, rec }
}

function input(over: Partial<InjectInput> = {}): InjectInput {
  return {
    userId: 'u1',
    sessionId: 's1',
    token: 'orch:s1:macro:dev:1',
    prompt: 'p',
    autospawn: { isBuild: true, repoIdent: 'github://o/r' },
    ...over,
  }
}

describe('orchestrator inject counter key (D-01, F-5c)', () => {
  for (const online of [true, false]) {
    const path = online ? 'online' : 'autospawn'

    test(`${path}: taskId present -> task:<taskId>, resolver not consulted`, async () => {
      const { deps, rec } = mk(online)
      await injectOrchestratorPrompt(input({ taskId: 'T9' }), deps)
      expect(rec.reqs).toHaveLength(1)
      expect(rec.reqs[0].counterKey).toBe('task:T9')
      expect(rec.resolverCalls).toHaveLength(0)
    })

    test(`${path}: taskId absent -> resolver result used, resolver called exactly once`, async () => {
      const { deps, rec } = mk(online)
      await injectOrchestratorPrompt(input(), deps)
      expect(rec.reqs[0].counterKey).toBe('task:RESOLVED')
      expect(rec.resolverCalls).toHaveLength(1)
      expect(rec.resolverCalls[0]).toMatchObject({ userId: 'u1', sessionId: 's1' })
    })

    test(`${path}: resolver throws -> failed, dispatch never called, nothing launched`, async () => {
      const { deps, rec } = mk(online, {
        resolveCounterKey: (async () => {
          throw new Error('db down')
        }) as any,
      })
      const out = await injectOrchestratorPrompt(input(), deps)
      expect(out.kind).toBe('failed')
      expect((out as any).reason).toContain('counter_key_unresolved')
      expect(rec.reqs).toHaveLength(0)
      expect(rec.launched).toBe(0)
    })

    test(`${path}: gate list = kill switch first, lifetime counter last, original four between`, async () => {
      const { deps, rec } = mk(online)
      await injectOrchestratorPrompt(input({ taskId: 'T1' }), deps)
      const names = rec.deps[0].gates.map((g: any) => g.name)
      expect(names[0]).toBe('automation_kill_switch')
      expect(names[names.length - 1]).toBe('lifetime_counter')
      expect(names).toEqual(EXPECTED_GATES)
    })
  }
})

describe('autospawn replay re-enters dispatch (D-03, T-04-10)', () => {
  test('replay thunk calls deps.dispatch again with the SAME request and no raw send', async () => {
    const { deps, rec } = mk(false)
    await injectOrchestratorPrompt(input({ taskId: 'T1' }), deps)
    expect(rec.reqs).toHaveLength(1)
    const sendBefore = rec.rawSends
    // grace drain: invoke the parked thunk with the original request
    await rec.deps[0].replay(rec.reqs[0])
    expect(rec.reqs).toHaveLength(2)
    expect(rec.reqs[1].token).toBe(rec.reqs[0].token)
    expect(rec.reqs[1].counterKey).toBe(rec.reqs[0].counterKey)
    expect(rec.reqs[1].counterKey).toBe('task:T1')
    // the replay re-ran the SAME deploy deps (gate list + kill switch + reserve live in dispatch)
    expect(rec.deps[1]).toBe(rec.deps[0])
    expect(rec.rawSends).toBe(sendBefore)
  })

  test('a replay dispatch error is swallowed (logged), never thrown', async () => {
    let n = 0
    let captured: any
    let capturedReq: any
    const { deps } = mk(false, {
      dispatch: (async (req: any, d: any) => {
        n++
        if (n === 1) {
          captured = d
          capturedReq = req
          return { kind: 'parked_offline' as const }
        }
        throw new Error('replay boom')
      }) as any,
    })
    await injectOrchestratorPrompt(input({ taskId: 'T1' }), deps)
    await expect(captured.replay(capturedReq)).resolves.toBeUndefined()
    expect(n).toBe(2)
  })
})
