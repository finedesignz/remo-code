/**
 * Phase 25 (auto-dev-orchestrator) — gsd-command execution seam.
 *
 *   1. command-prompt registry — each default row → correct gsd skill invocation +
 *      the finish→PR→reviewer→<<UNIT>> envelope; micro-prompt wrapping; propose-only
 *      commands (ship/complete-milestone/tag) are NOT executable here.
 *   2. live executeCommand seam — composes the prompt + injects via a SPY dispatch
 *      pipeline; asserts the injected content + that the gate list contains
 *      dailyCostCapGate (cost cap non-bypassable); cost-cap refusal path; no-session.
 *   3. flag-OFF dormancy (registerCycleRunnerIfEnabled returns false, no runner set).
 *
 * Reqs: R-ADO-13 (finish→PR→reviewer per unit; no merge-to-main). Decision D6/D10.
 *
 * appendRunLog is mock.module'd to a no-op spy (Bun mock.module is process-global —
 * restored in afterAll per the bun-mock-pollution hygiene note).
 */
import { describe, test, expect, afterAll, mock } from 'bun:test'
import {
  composeCommandPrompt,
  isExecutableCommand,
  isGapScanCommand,
  PROPOSE_ONLY_COMMANDS,
  MICRO_PROMPT_COMMAND,
} from '../src/orchestrator/command-prompts.ts'
import { DIMENSION_AGENTS } from '../src/orchestrator/gap-rotation.ts'
import { thresholdGate, dailyCostCapGate } from '../src/dispatch/gates.ts'
import type { InjectDeps } from '../src/orchestrator/inject.ts'

// no-DB run-log spy (the seam writes a run-log row via the wave runner)
mock.module('../src/orchestrator/run-log.ts', () => ({
  appendRunLog: async (entry: any) => ({ id: 'fake', created_at: new Date().toISOString(), ...entry }),
  recentRunLog: async () => [],
}))
const { makeLiveSeams } = await import('../src/orchestrator/wave-runner.ts')

afterAll(() => {
  mock.restore()
})

// ── 1. command-prompt registry ────────────────────────────────────────────────

describe('composeCommandPrompt — default rows', () => {
  const cases: Array<[string, string]> = [
    ['gsd-plan-phase', 'gsd-plan-phase'],
    ['gsd-execute-phase', 'gsd-execute-phase'],
    ['gsd-audit-fix', 'gsd-audit-fix'],
    ['gsd-code-review', 'gsd-code-review'],
    ['gsd-verify-work', 'gsd-verify-work'],
    ['gap-scan', 'gsd-review'],
  ]
  for (const [command, skill] of cases) {
    test(`${command} → runs the ${skill} skill + envelope`, () => {
      const c = composeCommandPrompt({ command })
      expect(c).not.toBeNull()
      expect(c!.skill).toBe(skill)
      expect(c!.prompt).toContain(`\`${skill}\``)
      // R-ADO-13 envelope present
      expect(c!.prompt).toContain('gh pr create')
      expect(c!.prompt).toContain('reviewer subagent')
      expect(c!.prompt).toContain('Do NOT merge to main')
      expect(c!.prompt).toContain('<<UNIT')
      expect(c!.prompt).toContain(`command: ${command}`)
    })
  }

  test('short topology keys resolve to the same skills', () => {
    expect(composeCommandPrompt({ command: 'plan' })!.skill).toBe('gsd-plan-phase')
    expect(composeCommandPrompt({ command: 'execute' })!.skill).toBe('gsd-execute-phase')
    expect(composeCommandPrompt({ command: 'audit-fix' })!.skill).toBe('gsd-audit-fix')
  })
})

describe('composeCommandPrompt — propose-only + micro-prompt', () => {
  test('ship / complete-milestone / tag are NOT executable (propose-tier)', () => {
    for (const c of ['ship', 'gsd-ship', 'complete-milestone', 'gsd-complete-milestone', 'tag']) {
      expect(PROPOSE_ONLY_COMMANDS.has(c)).toBe(true)
      expect(composeCommandPrompt({ command: c })).toBeNull()
      expect(isExecutableCommand({ command: c })).toBe(false)
    }
  })

  test('micro-prompt row wraps the free text in the same envelope', () => {
    const c = composeCommandPrompt({ command: MICRO_PROMPT_COMMAND, microPrompt: 'bump deps and run lint' })
    expect(c).not.toBeNull()
    expect(c!.skill).toBeNull()
    expect(c!.prompt).toContain('bump deps and run lint')
    expect(c!.prompt).toContain('gh pr create')
    expect(c!.prompt).toContain('<<UNIT')
  })

  test('unknown command WITH micro-prompt is treated as micro-prompt', () => {
    const c = composeCommandPrompt({ command: 'my-custom-thing', microPrompt: 'do the thing' })
    expect(c).not.toBeNull()
    expect(c!.skill).toBeNull()
    expect(c!.prompt).toContain('do the thing')
  })

  test('unknown command with NO micro-prompt is a no-op (null)', () => {
    expect(composeCommandPrompt({ command: 'totally-unknown' })).toBeNull()
  })

  test('micro-prompt sentinel with empty text is a no-op (null)', () => {
    expect(composeCommandPrompt({ command: MICRO_PROMPT_COMMAND, microPrompt: '   ' })).toBeNull()
  })
})

// ── 1b. gap-scan rotation prompt (Phase 26) ───────────────────────────────────

describe('composeCommandPrompt — gap-scan rotation (R-ADO-17/18)', () => {
  test('isGapScanCommand recognises the rotation command', () => {
    expect(isGapScanCommand('gap-scan')).toBe(true)
    expect(isGapScanCommand('gsd-gap-scan')).toBe(true)
    expect(isGapScanCommand('gsd-code-review')).toBe(false)
  })

  test('gap-scan WITH a dimension embeds the dimension + mapped specialist + records it', () => {
    const c = composeCommandPrompt({ command: 'gap-scan', gapDimension: 'security' })
    expect(c).not.toBeNull()
    expect(c!.skill).toBe('gsd-review')
    expect(c!.gapDimension).toBe('security')
    // dimension + specialist agent named in the prompt
    expect(c!.prompt).toContain('security')
    expect(c!.prompt).toContain(DIMENSION_AGENTS['security']) // 'Security Engineer'
    // instructs the agent to record the dimension so the wheel advances
    expect(c!.prompt).toContain('gap_dimension: security')
    // envelope preserved
    expect(c!.prompt).toContain('gh pr create')
    expect(c!.prompt).toContain('<<UNIT')
  })

  test('each dimension maps to its specialist in the prompt', () => {
    for (const [dim, agent] of Object.entries(DIMENSION_AGENTS)) {
      const c = composeCommandPrompt({ command: 'gap-scan', gapDimension: dim })
      expect(c!.gapDimension).toBe(dim)
      expect(c!.prompt).toContain(agent)
      expect(c!.prompt).toContain(`gap_dimension: ${dim}`)
    }
  })

  test('gap-scan WITHOUT a dimension still composes (gapDimension null, no rotation line)', () => {
    const c = composeCommandPrompt({ command: 'gap-scan' })
    expect(c).not.toBeNull()
    expect(c!.gapDimension).toBeNull()
    expect(c!.prompt).not.toContain('ROTATING gap-scan')
  })

  test('an invalid dimension is ignored (gapDimension null)', () => {
    const c = composeCommandPrompt({ command: 'gap-scan', gapDimension: 'bogus' })
    expect(c!.gapDimension).toBeNull()
  })

  test('non-gap commands ignore gapDimension', () => {
    const c = composeCommandPrompt({ command: 'gsd-plan-phase', gapDimension: 'security' })
    expect(c!.gapDimension).toBeNull()
    expect(c!.prompt).not.toContain('ROTATING gap-scan')
  })
})

// ── 2. live executeCommand seam (spy dispatch pipeline) ───────────────────────

function spyInject(outcomeKind: string) {
  const calls: Array<{ req: any; gateNames: string[] }> = []
  const deps: InjectDeps = {
    getChannel: () => ({ ws: { send: () => {} } }) as any, // session "online"
    isSessionLive: async () => true, // live, non-ghost
    dispatch: (async (req: any, pdeps: any) => {
      calls.push({ req, gateNames: pdeps.gates.map((g: any) => g.name) })
      return { kind: outcomeKind, runId: req.token }
    }) as any,
  }
  return { deps, calls }
}

describe('makeLiveSeams.executeCommand — rides the dispatch pipeline', () => {
  test('injects the composed prompt and includes dailyCostCapGate (IR-1)', async () => {
    const { deps, calls } = spyInject('dispatched')
    const seams = makeLiveSeams(deps)
    const res = await seams.executeCommand(
      { command: 'gsd-plan-phase', propose: false, priority: 0, microPrompt: null },
      { sessionId: 'sess-1', repoKey: 'acme/site', userId: 'user-1' },
    )
    expect(res.outcome).toBe('dispatched')
    expect(calls.length).toBe(1)
    // composed prompt was injected
    expect(calls[0].req.prompt).toContain('`gsd-plan-phase`')
    expect(calls[0].req.sessionId).toBe('sess-1')
    expect(calls[0].req.userId).toBe('user-1')
    // cost cap non-bypassable: gate list must contain the daily cost cap gate
    expect(calls[0].gateNames).toContain(dailyCostCapGate.name)
    expect(calls[0].gateNames).toContain(thresholdGate.name)
  })

  test('cost-cap refusal → outcome refused_cost_cap, prompt still composed', async () => {
    const deps: InjectDeps = {
      getChannel: () => ({ ws: { send: () => {} } }) as any,
      isSessionLive: async () => true,
      dispatch: (async () => ({ kind: 'skipped', reason: 'over_daily_cost_cap:$10.42>=$10.00' })) as any,
    }
    const seams = makeLiveSeams(deps)
    const res = await seams.executeCommand(
      { command: 'gsd-execute-phase', propose: false, priority: 0, microPrompt: null },
      { sessionId: 'sess-1', repoKey: null, userId: 'user-1' },
    )
    expect(res.outcome).toBe('refused_cost_cap')
  })

  test('no agent socket → no_session, dispatch never called', async () => {
    let dispatched = false
    const deps: InjectDeps = {
      getChannel: () => undefined as any,
      isSessionLive: async () => false, // no channel ⇒ not live
      dispatch: (async () => {
        dispatched = true
        return { kind: 'dispatched', runId: 'x' }
      }) as any,
    }
    const seams = makeLiveSeams(deps)
    const res = await seams.executeCommand(
      { command: 'gsd-plan-phase', propose: false, priority: 0, microPrompt: null },
      { sessionId: 'sess-1', repoKey: null, userId: 'user-1' },
    )
    expect(res.outcome).toBe('no_session')
    expect(dispatched).toBe(false)
  })

  test('missing userId → skipped_no_user (cannot ride the pipeline)', async () => {
    const { deps } = spyInject('dispatched')
    const seams = makeLiveSeams(deps)
    const res = await seams.executeCommand(
      { command: 'gsd-plan-phase', propose: false, priority: 0, microPrompt: null },
      { sessionId: 'sess-1', repoKey: null, userId: null },
    )
    expect(res.outcome).toBe('skipped_no_user')
  })

  test('hub-side createPrForUnit / dispatchReviewer are no-ops (agent owns them)', async () => {
    const { deps } = spyInject('dispatched')
    const seams = makeLiveSeams(deps)
    expect(await seams.createPrForUnit({ command: 'gsd-plan-phase', propose: false, priority: 0 }, { sessionId: 's', repoKey: null })).toBeNull()
    expect(await seams.dispatchReviewer(null, { command: 'gsd-plan-phase', propose: false, priority: 0 }, { sessionId: 's', repoKey: null })).toBeNull()
  })

  test('gap-scan unit rotates a dimension (empty log → wheel head) + returns it', async () => {
    const { deps, calls } = spyInject('dispatched')
    const seams = makeLiveSeams(deps)
    const res = await seams.executeCommand(
      { command: 'gap-scan', propose: false, priority: 0, microPrompt: null },
      { sessionId: 'sess-gap', repoKey: 'acme/site', userId: 'user-1' },
    )
    // mocked recentRunLog → [] ⇒ LRU picks the wheel head 'security'
    expect(res.outcome).toBe('dispatched')
    expect(res.gapDimension).toBe('security')
    // dimension + specialist embedded in the injected prompt
    expect(calls[0].req.prompt).toContain('security')
    expect(calls[0].req.prompt).toContain('Security Engineer')
    expect(calls[0].req.prompt).toContain('gap_dimension: security')
  })

  test('micro-prompt unit injects the wrapped free text', async () => {
    const { deps, calls } = spyInject('dispatched')
    const seams = makeLiveSeams(deps)
    await seams.executeCommand(
      { command: MICRO_PROMPT_COMMAND, propose: false, priority: 0, microPrompt: 'rotate the API key' },
      { sessionId: 'sess-2', repoKey: null, userId: 'user-9' },
    )
    expect(calls[0].req.prompt).toContain('rotate the API key')
  })
})

// ── 3. flag-OFF dormancy ──────────────────────────────────────────────────────

describe('REMO_ORCHESTRATOR_ENABLED flag', () => {
  test('OFF (default) → registerCycleRunnerIfEnabled returns false (no injection)', async () => {
    const prev = process.env.REMO_ORCHESTRATOR_ENABLED
    delete process.env.REMO_ORCHESTRATOR_ENABLED
    const { registerCycleRunnerIfEnabled, isOrchestratorEnabled } = await import('../src/orchestrator/controller.ts')
    expect(isOrchestratorEnabled()).toBe(false)
    expect(registerCycleRunnerIfEnabled()).toBe(false)
    if (prev === undefined) delete process.env.REMO_ORCHESTRATOR_ENABLED
    else process.env.REMO_ORCHESTRATOR_ENABLED = prev
  })
})
