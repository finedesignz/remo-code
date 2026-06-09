/**
 * F-12 stub-macro guard — ISOLATED file.
 *
 * Forcing a complete:false macro requires a process-global `mock.module` of
 * task-macros.ts (the live registry has no stubs after PR #273 completed all
 * four macros). mock.module leaks into any sibling test that imports the real
 * task-macros (feedback_bun_mock_pollution), so this lives in its own file —
 * check-baseline runs each test file in a separate process, fully isolating it.
 */
import { test, expect, mock } from 'bun:test'

mock.module('../src/orchestrator/task-macros.ts', () => ({
  renderMacro: () => ({ task_type: 'maintenance', prompt: 'STUB', complete: false }),
}))

const { runMacroCycle } = await import('../src/orchestrator/macro-cycle.ts')
import type { MacroCycleInput, MacroCycleDeps } from '../src/orchestrator/macro-cycle.ts'

function baseInput(over: Partial<MacroCycleInput> = {}): MacroCycleInput {
  return {
    userId: 'u1',
    sessionId: 's1',
    taskId: 't1',
    macroTaskType: 'maintenance' as any,
    stage: 'development',
    repoPath: '/srv/repos/acme',
    repoIdent: 'github://acme/acme',
    repoKey: 'github://acme/acme',
    ...over,
  }
}

function spyDeps(): { deps: MacroCycleDeps; log: { injects: string[]; runLogs: any[]; notifies: any[] } } {
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
  }
  return { deps, log }
}

test('F-12: stub macro (complete=false) → no inject, stub_not_ready run-log', async () => {
  const { deps, log } = spyDeps()
  const r = await runMacroCycle(baseInput(), deps)
  expect(r.stubNotReady).toBe(true)
  expect(r.injected).toBe(false)
  expect(log.injects).toHaveLength(0)
  expect(log.runLogs.some((e) => e.outcome === 'stub_not_ready')).toBe(true)
})
