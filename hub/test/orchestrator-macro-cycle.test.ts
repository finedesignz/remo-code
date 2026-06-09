/**
 * Milestone TMAC — Phase TMAC-04: resume-heartbeat macro cycle.
 * DB-free: all IO behind injected MacroCycleDeps. Reqs: R-TMAC-04.
 */
import { describe, test, expect } from 'bun:test'
import {
  runMacroCycle,
  type MacroCycleInput,
  type MacroCycleDeps,
} from '../src/orchestrator/macro-cycle.ts'

function baseInput(over: Partial<MacroCycleInput> = {}): MacroCycleInput {
  return {
    userId: 'u1',
    sessionId: 's1',
    taskId: 't1',
    macroTaskType: 'dev',
    stage: 'development',
    repoPath: '/srv/repos/acme',
    repoIdent: 'github://acme/acme',
    repoKey: 'github://acme/acme',
    ...over,
  }
}

function spyDeps(over: Partial<MacroCycleDeps> = {}): {
  deps: MacroCycleDeps
  log: { injects: string[]; runLogs: any[]; notifies: any[] }
} {
  const log = { injects: [] as string[], runLogs: [] as any[], notifies: [] as any[] }
  const deps: MacroCycleDeps = {
    getLatestAssistantReply: async () => null,
    appendRunLog: (async (e: any) => {
      log.runLogs.push(e)
      return { id: 'rl', ...e, created_at: '' }
    }) as any,
    inject: (async (input: any) => {
      log.injects.push(input.prompt)
      return { kind: 'dispatched' as const }
    }) as any,
    fanOut: (async (input: any) => {
      log.notifies.push(input)
      return { delivered: [] }
    }) as any,
    isRunLive: () => false,
    ...over,
  }
  return { deps, log }
}

describe('runMacroCycle — resume (no prior reply)', () => {
  test('injects the DEV macro + writes a resume run-log row', async () => {
    const { deps, log } = spyDeps()
    const r = await runMacroCycle(baseInput(), deps)
    expect(r.injected).toBe(true)
    expect(r.halted).toBe(false)
    expect(log.injects).toHaveLength(1)
    expect(log.injects[0]).toContain('autonomous DEV routine')
    expect(log.injects[0]).toContain('/srv/repos/acme')
    expect(log.runLogs.some((e) => e.command === 'macro:dev')).toBe(true)
  })

  test('non-dispatched inject (no_session) → injected=false, no throw', async () => {
    const { deps } = spyDeps({
      inject: (async () => ({ kind: 'no_session' as const })) as any,
    })
    const r = await runMacroCycle(baseInput(), deps)
    expect(r.injected).toBe(false)
    expect(r.halted).toBe(false)
  })
})

describe('runMacroCycle — reconcile prior STATE', () => {
  test('STATE block → a state run-log row, then resumes', async () => {
    const reply = '<<STATE\nlifecycle: building\nphase: 2/6\ndeployed_live: no\nSTATE>>'
    const { deps, log } = spyDeps({ getLatestAssistantReply: async () => reply })
    const r = await runMacroCycle(baseInput(), deps)
    expect(r.reconciled).toBe(true)
    expect(r.sentinels!.state!.lifecycle).toBe('building')
    const stateRow = log.runLogs.find((e) => e.command === 'state')
    expect(stateRow).toBeTruthy()
    expect(stateRow.deploy_verify_result).toBe('no')
    expect(r.injected).toBe(true) // not halted → resumes
  })
})

describe('runMacroCycle — GATE halt by stage', () => {
  const gateReply = '<<GATE reason="destructive migration" detail="needs approval">>'

  test('development: gate does NOT halt (resolve-or-blocked); resumes; no page', async () => {
    const { deps, log } = spyDeps({ getLatestAssistantReply: async () => gateReply })
    const r = await runMacroCycle(baseInput({ stage: 'development' }), deps)
    expect(r.halted).toBe(false)
    expect(r.injected).toBe(true)
    expect(log.notifies).toHaveLength(0) // dev suppresses the page
  })

  test('beta: gate HALTs, no re-inject, fans out a blocking notify', async () => {
    const { deps, log } = spyDeps({ getLatestAssistantReply: async () => gateReply })
    const r = await runMacroCycle(baseInput({ stage: 'beta' }), deps)
    expect(r.halted).toBe(true)
    expect(r.injected).toBe(false)
    expect(log.injects).toHaveLength(0)
    expect(log.notifies.some((n) => n.event === 'gate' && n.level === 'blocking')).toBe(true)
  })

  test('production-maintenance: gate HALTs + fans out to all channels', async () => {
    const { deps, log } = spyDeps({ getLatestAssistantReply: async () => gateReply })
    const r = await runMacroCycle(baseInput({ stage: 'production-maintenance' }), deps)
    expect(r.halted).toBe(true)
    expect(r.injected).toBe(false)
    const gateNotify = log.notifies.find((n) => n.event === 'gate')
    expect(gateNotify.channels.sort()).toEqual(['email', 'inapp', 'push', 'telegram'])
  })
})

describe('runMacroCycle — NOTIFY reconcile', () => {
  test('info NOTIFY in beta fans out; dev info restricted to in-app', async () => {
    const reply = '<<STATE\nlifecycle: shipping\nSTATE>>\n<<NOTIFY level=info detail="shipped v1.0.0, live">>'
    const beta = spyDeps({ getLatestAssistantReply: async () => reply })
    await runMacroCycle(baseInput({ stage: 'beta' }), beta.deps)
    expect(beta.log.notifies.some((n) => n.event === 'info')).toBe(true)

    const dev = spyDeps({ getLatestAssistantReply: async () => reply })
    await runMacroCycle(baseInput({ stage: 'development' }), dev.deps)
    const info = dev.log.notifies.find((n) => n.event === 'info')
    expect(info.channels).toEqual(['inapp'])
  })
})

describe('runMacroCycle — GATE+NOTIFY pair fans out once (M1)', () => {
  // SPEC §4 STEP 5: a paused-on-gate turn emits BOTH blocks. They must page once.
  const pairReply =
    '<<GATE reason="destructive migration" detail="needs approval">>\n' +
    '<<NOTIFY level=blocking detail="paused on mandatory gate">>'

  test('beta: exactly one gate fan-out for the GATE+blocking-NOTIFY pair', async () => {
    const { deps, log } = spyDeps({ getLatestAssistantReply: async () => pairReply })
    const r = await runMacroCycle(baseInput({ stage: 'beta' }), deps)
    expect(r.halted).toBe(true)
    const gateNotifies = log.notifies.filter((n) => n.event === 'gate')
    expect(gateNotifies).toHaveLength(1)
  })
})

describe('runMacroCycle — brainstorming approval gate is stage-quiet (PR #273)', () => {
  // Brainstorming ALWAYS gates for human approval, but the NOTIFY loudness is
  // stage-conditional: development → in-app-only info (NO external page);
  // beta/prod → blocking all-channel page. The GATE itself is always present.
  const devReply =
    '<<GATE reason="approval" detail="proposed feature awaiting sign-off">>\n' +
    '<<NOTIFY level=info channel=in-app detail="proposed feature awaiting approval: X">>'
  const prodReply =
    '<<GATE reason="approval" detail="proposed feature awaiting sign-off">>\n' +
    '<<NOTIFY level=blocking channel=all detail="proposed feature awaiting approval: X">>'

  const EXTERNAL = ['telegram', 'email', 'push']
  const hasExternal = (notifies: any[]) =>
    notifies.some((n) => (n.channels ?? []).some((c: string) => EXTERNAL.includes(c)))

  test('development: GATE present AND fan-out is in-app only (no external page)', async () => {
    const { deps, log } = spyDeps({ getLatestAssistantReply: async () => devReply })
    const r = await runMacroCycle(baseInput({ macroTaskType: 'brainstorming', stage: 'development' }), deps)
    expect(r.sentinels!.gate).toBeTruthy() // the approval gate is always emitted
    // exactly the quiet in-app info notify; no external-channel fan-out.
    const fans = log.notifies
    expect(fans.length).toBeGreaterThan(0)
    expect(hasExternal(fans)).toBe(false)
    expect(fans.every((n) => (n.channels ?? []).every((c: string) => c === 'inapp'))).toBe(true)
  })

  test('beta / production-maintenance: GATE present AND external fan-out occurs', async () => {
    for (const stage of ['beta', 'production-maintenance'] as const) {
      const { deps, log } = spyDeps({ getLatestAssistantReply: async () => prodReply })
      const r = await runMacroCycle(baseInput({ macroTaskType: 'brainstorming', stage }), deps)
      expect(r.sentinels!.gate).toBeTruthy()
      expect(hasExternal(log.notifies)).toBe(true)
    }
  })
})

describe('runMacroCycle — skip when a run is live (M2)', () => {
  test('isRunLive=true → skips resume, no inject, logs skipped', async () => {
    const { deps, log } = spyDeps({ isRunLive: () => true })
    const r = await runMacroCycle(baseInput(), deps)
    expect(r.skipped).toBe(true)
    expect(r.injected).toBe(false)
    expect(log.injects).toHaveLength(0)
    expect(log.runLogs.some((e) => e.command === 'macro:dev' && e.outcome === 'skipped')).toBe(true)
  })
})

describe('runMacroCycle — F-12 stub macro guard', () => {
  // The complete=false stub path is exercised in its own file
  // (orchestrator-macro-stub.test.ts) because forcing a stub requires a
  // process-global mock.module of task-macros (feedback_bun_mock_pollution) that
  // would leak into the sibling tests here. This sibling just asserts the
  // happy path: a real complete macro injects and never trips the guard.
  test('complete macro (dev) does NOT set stubNotReady; injects normally', async () => {
    const { deps } = spyDeps()
    const r = await runMacroCycle(baseInput({ macroTaskType: 'dev' }), deps)
    expect(r.stubNotReady).toBe(false)
    expect(r.injected).toBe(true)
  })
})

describe('runMacroCycle — F-10 failure notify', () => {
  test('cost-cap refusal fires a failure notify (even in dev)', async () => {
    const { deps, log } = spyDeps({
      inject: (async () => ({ kind: 'refused_cost_cap' as const, reason: 'over_daily_cost_cap' })) as any,
    })
    const r = await runMacroCycle(baseInput({ stage: 'development' }), deps)
    expect(r.injected).toBe(false)
    expect(log.notifies.some((n) => n.event === 'failure')).toBe(true)
  })

  test('inject throw fires a failure notify', async () => {
    const { deps, log } = spyDeps({
      inject: (async () => {
        throw new Error('boom')
      }) as any,
    })
    await runMacroCycle(baseInput({ stage: 'development' }), deps)
    expect(log.notifies.some((n) => n.event === 'failure' && /boom/.test(n.detail))).toBe(true)
  })

  test('no_session does NOT fire a failure notify (benign offline)', async () => {
    const { deps, log } = spyDeps({
      inject: (async () => ({ kind: 'no_session' as const })) as any,
    })
    await runMacroCycle(baseInput({ stage: 'development' }), deps)
    expect(log.notifies.some((n) => n.event === 'failure')).toBe(false)
  })
})

describe('runMacroCycle — robustness', () => {
  test('a throwing inject is swallowed (cycle never wedges)', async () => {
    const { deps } = spyDeps({
      inject: (async () => {
        throw new Error('boom')
      }) as any,
    })
    const r = await runMacroCycle(baseInput(), deps)
    expect(r.injected).toBe(false)
    expect(r).toBeDefined()
  })
})
