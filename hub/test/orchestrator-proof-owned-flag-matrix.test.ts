/**
 * PTYCAP-05 QC round 1 (adversary MINOR 2): a task that owns a proof row must NEVER render or
 * inject the dev macro under ANY flag combination. With the full stack ON the proof guard decides;
 * under every other combination of {REMO_ORCHESTRATOR_PROOF, REMO_ORCHESTRATOR_ENABLED,
 * REMO_ORCHESTRATOR_AUTOSPAWN} the cycle refuses (proofDecision 'blocked') - with zero db work,
 * because the marker rides the already-loaded task row. Non-proof tasks are untouched.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { runMacroCycle, type MacroCycleDeps, type MacroCycleInput } from '../src/orchestrator/macro-cycle.ts'
import { resolveCycleContext } from '../src/orchestrator/controller.ts'
import type { ProofCycleHooks } from '../src/orchestrator/proof-types.ts'

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

const combos = Array.from({ length: 8 }, (_, i) => FLAGS.map((_f, b) => Boolean(i & (1 << b))))
const setCombo = (c: boolean[]) => FLAGS.forEach((k, i) => (c[i] ? (process.env[k] = '1') : delete process.env[k]))
const label = (c: boolean[]) => FLAGS.map((k, i) => `${k.replace('REMO_ORCHESTRATOR_', '')}=${c[i] ? 1 : 0}`).join(' ')
const allOn = (c: boolean[]) => c.every(Boolean)

function input(over: Partial<MacroCycleInput> = {}): MacroCycleInput {
  return {
    userId: 'u1', sessionId: 's1', taskId: 'T1', macroTaskType: 'dev', stage: 'development',
    repoPath: '/srv/proof', repoIdent: 'github://acme/proof', repoKey: 'github://acme/proof', ...over,
  }
}

function harness() {
  const rec = { injects: [] as any[], replies: 0, runLogs: 0 }
  const deps: MacroCycleDeps = {
    getLatestAssistantReply: async () => (rec.replies++, null),
    appendRunLog: (async () => (rec.runLogs++, {})) as any,
    inject: (async (i: any) => (rec.injects.push(i), { kind: 'dispatched' as const })) as any,
    fanOut: (async () => ({})) as any,
    isRunLive: () => false,
    getCapStatuses: async () => ({ costStatus: { over: false } as any, tokenStatus: { over: false } as any }),
    refreshCapGauges: (async () => undefined) as any,
    evaluateCapAlert: (async () => undefined) as any,
  }
  return { deps, rec }
}

const blockingHooks = (): ProofCycleHooks => ({
  guard: async () => ({ kind: 'blocked', reason: 'proof_task_without_active_run' }),
  render: () => 'PROOF PROMPT',
  observeInject: async () => undefined,
  abort: async () => undefined,
})

describe('a proof-owned task never gets the dev macro under any flag combination', () => {
  for (const c of combos) {
    test(`proofOwned [${label(c)}]: no inject, blocked${allOn(c) ? ' by the guard' : ' before any reconcile or db work'}`, async () => {
      setCombo(c)
      const h = harness()
      const r = await runMacroCycle(input({ proofOwned: true }), { ...h.deps, proof: blockingHooks() })
      expect(h.rec.injects).toHaveLength(0)
      expect(r.injected).toBe(false)
      expect(r.proofDecision).toBe('blocked')
      if (!allOn(c)) {
        expect(h.rec.replies).toBe(0) // not even the reconcile read ran
        expect(h.rec.runLogs).toBe(0)
      }
    })
  }

  test('full stack ON + a claimed run: the PROOF prompt is injected, never the dev macro', async () => {
    setCombo([true, true, true])
    const h = harness()
    const hooks: ProofCycleHooks = {
      guard: async () => ({ kind: 'proceed', run: { id: 'run-1' } as any }),
      render: () => 'PROOF PROMPT',
      observeInject: async () => undefined,
      abort: async () => undefined,
    }
    await runMacroCycle(input({ proofOwned: true }), { ...h.deps, proof: hooks })
    expect(h.rec.injects).toHaveLength(1)
    expect(h.rec.injects[0].prompt).toBe('PROOF PROMPT')
    expect(h.rec.injects[0].proofRunId).toBe('run-1')
  })

  test('control: a task that is NOT proof-owned is untouched by the marker under every combination', async () => {
    for (const c of combos) {
      setCombo(c)
      const h = harness()
      // flag stack ON would route through the guard; supply a pass_through hook so only the marker is under test
      const hooks: ProofCycleHooks = { guard: async () => ({ kind: 'pass_through' }), render: () => 'x', observeInject: async () => undefined, abort: async () => undefined }
      const r = await runMacroCycle(input(), { ...h.deps, proof: hooks })
      expect(r.proofDecision === 'blocked').toBe(false)
      expect(h.rec.injects).toHaveLength(1)
      expect(h.rec.injects[0].prompt).toContain('GSD')
    }
  })
})

describe('the marker rides the already-loaded task row', () => {
  const session = { user_id: 'u1', repo_key: 'github://acme/proof', project_dir: '/srv/proof' }
  const mk = (proof_owned: boolean | undefined): any => ({
    getSessionById: async () => session,
    getOrchestratorTaskForSession: async () => ({ id: 'T1', lifecycle_stage: 'development', lifecycle_stage_explicit: true, macro_task_type: 'dev', proof_owned }),
    buildControllerContext: async () => ({ stage: 'development' }),
    detectLifecycleStage: async () => 'development',
  })

  test('resolveCycleContext surfaces proof_owned as proofOwned (absent = false)', async () => {
    expect((await resolveCycleContext('s1', mk(true)))?.proofOwned).toBe(true)
    expect((await resolveCycleContext('s1', mk(undefined)))?.proofOwned).toBe(false)
    expect((await resolveCycleContext('s1', mk(false)))?.proofOwned).toBe(false)
  })
})
