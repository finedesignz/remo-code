/**
 * Phase 32 (auto-dev-orchestrator) — controller→wave END-TO-END wiring.
 *
 * Closes the Phase-25 deferral: a claimed queue entry now resolves
 * session→user→task→stage, computes DUE rows, and drives the dependency-aware
 * waves DIRECTLY from those rows (each unit injects its templated prompt). These
 * tests are DB-free: ResolveDeps + WaveSeams are injected so we assert the
 * resolution + the exact command set handed to the execution seam, plus the
 * flag-OFF guarantee that nothing is registered/enqueued/injected.
 *
 * Reqs: closes R-ADO-11..14 wiring; preserves D10 (flag-OFF dormant).
 */
import { describe, test, expect, afterEach, beforeAll, afterAll } from 'bun:test'
import {
  resolveCycleContext,
  makeCycleRunner,
  registerCycleRunnerIfEnabled,
  type ResolveDeps,
  type ControllerContext,
} from '../src/orchestrator/controller.ts'
import type { WaveSeams, ExecuteResult } from '../src/orchestrator/wave-runner.ts'
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
  }
}
function due(...commands: string[]): DueRow[] {
  return commands.map((c) => ({ row: row(c), autoDisableAfter: false }))
}

function ctxWithDue(dueRows: DueRow[]): ControllerContext {
  return {
    repo: 'finedesignz/demo',
    stage: 'development',
    runtimeContext: { repo: 'finedesignz/demo' },
    runLog: [],
    dueRows,
  }
}

/** Resolve deps that return a fixed session/task + a controller context. */
const DEFAULT_SESSION = { user_id: 'user-1', repo_key: 'finedesignz/demo' }
const DEFAULT_TASK = { id: 'task-1', lifecycle_stage: 'development', timezone: 'UTC' }

function resolveDeps(dueRows: DueRow[], opts: { session?: any; task?: any } = {}): ResolveDeps {
  const session = 'session' in opts ? opts.session : DEFAULT_SESSION
  const task = 'task' in opts ? opts.task : DEFAULT_TASK
  return {
    getSessionById: (async (_id: string) => session) as any,
    getOrchestratorTaskForSession: (async (_u: string, _s: string) => task) as any,
    buildControllerContext: (async () => ctxWithDue(dueRows)) as any,
  }
}

/** Spy seams: record every executeCommand call's unit command + microPrompt. */
function spySeams(): { seams: WaveSeams; executed: { command: string; micro: string | null }[]; proposed: string[] } {
  const executed: { command: string; micro: string | null }[] = []
  const proposed: string[] = []
  const seams: WaveSeams = {
    async executeCommand(unit): Promise<ExecuteResult> {
      executed.push({ command: unit.command, micro: unit.microPrompt ?? null })
      return { outcome: 'dispatched' }
    },
    async createPrForUnit() { return null },
    async dispatchReviewer() { return null },
    async proposeToChat(unit) { proposed.push(unit.command) },
  }
  return { seams, executed, proposed }
}

const entry = { id: 'q1', session_id: 'sess-1', priority: 0, status: 'running', enqueued_at: '', started_at: null } as any

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
})

// ── makeCycleRunner — drives waves from the REAL due-row command set ──────────

describe('makeCycleRunner — due rows drive the wave command set', () => {
  // Milestone TMAC: the resume-heartbeat macro path is now the cycle-runner
  // default. This block exercises the LEGACY wave path (preserved behind the
  // rollback flag), so pin REMO_ORCHESTRATOR_LEGACY_WAVES=1 for its lifetime.
  let prevLegacy: string | undefined
  beforeAll(() => {
    prevLegacy = process.env.REMO_ORCHESTRATOR_LEGACY_WAVES
    process.env.REMO_ORCHESTRATOR_LEGACY_WAVES = '1'
  })
  afterAll(() => {
    if (prevLegacy === undefined) delete process.env.REMO_ORCHESTRATOR_LEGACY_WAVES
    else process.env.REMO_ORCHESTRATOR_LEGACY_WAVES = prevLegacy
  })

  test('executeCommand seam is called with the real due commands', async () => {
    const dueRows = due('gsd-plan-phase', 'gsd-execute-phase')
    const { seams, executed } = spySeams()
    const runner = makeCycleRunner(resolveDeps(dueRows), seams)
    await runner(entry)
    const cmds = executed.map((e) => e.command).sort()
    expect(cmds).toEqual(['gsd-execute-phase', 'gsd-plan-phase'])
  })

  test('a due row micro_prompt is carried onto the executed unit', async () => {
    const dueRows: DueRow[] = [{ row: row('gsd-audit-fix', 'focus on the auth module'), autoDisableAfter: false }]
    const { seams, executed } = spySeams()
    await makeCycleRunner(resolveDeps(dueRows), seams)(entry)
    expect(executed.length).toBe(1)
    expect(executed[0].micro).toBe('focus on the auth module')
  })

  test('propose-tier rows (gsd-ship) route to proposeToChat, never executeCommand', async () => {
    const dueRows = due('gsd-execute-phase', 'gsd-ship')
    const { seams, executed, proposed } = spySeams()
    await makeCycleRunner(resolveDeps(dueRows), seams)(entry)
    expect(executed.map((e) => e.command)).toContain('gsd-execute-phase')
    expect(executed.map((e) => e.command)).not.toContain('gsd-ship')
    expect(proposed).toContain('gsd-ship')
  })

  test('merge-to-main is EXCLUDED from the wave planner (off-hours special path)', async () => {
    const dueRows = due('gsd-execute-phase', 'merge-to-main')
    const { seams, executed } = spySeams()
    await makeCycleRunner(resolveDeps(dueRows), seams)(entry)
    expect(executed.map((e) => e.command)).not.toContain('merge-to-main')
  })

  test('no due rows ⇒ no executeCommand calls (nothing injected)', async () => {
    const { seams, executed } = spySeams()
    await makeCycleRunner(resolveDeps([]), seams)(entry)
    expect(executed.length).toBe(0)
  })

  test('stale/foreign entry (no task) ⇒ no executeCommand calls', async () => {
    const { seams, executed } = spySeams()
    await makeCycleRunner(resolveDeps([], { task: null }), seams)(entry)
    expect(executed.length).toBe(0)
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
