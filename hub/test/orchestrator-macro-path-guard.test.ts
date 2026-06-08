/**
 * Milestone TMAC — Phase TMAC-06: macro-path retirement guard.
 *
 * Asserts the live cycle-runner routes through the resume-heartbeat MACRO path by
 * default (NOT the legacy per-micro-command-row wave engine), and that the legacy
 * modules are KEPT importable (retired from the live path, not deleted — removed
 * in a dedicated cleanup phase once migration is verified). A regression that
 * silently restores the micro-row path as the default fails here.
 *
 * Reqs: R-TMAC-06.
 */
import { describe, test, expect, afterEach } from 'bun:test'
import {
  makeCycleRunner,
  useMacroPath,
  type ResolveDeps,
  type ControllerContext,
} from '../src/orchestrator/controller.ts'
import type { WaveSeams, ExecuteResult } from '../src/orchestrator/wave-runner.ts'
import type { DueRow } from '../src/orchestrator/due-rows.ts'
import type { OrchestratorRow } from '../src/db/orchestrator-rows-dal.ts'

afterEach(() => {
  delete process.env.REMO_ORCHESTRATOR_LEGACY_WAVES
})

function row(command: string): OrchestratorRow {
  return {
    id: `row-${command}`,
    task_id: 'task-1',
    command,
    enabled: true,
    schedule_rule: null,
    frequency_label: 'Once',
    micro_prompt: null,
    sort_order: 0,
    created_at: '',
    updated_at: '',
  }
}

function ctxWithDue(dueRows: DueRow[]): ControllerContext {
  return {
    repo: 'finedesignz/demo',
    stage: 'development',
    runtimeContext: { repo: 'finedesignz/demo' } as any,
    runLog: [],
    dueRows,
  }
}

function resolveDeps(dueRows: DueRow[]): ResolveDeps {
  return {
    getSessionById: (async () => ({
      user_id: 'u1',
      repo_key: 'finedesignz/demo',
      project_dir: '/srv/demo',
    })) as any,
    getOrchestratorTaskForSession: (async () => ({
      id: 'task-1',
      lifecycle_stage: 'development',
      macro_task_type: 'dev',
      timezone: 'UTC',
    })) as any,
    buildControllerContext: (async () => ctxWithDue(dueRows)) as any,
  }
}

function spySeams(): { seams: WaveSeams; executed: string[] } {
  const executed: string[] = []
  const seams: WaveSeams = {
    async executeCommand(unit): Promise<ExecuteResult> {
      executed.push(unit.command)
      return { outcome: 'dispatched' }
    },
    async createPrForUnit() {
      return null
    },
    async dispatchReviewer() {
      return null
    },
    async proposeToChat() {},
  }
  return { seams, executed }
}

const entry = { id: 'q1', session_id: 's1', priority: 0, status: 'running', enqueued_at: '', started_at: null } as any

describe('macro-path retirement guard', () => {
  test('default: useMacroPath() is true (wave engine NOT the default)', () => {
    delete process.env.REMO_ORCHESTRATOR_LEGACY_WAVES
    expect(useMacroPath()).toBe(true)
  })

  test('default cycle-runner does NOT invoke the wave executeCommand seam', async () => {
    delete process.env.REMO_ORCHESTRATOR_LEGACY_WAVES
    const { seams, executed } = spySeams()
    // The macro path injects via injectOrchestratorPrompt (no agent socket online
    // here → no_session), and NEVER touches the wave seam.
    await makeCycleRunner(resolveDeps([row('gsd-plan-phase')]), seams)(entry)
    expect(executed).toEqual([])
  })

  test('rollback flag re-enables the legacy wave path (useMacroPath flips off)', () => {
    // Wave EXECUTION under the flag is covered end-to-end by
    // orchestrator-cycle-wiring.test.ts; here we assert only the selector flip so
    // this guard stays DB-free.
    process.env.REMO_ORCHESTRATOR_LEGACY_WAVES = '1'
    expect(useMacroPath()).toBe(false)
    process.env.REMO_ORCHESTRATOR_LEGACY_WAVES = 'true'
    expect(useMacroPath()).toBe(false)
    process.env.REMO_ORCHESTRATOR_LEGACY_WAVES = '0'
    expect(useMacroPath()).toBe(true)
  })

  test('legacy micro-row modules are KEPT importable (not deleted yet)', async () => {
    const cp = await import('../src/orchestrator/command-prompts.ts')
    const waves = await import('../src/orchestrator/waves.ts')
    const wr = await import('../src/orchestrator/wave-runner.ts')
    const dr = await import('../src/orchestrator/due-rows.ts')
    const gr = await import('../src/orchestrator/gap-rotation.ts')
    expect(typeof cp.composeCommandPrompt === 'function').toBe(true)
    expect(typeof cp.MICRO_PROMPT_COMMAND).toBe('string')
    expect(typeof waves.planWaves).toBe('function')
    expect(typeof wr.runWavePlan).toBe('function')
    expect(typeof dr.computeDueRowsForTask).toBe('function')
    expect(gr).toBeDefined()
  })
})
