/**
 * Phase 24 (auto-dev-orchestrator) — dependency-aware wave planner + runner.
 *
 * All always-on (no DB):
 *   1. planner topology — independent collapse (wave 0), plan→execute→ship
 *      sequence (3 waves), mixed sets, dedupe, merge-to-main excluded.
 *   2. priority intra-wave ordering (deploy-fix outranks build).
 *   3. runner per-unit lifecycle — finish→PR→reviewer→run-log IN ORDER (spy seams +
 *      mocked appendRunLog so no DB is touched).
 *   4. propose units (ship/complete-milestone/tag) route to proposeToChat, not
 *      execute/PR; unit-failure isolation; waves run sequentially.
 *   5. flag-OFF dormancy (registerCycleRunnerIfEnabled returns false, queue unset).
 *
 * Reqs: R-ADO-11 (wave grouping), R-ADO-12 (parallel modeled as allSettled),
 * R-ADO-13 (finish→PR→reviewer per unit; no merge-to-main here). Decision D2/D10.
 *
 * appendRunLog is mock.module'd to a no-op spy (Bun's mock.module is process
 * global — restored in afterAll to avoid sibling-test pollution, per the
 * feedback_bun_mock_pollution hygiene note).
 */
import { describe, test, expect, afterEach, afterAll, mock } from 'bun:test'
import type { WaveSeams } from '../src/orchestrator/wave-runner.ts'

// ── run-log append calls captured here (no DB) ────────────────────────────────
let runLogCalls: any[] = []
mock.module('../src/orchestrator/run-log.ts', () => ({
  appendRunLog: async (entry: any) => {
    runLogCalls.push(entry)
    return { id: 'fake', created_at: new Date().toISOString(), ...entry }
  },
  recentRunLog: async () => [],
}))

// Import AFTER the mock so wave-runner binds the mocked appendRunLog.
const { planWaves, COMMAND_DEPS, PROPOSE_COMMANDS, EXCLUDED_COMMANDS, commandPriority } =
  await import('../src/orchestrator/waves.ts')
const { runWavePlan, STUB_SEAMS } = await import('../src/orchestrator/wave-runner.ts')

afterEach(() => {
  runLogCalls = []
})
afterAll(() => {
  mock.restore()
})

// helper: flatten plan into [waveIndex, command][]
function layout(commands: string[]): Record<string, number> {
  const plan = planWaves(commands)
  const out: Record<string, number> = {}
  plan.waves.forEach((wave, i) => wave.forEach((u) => (out[u.command] = i)))
  return out
}

// ── 1. planner topology ───────────────────────────────────────────────────────

describe('planWaves — topology', () => {
  test('independent commands collapse into the earliest wave (wave 0)', () => {
    const plan = planWaves(['audit-fix', 'gap-scan', 'code-review'])
    expect(plan.waves.length).toBe(1)
    expect(plan.waves[0].map((u) => u.command).sort()).toEqual(
      ['audit-fix', 'code-review', 'gap-scan'],
    )
  })

  test('plan→execute→ship sequence is 3 ordered waves', () => {
    const l = layout(['ship', 'plan', 'execute']) // input order shuffled on purpose
    expect(l['plan']).toBe(0)
    expect(l['execute']).toBe(1)
    expect(l['ship']).toBe(2)
  })

  test('mixed: independents share wave 0 with the chain head', () => {
    const l = layout(['plan', 'execute', 'audit-fix', 'gap-scan'])
    expect(l['plan']).toBe(0)
    expect(l['audit-fix']).toBe(0)
    expect(l['gap-scan']).toBe(0)
    expect(l['execute']).toBe(1)
  })

  test('a dependent due WITHOUT its dep present runs in wave 0 (no phantom ordering)', () => {
    // ship due but execute NOT due this tick → ship has no in-set dep → wave 0.
    const l = layout(['ship'])
    expect(l['ship']).toBe(0)
  })

  test('merge-to-main is EXCLUDED (off-hours Phase 29)', () => {
    const plan = planWaves(['merge-to-main', 'audit-fix'])
    const all = plan.waves.flat().map((u) => u.command)
    expect(all).not.toContain('merge-to-main')
    expect(plan.dropped).toContain('merge-to-main')
    expect(all).toContain('audit-fix')
  })

  test('duplicate + empty commands are de-duped / dropped', () => {
    const plan = planWaves(['audit-fix', 'audit-fix', '', '  '])
    expect(plan.waves.flat().map((u) => u.command)).toEqual(['audit-fix'])
  })

  test('static dep map: plan→execute→ship, independents have no deps', () => {
    expect(COMMAND_DEPS['execute']).toEqual(['plan'])
    expect(COMMAND_DEPS['ship']).toEqual(['execute'])
    expect(COMMAND_DEPS['audit-fix']).toEqual([])
    expect(EXCLUDED_COMMANDS.has('merge-to-main')).toBe(true)
  })
})

// ── 2. priority intra-wave ordering ────────────────────────────────────────────

describe('planWaves — priority ordering', () => {
  test('deploy-fix outranks build within a wave', () => {
    expect(commandPriority('deploy-fix')).toBeGreaterThan(commandPriority('audit-fix'))
    const plan = planWaves(['audit-fix', 'deploy-fix', 'gap-scan'])
    // all independent → same wave; deploy-fix sorts first (priority DESC).
    expect(plan.waves[0][0].command).toBe('deploy-fix')
  })

  test('equal-priority units keep stable input order', () => {
    const plan = planWaves(['gap-scan', 'audit-fix', 'code-review'])
    expect(plan.waves[0].map((u) => u.command)).toEqual(['gap-scan', 'audit-fix', 'code-review'])
  })
})

// ── 3 + 4. runner lifecycle ─────────────────────────────────────────────────────

function spySeams(overrides: Partial<WaveSeams> = {}): { seams: WaveSeams; calls: string[] } {
  const calls: string[] = []
  const seams: WaveSeams = {
    async executeCommand(unit) {
      calls.push(`execute:${unit.command}`)
      return { outcome: 'success' }
    },
    async createPrForUnit(unit) {
      calls.push(`pr:${unit.command}`)
      return `https://github.com/x/y/pull/${unit.command}`
    },
    async dispatchReviewer(prUrl, unit) {
      calls.push(`review:${unit.command}`)
      return 'PASS'
    },
    async proposeToChat(unit) {
      calls.push(`propose:${unit.command}`)
    },
    ...overrides,
  }
  return { seams, calls }
}

describe('runWavePlan — per-unit lifecycle', () => {
  test('normal unit runs finish→PR→reviewer→run-log IN ORDER', async () => {
    const { seams, calls } = spySeams()
    const plan = planWaves(['execute'])
    const summary = await runWavePlan(plan, { sessionId: 's1', repoKey: 'r' }, seams)

    expect(calls).toEqual(['execute:execute', 'pr:execute', 'review:execute'])
    expect(runLogCalls.length).toBe(1)
    expect(runLogCalls[0]).toMatchObject({
      command: 'execute',
      outcome: 'success',
      pr_url: 'https://github.com/x/y/pull/execute',
      reviewer_verdict: 'PASS',
    })
    expect(summary).toMatchObject({ units: 1, succeeded: 1, failed: 0, proposed: 0 })
  })

  test('propose unit (ship) routes to proposeToChat — no execute/PR/review', async () => {
    const { seams, calls } = spySeams()
    const plan = planWaves(['ship'])
    const summary = await runWavePlan(plan, { sessionId: 's1', repoKey: null }, seams)

    expect(calls).toEqual(['propose:ship'])
    expect(calls.some((c) => c.startsWith('execute:'))).toBe(false)
    expect(calls.some((c) => c.startsWith('pr:'))).toBe(false)
    expect(runLogCalls[0]).toMatchObject({ command: 'ship', outcome: 'proposed', pr_url: null })
    expect(summary.proposed).toBe(1)
    expect(PROPOSE_COMMANDS.has('ship')).toBe(true)
  })

  test('unit failure is isolated — siblings still run + failed is logged', async () => {
    const { seams, calls } = spySeams({
      async executeCommand(unit) {
        calls.push(`execute:${unit.command}`)
        if (unit.command === 'audit-fix') throw new Error('boom')
        return { outcome: 'success' }
      },
    })
    // two independent units in wave 0
    const plan = planWaves(['audit-fix', 'gap-scan'])
    const summary = await runWavePlan(plan, { sessionId: 's1', repoKey: null }, seams)

    expect(summary.units).toBe(2)
    expect(summary.failed).toBe(1)
    expect(summary.succeeded).toBe(1)
    // both logged; failing one carries outcome=failed
    const af = runLogCalls.find((c) => c.command === 'audit-fix')
    const gs = runLogCalls.find((c) => c.command === 'gap-scan')
    expect(af.outcome).toBe('failed')
    expect(gs.outcome).toBe('success')
  })

  test('waves run sequentially: wave 1 starts only after wave 0 completes', async () => {
    const order: string[] = []
    const { seams } = spySeams({
      async executeCommand(unit) {
        order.push(`start:${unit.command}`)
        await new Promise((r) => setTimeout(r, 5))
        order.push(`end:${unit.command}`)
        return { outcome: 'success' }
      },
    })
    const plan = planWaves(['plan', 'execute']) // plan wave0, execute wave1
    await runWavePlan(plan, { sessionId: 's1', repoKey: null }, seams)
    // plan must fully end before execute starts
    expect(order.indexOf('end:plan')).toBeLessThan(order.indexOf('start:execute'))
  })

  test('STUB_SEAMS are inert (no PR url, skipped outcome) — prod default', async () => {
    const plan = planWaves(['execute'])
    const summary = await runWavePlan(plan, { sessionId: 's1', repoKey: null }, STUB_SEAMS)
    expect(summary.results[0].prUrl).toBeNull()
    expect(summary.results[0].outcome).toBe('skipped_phase25_stub')
  })
})

// ── 5. flag-OFF dormancy ────────────────────────────────────────────────────────

describe('orchestrator flag-OFF dormancy', () => {
  test('registerCycleRunnerIfEnabled returns false when flag unset (queue dormant)', async () => {
    const prev = process.env.REMO_ORCHESTRATOR_ENABLED
    delete process.env.REMO_ORCHESTRATOR_ENABLED
    const { registerCycleRunnerIfEnabled, isOrchestratorEnabled } = await import(
      '../src/orchestrator/controller.ts'
    )
    const queue = await import('../src/orchestrator/queue.ts')
    queue._resetForTests()
    expect(isOrchestratorEnabled()).toBe(false)
    expect(registerCycleRunnerIfEnabled()).toBe(false)
    // queue claims nothing with no runner registered
    expect(await queue.drainOnce()).toEqual([])
    if (prev !== undefined) process.env.REMO_ORCHESTRATOR_ENABLED = prev
  })
})
