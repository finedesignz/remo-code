/**
 * Macro-path guard (CONCERNS item 5 — legacy-wave rollback path DELETED).
 *
 * Milestone TMAC retired the legacy per-micro-command-row wave engine from the live
 * cycle-runner but kept it reachable behind `REMO_ORCHESTRATOR_LEGACY_WAVES=1` —
 * a rollback path to a subsystem that has never shipped a PR, i.e. rollback to
 * nothing. It is now GONE: `makeCycleRunner` unconditionally drives `runMacroCycle`,
 * and no env var can put the wave engine back on the live path.
 *
 * These tests fail if anyone reintroduces the flag or re-wires the wave seams into
 * the cycle-runner. Reqs: R-TMAC-06.
 */
import { describe, test, expect, afterEach } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import * as controller from '../src/orchestrator/controller.ts'
import { makeCycleRunner, type ResolveDeps, type ControllerContext } from '../src/orchestrator/controller.ts'
import type { DueRow } from '../src/orchestrator/due-rows.ts'
import type { OrchestratorRow } from '../src/db/orchestrator-rows-dal.ts'

const CONTROLLER_SRC = readFileSync(resolve(import.meta.dir, '../src/orchestrator/controller.ts'), 'utf-8')

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
    last_fired_at: null,
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

const entry = { id: 'q1', session_id: 's1', priority: 0, status: 'running', enqueued_at: '', started_at: null } as any

describe('macro-path guard — the legacy wave rollback path is GONE', () => {
  test('the REMO_ORCHESTRATOR_LEGACY_WAVES flag no longer exists in the controller', () => {
    expect(CONTROLLER_SRC).not.toContain('REMO_ORCHESTRATOR_LEGACY_WAVES')
  })

  test('useMacroPath() is no longer exported (there is only one path)', () => {
    expect('useMacroPath' in controller).toBe(false)
  })

  test('makeCycleRunner takes no wave-seams argument', () => {
    expect(makeCycleRunner.length).toBe(0) // resolveDeps has a default ⇒ arity 0
  })

  test('setting the retired flag cannot resurrect the wave path', async () => {
    process.env.REMO_ORCHESTRATOR_LEGACY_WAVES = '1'
    // The macro path injects via injectOrchestratorPrompt (no agent socket online
    // here → no_session) and must not throw. There is no seam left to invoke.
    await makeCycleRunner(resolveDeps([{ row: row('gsd-plan-phase'), autoDisableAfter: false }]))(entry)
  })

  test('the cycle-runner body drives runMacroCycle and nothing else', () => {
    const body = CONTROLLER_SRC.slice(CONTROLLER_SRC.indexOf('export function makeCycleRunner'))
    expect(body).toContain('await runMacroCycle({')
    expect(body).not.toContain('runWavesFromDueRows(')
    expect(body).not.toContain('dispatchMergeIfDue(')
    expect(body).not.toContain('runVerifyTail(')
  })
})
