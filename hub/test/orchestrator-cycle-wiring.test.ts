/**
 * Phase 32 (auto-dev-orchestrator) — controller→wave END-TO-END wiring.
 *
 * Closes the Phase-25 deferral: a claimed queue entry now resolves
 * session→user→task→stage and computes DUE rows. These tests are DB-free:
 * ResolveDeps is injected so we assert the resolution, plus the flag-OFF
 * guarantee that nothing is registered/enqueued/injected.
 *
 * Reqs: closes R-ADO-11..14 wiring; preserves D10 (flag-OFF dormant).
 */
import { describe, test, expect, afterEach } from 'bun:test'
import {
  resolveCycleContext,
  registerCycleRunnerIfEnabled,
  type ResolveDeps,
  type ControllerContext,
} from '../src/orchestrator/controller.ts'
import type { DueRow } from '../src/orchestrator/due-rows.ts'
import type { OrchestratorRow } from '../src/db/orchestrator-rows-dal.ts'
import * as queue from '../src/orchestrator/queue.ts'

// ── helpers ───────────────────────────────────────────────────────────────────

function row(command: string, micro?: string): OrchestratorRow {
  return {
    id: `row-${command}`,
    task_id: 'task-1',
    command,
    enabled: true,
    schedule_rule: null,
    frequency_label: 'Once',
    micro_prompt: micro ?? null,
    sort_order: 0,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    last_fired_at: null,
  }
}
function due(...commands: string[]): DueRow[] {
  return commands.map((c) => ({ row: row(c), autoDisableAfter: false }))
}

function ctxWithDue(dueRows: DueRow[], stage: any = 'development'): ControllerContext {
  return {
    repo: 'finedesignz/demo',
    stage: stage ?? 'development',
    runtimeContext: { repo: 'finedesignz/demo' },
    runLog: [],
    dueRows,
  }
}

/** Resolve deps that return a fixed session/task + a controller context. */
const DEFAULT_SESSION = { user_id: 'user-1', repo_key: 'finedesignz/demo' }
const DEFAULT_TASK = { id: 'task-1', lifecycle_stage: 'development', timezone: 'UTC' }

function resolveDeps(
  dueRows: DueRow[],
  opts: { session?: any; task?: any; detectStage?: any } = {},
): ResolveDeps {
  const session = 'session' in opts ? opts.session : DEFAULT_SESSION
  const task = 'task' in opts ? opts.task : DEFAULT_TASK
  return {
    getSessionById: (async (_id: string) => session) as any,
    getOrchestratorTaskForSession: (async (_u: string, _s: string) => task) as any,
    buildControllerContext: (async (i: any) => ctxWithDue(dueRows, i?.stage)) as any,
    // Milestone TMAC §7.2 default: a detector that would auto-pick prod-maint, so
    // tests can assert it is ONLY consulted when the stage is not explicit.
    detectLifecycleStage: (opts.detectStage ?? (async () => 'production-maintenance')) as any,
  }
}

// ── resolveCycleContext ─────────────────────────────────────────────────────

describe('resolveCycleContext', () => {
  test('resolves session→user→task→stage + due rows', async () => {
    const r = await resolveCycleContext('sess-1', resolveDeps(due('gsd-plan-phase')))
    expect(r).not.toBeNull()
    expect(r!.userId).toBe('user-1')
    expect(r!.taskId).toBe('task-1')
    expect(r!.repoKey).toBe('finedesignz/demo')
    expect(r!.controllerContext.dueRows.length).toBe(1)
  })

  test('null when session is gone', async () => {
    const deps = resolveDeps([], { session: null })
    expect(await resolveCycleContext('sess-x', deps)).toBeNull()
  })

  test('null when session has no orchestrator task (stale/foreign entry)', async () => {
    const deps = resolveDeps([], { task: null })
    expect(await resolveCycleContext('sess-x', deps)).toBeNull()
  })

  // ── Milestone TMAC §7.2: auto-detected stage default vs explicit override ──
  test('stage NOT explicit ⇒ auto-detected stage overrides the stored default', async () => {
    const task = { id: 'task-1', lifecycle_stage: 'development', lifecycle_stage_explicit: false, timezone: 'UTC' }
    const r = await resolveCycleContext('sess-1', resolveDeps(due('gsd-plan-phase'), { task }))
    // detector returns production-maintenance → it wins over the stored default
    expect(r!.controllerContext.stage).toBe('production-maintenance')
  })

  test('explicit stage ALWAYS wins — detector is never consulted', async () => {
    let detectorCalled = false
    const task = { id: 'task-1', lifecycle_stage: 'beta', lifecycle_stage_explicit: true, timezone: 'UTC' }
    const detectStage = async () => { detectorCalled = true; return 'production-maintenance' }
    const r = await resolveCycleContext('sess-1', resolveDeps(due('gsd-plan-phase'), { task, detectStage }))
    expect(r!.controllerContext.stage).toBe('beta')
    expect(detectorCalled).toBe(false)
  })

  test('a detector throw degrades to the stored default (best-effort)', async () => {
    const task = { id: 'task-1', lifecycle_stage: 'development', lifecycle_stage_explicit: false, timezone: 'UTC' }
    const detectStage = async () => { throw new Error('probe down') }
    const r = await resolveCycleContext('sess-1', resolveDeps(due('gsd-plan-phase'), { task, detectStage }))
    expect(r!.controllerContext.stage).toBe('development')
  })
})

// ── flag-OFF guarantee: nothing registered / enqueued / injected ─────────────

describe('flag-OFF — REMO_ORCHESTRATOR_ENABLED', () => {
  const original = process.env.REMO_ORCHESTRATOR_ENABLED
  afterEach(() => {
    if (original === undefined) delete process.env.REMO_ORCHESTRATOR_ENABLED
    else process.env.REMO_ORCHESTRATOR_ENABLED = original
    queue._resetForTests()
  })

  test('unset ⇒ no runner registered ⇒ drain dormant (nothing enqueued/injected)', async () => {
    delete process.env.REMO_ORCHESTRATOR_ENABLED
    queue._resetForTests()
    expect(registerCycleRunnerIfEnabled()).toBe(false)
    // drainOnce with no registered runner claims nothing.
    const claimed = await queue.drainOnce()
    expect(claimed).toEqual([])
  })

  test('=1 ⇒ runner registered', () => {
    process.env.REMO_ORCHESTRATOR_ENABLED = '1'
    queue._resetForTests()
    expect(registerCycleRunnerIfEnabled()).toBe(true)
  })
})
