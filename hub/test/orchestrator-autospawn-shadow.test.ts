/**
 * OBSRV-04: Autospawn Shadow Dry-Run Guard Test
 *
 * SHADOW-01: flag-gated; OFF by default and true no-op when off.
 * SHADOW-02: full AND-chain evaluated before shadow intercept.
 * SHADOW-03: launchSessionForUser NEVER called in shadow mode (hard constraint).
 * SHADOW-04: shadow record written to run-log with outcome 'shadow_would_spawn'.
 *
 * Fast mocked unit test — no DB, no real network.
 * All transitive DB/WS/dispatch module deps are stubbed via mock.module so that
 * the postgres package is never resolved. Exercises via injectOrchestratorPrompt
 * (public API) with getChannel=undefined (offline session) to reach maybeAutospawnOffline.
 */

import { describe, it, expect, afterEach, mock } from 'bun:test'

// ── Stub all transitive modules that touch postgres/network ───────────────────
// Must be called BEFORE the import of inject.ts (Bun hoists mock.module calls).
mock.module('../src/db/dal.ts', () => ({ insertMessage: async () => ({ id: 'm1' }) }))
mock.module('../src/db/supervisor-dal.ts', () => ({ listSupervisorsForUser: async () => [] }))
mock.module('../src/db/orchestrator-rows-dal.ts', () => ({
  isRepoAutospawnAllowed: async () => true,
  countAutospawnLaunchesToday: async () => 0,
  insertRoutineRunLog: async (e: any) => e,
  AUTOSPAWN_LAUNCH_COMMAND: 'autospawn-launch',
}))
mock.module('../src/ws/registry.ts', () => ({
  getChannel: () => undefined,
  broadcastToSubscribers: () => {},
}))
mock.module('../src/ws/supervisor-registry.ts', () => ({
  isSupervisorOnline: () => false,
}))
mock.module('../src/dispatch/pipeline.ts', () => ({
  dispatch: async () => ({ kind: 'parked_offline' }),
}))
mock.module('../src/dispatch/gates.ts', () => ({
  thresholdGate: async () => null,
  dailyCostCapGate: async () => null,
  dailyTokenCapGate: async () => null,
  isOverAutospawnDailyLaunchCap: () => false,
  getTokenCapStatus: async () => ({ over: false, used: 0, cap: 50_000_000 }),
}))
mock.module('../src/dispatch/grace.ts', () => ({
  getGraceBuffer: () => ({ _pendingCount: () => 0 }),
}))
mock.module('../src/telegram/launch.ts', () => ({
  launchSessionForUser: async () => ({ ok: false, reason: 'no_online_supervisor' }),
}))
mock.module('../src/orchestrator/run-log.ts', () => ({
  appendRunLog: async (e: any) => e,
}))

import { injectOrchestratorPrompt, type InjectDeps } from '../src/orchestrator/inject.ts'

// ── Helpers ───────────────────────────────────────────────────────────────────

function makePassingDeps(overrides: Partial<InjectDeps> = {}): InjectDeps & {
  launchCalls: string[]
  runLogRows: Array<{ command?: string; outcome?: string | null }>
} {
  const launchCalls: string[] = []
  const runLogRows: Array<{ command?: string; outcome?: string | null }> = []

  const base: InjectDeps = {
    dispatch: async () => ({ kind: 'parked_offline' as const }),
    // getChannel=undefined → offline → triggers maybeAutospawnOffline
    getChannel: () => undefined,
    isOrchestratorEnabled: () => true,
    isAutospawnEnabled: () => true,
    isAutospawnShadowEnabled: () => false,
    isRepoAutospawnAllowed: async () => true,
    getTokenCapStatus: async () => ({ over: false, used: 0, cap: 50_000_000 }),
    countAutospawnLaunchesToday: async () => 0,
    supervisorOnlineForUser: async () => true,
    launchSessionForUser: async ({ sessionId }: { userId: string; sessionId: string }) => {
      launchCalls.push(sessionId)
      return { ok: true, runId: 'run-1', supervisorId: 'sup-1' }
    },
    appendRunLog: async (entry) => {
      runLogRows.push({ command: entry.command, outcome: entry.outcome ?? null })
      return { id: 'log-1', created_at: new Date().toISOString(), ...entry } as any
    },
    graceParkPending: () => false,
    ...overrides,
  }

  return Object.assign(base, { launchCalls, runLogRows })
}

const BASE_INPUT = {
  userId: 'u1',
  sessionId: 's1',
  token: 'tok',
  prompt: 'build the thing',
  autospawn: { isBuild: true, repoIdent: 'github://owner/repo' },
} as const

// ── Tests ─────────────────────────────────────────────────────────────────────

afterEach(() => {
  delete process.env.REMO_ORCHESTRATOR_AUTOSPAWN_SHADOW
  delete process.env.REMO_ORCHESTRATOR_AUTOSPAWN
  delete process.env.REMO_ORCHESTRATOR_ENABLED
})

describe('OBSRV-04 autospawn shadow dry-run', () => {
  // SHADOW-01: true no-op when autospawn context absent
  it('SHADOW-01a: returns no_session when autospawn context absent', async () => {
    const deps = makePassingDeps()
    const result = await injectOrchestratorPrompt(
      { userId: 'u1', sessionId: 's1', token: 'tok', prompt: 'hello' },
      deps,
    )
    expect(result.kind).toBe('no_session')
    expect(deps.launchCalls).toHaveLength(0)
  })

  // SHADOW-01: shadow flag OFF → real launch proceeds
  it('SHADOW-01b: shadow flag OFF → real launch proceeds (not shadow-intercepted)', async () => {
    const deps = makePassingDeps({ isAutospawnShadowEnabled: () => false })
    const result = await injectOrchestratorPrompt(BASE_INPUT, deps)
    expect(result.kind).toBe('autospawn_launched')
    // positive-case: when shadow OFF, launch IS called
    expect(deps.launchCalls).toHaveLength(1)
    // no shadow row
    expect(deps.runLogRows.filter((r) => r.outcome === 'shadow_would_spawn')).toHaveLength(0)
  })

  // SHADOW-03 (HARD CONSTRAINT): launchSessionForUser NEVER called in shadow mode
  it('SHADOW-03: launchSessionForUser is NEVER called when shadow mode is ON', async () => {
    const deps = makePassingDeps({ isAutospawnShadowEnabled: () => true })
    const result = await injectOrchestratorPrompt(BASE_INPUT, deps)
    // HARD CONSTRAINT: zero launch calls
    expect(deps.launchCalls).toHaveLength(0)
    expect(result.kind).toBe('shadow_would_spawn')
  })

  // SHADOW-02: full AND-chain evaluated — allowlist gate refuses before shadow intercept
  it('SHADOW-02a: allowlist gate fires and refuses before shadow intercept', async () => {
    const deps = makePassingDeps({
      isAutospawnShadowEnabled: () => true,
      isRepoAutospawnAllowed: async () => false,
    })
    const result = await injectOrchestratorPrompt(BASE_INPUT, deps)
    expect(result.kind).toBe('refused')
    expect((result as any).reason).toBe('not_allowlisted')
    expect(deps.launchCalls).toHaveLength(0)
    // no shadow row — refused before intercept
    expect(deps.runLogRows.filter((r) => r.outcome === 'shadow_would_spawn')).toHaveLength(0)
  })

  // SHADOW-02: token cap gate fires before shadow intercept
  it('SHADOW-02b: token cap gate fires and refuses before shadow intercept', async () => {
    const deps = makePassingDeps({
      isAutospawnShadowEnabled: () => true,
      getTokenCapStatus: async () => ({ over: true, used: 60_000_000, cap: 50_000_000 }),
    })
    const result = await injectOrchestratorPrompt(BASE_INPUT, deps)
    expect(result.kind).toBe('refused')
    expect((result as any).reason).toBe('over_token_cap')
    expect(deps.launchCalls).toHaveLength(0)
  })

  // SHADOW-04: shadow record written to run-log with correct outcome
  it('SHADOW-04: run-log record written with outcome shadow_would_spawn and command autospawn-shadow', async () => {
    const deps = makePassingDeps({ isAutospawnShadowEnabled: () => true })
    await injectOrchestratorPrompt(BASE_INPUT, deps)
    const shadowRows = deps.runLogRows.filter((r) => r.outcome === 'shadow_would_spawn')
    expect(shadowRows).toHaveLength(1)
    expect(shadowRows[0].command).toBe('autospawn-shadow')
    // must NOT be the real AUTOSPAWN_LAUNCH_COMMAND (so not counted by cap)
    expect(shadowRows[0].command).not.toBe('autospawn-launch')
  })

  // SHADOW-01: orchestrator gate OFF → no-op before shadow intercept
  it('SHADOW-01c: orchestrator gate OFF short-circuits before shadow intercept', async () => {
    const deps = makePassingDeps({
      isOrchestratorEnabled: () => false,
      isAutospawnShadowEnabled: () => true,
    })
    const result = await injectOrchestratorPrompt(BASE_INPUT, deps)
    expect(result.kind).toBe('no_session')
    expect(deps.launchCalls).toHaveLength(0)
    expect(deps.runLogRows.filter((r) => r.outcome === 'shadow_would_spawn')).toHaveLength(0)
  })

  // SHADOW-01: autospawn gate OFF → no-op even with shadow=1
  it('SHADOW-01d: autospawn gate OFF short-circuits before shadow intercept', async () => {
    const deps = makePassingDeps({
      isAutospawnEnabled: () => false,
      isAutospawnShadowEnabled: () => true,
    })
    const result = await injectOrchestratorPrompt(BASE_INPUT, deps)
    expect(result.kind).toBe('no_session')
    expect(deps.launchCalls).toHaveLength(0)
    expect(deps.runLogRows.filter((r) => r.outcome === 'shadow_would_spawn')).toHaveLength(0)
  })
})
