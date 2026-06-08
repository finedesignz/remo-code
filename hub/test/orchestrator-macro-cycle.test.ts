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
