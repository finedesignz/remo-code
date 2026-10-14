/**
 * PTYCAP-04-06 (D-09b): the orchestrator tick honors the kill switch.
 *
 * - scanAndEnqueueDueCycles skips a task whose user/session is halted (the halt is
 *   evaluated with THAT task's user and session) and still enqueues the others.
 * - the cycle runner returns before the cadence stamp and before runMacroCycle when
 *   halted, so the rows stay due and the first post-release tick resumes cleanly
 *   (stamping while halted would burst-dispatch on release).
 *
 * The kill switch predicate is leaf-mocked here; its SQL and fail-closed behaviour
 * are proven in automation-controls-core.test.ts.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-chars-long-aaaaaaaa'

import { describe, test, expect, beforeEach, afterAll, mock } from 'bun:test'
import type { OrchestratorRow } from '../src/db/orchestrator-rows-dal.ts'
import { automationControlsLeaf } from './fixtures/automation-controls-leaf.ts'

const PAST = '2026-01-01T00:00:00.000Z'
const T0 = new Date('2026-07-10T05:04:00.000Z')

const TASKS = [
  { id: 'task-1', user_id: 'u1', session_id: 'sess-1', timezone: 'UTC' },
  { id: 'task-2', user_id: 'u2', session_id: 'sess-2', timezone: 'UTC' },
]
let rows: OrchestratorRow[] = []
let enqueued: string[] = []
let stamped: string[][] = []
let macroCalls = 0
let haltCalls: Array<{ userId: string; sessionId?: string }> = []
let haltedUsers = new Set<string>()
let haltScope = 'user'

const dueRow = (id: string, taskId: string): OrchestratorRow => ({
  id,
  task_id: taskId,
  command: 'gsd-execute-phase',
  enabled: true,
  schedule_rule: { interval: 1, unit: 'days', start_at: PAST } as any,
  frequency_label: null,
  micro_prompt: null,
  sort_order: 0,
  created_at: PAST,
  updated_at: PAST,
  last_fired_at: null,
})

mock.module('../src/db/postgres.ts', () => ({
  sql: (strings: TemplateStringsArray | string[]) => {
    const q = Array.isArray(strings) ? strings.join(' ') : String(strings)
    if (q.includes('scheduled_tasks')) return Promise.resolve(TASKS)
    return Promise.resolve([])
  },
}))

mock.module('../src/dispatch/automation-controls.ts', () => ({
  ...automationControlsLeaf(),
  isAutomationHalted: async (args: { userId: string; sessionId?: string }) => {
    haltCalls.push(args)
    return haltedUsers.has(args.userId) ? { halted: true, scope: haltScope } : { halted: false }
  },
}))

// Spread the real module so unrelated exports (run-log insert etc.) still resolve.
const realRowsDal = { ...(await import('../src/db/orchestrator-rows-dal.ts')) }
mock.module('../src/db/orchestrator-rows-dal.ts', () => ({
  ...realRowsDal,
  listOrchestratorRows: async (taskId: string) => rows.filter((r) => r.task_id === taskId),
  markOrchestratorRowsFired: async (ids: string[]) => {
    stamped.push(ids)
    return ids.length
  },
  getOrchestratorTaskForSession: async () => null,
}))

mock.module('../src/orchestrator/queue.ts', () => ({
  enqueueCycle: async (sessionId: string) => {
    enqueued.push(sessionId)
    return { id: 'q1', session_id: sessionId }
  },
  hasActiveCycle: async () => false,
  setCycleRunner: () => {},
  CyclePriority: { BUILD: 0, DEPLOY_FIX: 10 },
}))

mock.module('../src/orchestrator/macro-cycle.ts', () => ({
  runMacroCycle: async () => {
    macroCalls++
    return { reconciled: false, halted: false, injected: true, skipped: false, stubNotReady: false, sentinels: null }
  },
}))

afterAll(() => mock.restore())

beforeEach(() => {
  rows = [dueRow('r1', 'task-1'), dueRow('r2', 'task-2')]
  enqueued = []
  stamped = []
  macroCalls = 0
  haltCalls = []
  haltedUsers = new Set()
  haltScope = 'user'
})

async function runCycle(): Promise<void> {
  const { makeCycleRunner } = await import('../src/orchestrator/controller.ts')
  const { computeDueRowsForTask } = await import('../src/orchestrator/due-rows.ts')
  const runner = makeCycleRunner({
    getSessionById: async () => ({ id: 'sess-1', user_id: 'u1', repo_key: 'r/k', project_dir: '/p' }) as any,
    getOrchestratorTaskForSession: async () =>
      ({ id: 'task-1', timezone: 'UTC', lifecycle_stage: 'development', lifecycle_stage_explicit: true, macro_task_type: 'dev' }) as any,
    buildControllerContext: async () => ({
      repo: 'r/k',
      stage: 'development' as const,
      runtimeContext: {},
      runLog: [],
      dueRows: await computeDueRowsForTask('task-1', { sessionId: 'sess-1', now: T0, tz: 'UTC' }),
    }),
    detectLifecycleStage: async () => 'development' as const,
  } as any)
  await runner({ id: 'q1', session_id: 'sess-1' } as any)
}

describe('orchestrator due-scan honors the kill switch', () => {
  test('a halted user is skipped and the other user is still enqueued', async () => {
    haltedUsers.add('u1')
    const { scanAndEnqueueDueCycles } = await import('../src/orchestrator/controller.ts')
    const out = await scanAndEnqueueDueCycles(T0)
    expect(out).toEqual(['sess-2'])
    expect(enqueued).toEqual(['sess-2'])
  })

  test('the halt is evaluated with each task own user and session', async () => {
    const { scanAndEnqueueDueCycles } = await import('../src/orchestrator/controller.ts')
    await scanAndEnqueueDueCycles(T0)
    expect(haltCalls).toContainEqual({ userId: 'u1', sessionId: 'sess-1' })
    expect(haltCalls).toContainEqual({ userId: 'u2', sessionId: 'sess-2' })
    expect(enqueued.sort()).toEqual(['sess-1', 'sess-2'])
  })
})

describe('orchestrator cycle runner honors the kill switch', () => {
  test('halted: returns BEFORE the cadence stamp and BEFORE runMacroCycle', async () => {
    haltedUsers.add('u1')
    await runCycle()
    expect(stamped).toEqual([])
    expect(macroCalls).toBe(0)
    expect(haltCalls).toContainEqual({ userId: 'u1', sessionId: 'sess-1' })
  })

  test('not halted: the cycle stamps the due rows and runs the macro (control)', async () => {
    await runCycle()
    expect(stamped).toEqual([['r1']])
    expect(macroCalls).toBe(1)
  })
})
