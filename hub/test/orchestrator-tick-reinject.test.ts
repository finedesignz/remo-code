/**
 * fix/orchestrator-tick-reinject — REGRESSION: the orchestrator must not re-inject
 * its macro prompt on every 60s due-scan tick — AND the queued cycle must still run
 * its rows (the cadence stamp must not turn autopilot into a silent no-op).
 *
 * INCIDENT (prod, 2026-07-10 → 07-12): session 4090d376 (titanium-edge-aios) took
 * ~60 orchestrator turns/HOUR, 24/7 — 2,192 turns, 2.83B cache-read tokens — while
 * its DAILY scheduled_task never fired (its runs were all `orchestrator_due_tick_owned`).
 * The injects came from the due-scan tick itself: `orchestrator_rows` carried NO
 * cadence state, and `shouldSkipFire()` is an ELIGIBILITY predicate (start_at /
 * week+month parity / active_window) with no elapsed-since-last-fire check, so an
 * `Every 4h` row was DUE on all 1440 daily ticks.
 */
import { describe, test, expect, beforeEach, afterAll, mock } from 'bun:test'
import { isRowDue, computeDueRows } from '../src/orchestrator/due-rows.ts'
import type { OrchestratorRow } from '../src/db/orchestrator-rows-dal.ts'
import type { ScheduleRule } from '../src/scheduler/schedule-rules.ts'

const PAST = '2026-01-01T00:00:00.000Z'
const T0 = new Date('2026-07-10T05:04:00.000Z')
const T0_PLUS_60S = new Date(T0.getTime() + 60_000)

function row(over: Partial<OrchestratorRow> = {}): OrchestratorRow {
  return {
    id: over.id ?? 'r1',
    task_id: over.task_id ?? 'task-1',
    command: over.command ?? 'gsd-execute-phase',
    enabled: over.enabled ?? true,
    schedule_rule: over.schedule_rule ?? null,
    frequency_label: over.frequency_label ?? null,
    micro_prompt: null,
    sort_order: 0,
    created_at: PAST,
    updated_at: PAST,
    last_fired_at: over.last_fired_at ?? null,
  }
}

const every = (interval: number, unit: ScheduleRule['unit']): ScheduleRule => ({
  interval,
  unit,
  start_at: PAST,
})

// ── (1) cadence gate: the interval must ELAPSE since the last fire ────────────
describe('due-rows — cadence advances on fire (regression)', () => {
  test('a DAILY row that just fired is NOT due again 60s later', () => {
    const r = row({ schedule_rule: every(1, 'days'), last_fired_at: T0.toISOString() })
    expect(isRowDue(r, T0_PLUS_60S, 'UTC', 1).due).toBe(false)
  })

  test('the prod shape (Every 4h) is NOT due again 60s later', () => {
    const r = row({
      command: 'gsd-plan-phase',
      frequency_label: 'Every 4h',
      schedule_rule: every(4, 'hours'),
      last_fired_at: T0.toISOString(),
    })
    expect(isRowDue(r, T0_PLUS_60S, 'UTC', 1).due).toBe(false)
    // ...and still not due at 3h59m.
    const almost = new Date(T0.getTime() + 4 * 3_600_000 - 60_000)
    expect(isRowDue(r, almost, 'UTC', 1).due).toBe(false)
  })

  test('a never-fired row IS due (cold start unchanged)', () => {
    const r = row({ schedule_rule: every(4, 'hours'), last_fired_at: null })
    expect(isRowDue(r, T0, 'UTC', 0).due).toBe(true)
  })

  test('once the cadence ELAPSES the row is DUE again', () => {
    const r = row({ schedule_rule: every(4, 'hours'), last_fired_at: T0.toISOString() })
    const after = new Date(T0.getTime() + 4 * 3_600_000 + 1000)
    expect(isRowDue(r, after, 'UTC', 1).due).toBe(true)
    expect(computeDueRows([r], { now: after, tz: 'UTC' })).toHaveLength(1)
  })

  test('a NON-NULL but UNPARSEABLE last_fired_at is treated as recently-fired (fail-closed)', () => {
    // A corrupt stamp must NOT fall through to "due" — that would silently disable
    // the cadence gate and restore per-tick firing.
    const r = row({ schedule_rule: every(4, 'hours'), last_fired_at: 'not-a-timestamp' })
    expect(isRowDue(r, T0_PLUS_60S, 'UTC', 1).due).toBe(false)
    expect(computeDueRows([r], { now: T0_PLUS_60S, tz: 'UTC' })).toHaveLength(0)
  })
})

// ── (2) tick + cycle: the FULL loop (enqueue → cycle runs → cadence advances) ──
// Models what prod actually does: the queue entry carries ONLY session_id, so the
// CYCLE re-selects its DUE rows when it runs. The cadence is therefore stamped by
// the CYCLE (on the rows it selected), never at enqueue-time — stamping at enqueue
// would leave the cycle with ZERO due rows (a silent autopilot no-op).

const TASK = { id: 'task-1', session_id: 'sess-1', timezone: 'UTC' }
let rows: OrchestratorRow[] = []
let enqueued: string[] = []
let active = false
let executed: string[] = []
let macroResumes = 0
let fakeNow = T0

mock.module('../src/db/postgres.ts', () => ({
  sql: (strings: TemplateStringsArray | string[]) => {
    const q = Array.isArray(strings) ? strings.join(' ') : String(strings)
    if (q.includes('scheduled_tasks')) return Promise.resolve([TASK])
    if (q.includes('routine_run_log')) return Promise.resolve([]) // run counts
    return Promise.resolve([])
  },
}))

mock.module('../src/db/orchestrator-rows-dal.ts', () => ({
  listOrchestratorRows: async (taskId: string) => rows.filter((r) => r.task_id === taskId),
  markOrchestratorRowsFired: async (ids: string[], firedAt?: Date) => {
    // The controller stamps with the real clock; tests pin it via `fakeNow` so the
    // cadence maths stay deterministic.
    const at = firedAt ?? fakeNow
    for (const r of rows) if (ids.includes(r.id)) r.last_fired_at = at.toISOString()
    return ids.length
  },
  getOrchestratorTaskForSession: async () => null,
}))

mock.module('../src/orchestrator/queue.ts', () => ({
  enqueueCycle: async (sessionId: string) => {
    enqueued.push(sessionId)
    active = true // the cycle is now pending/running for this session
    return { id: 'q1', session_id: sessionId }
  },
  hasActiveCycle: async () => active,
  setCycleRunner: () => {},
  CyclePriority: { BUILD: 0, DEPLOY_FIX: 10 },
}))

// The macro path is the prod default: record each resume instead of driving a CLI.
mock.module('../src/orchestrator/macro-cycle.ts', () => ({
  runMacroCycle: async () => {
    macroResumes++
    return {
      reconciled: false,
      halted: false,
      injected: true,
      skipped: false,
      stubNotReady: false,
      sentinels: null,
    }
  },
}))

afterAll(() => mock.restore())

/** Run one cycle for sess-1 exactly like the drain worker does (entry = session_id only). */
async function runCycleForSession(now: Date): Promise<void> {
  fakeNow = now
  const { makeCycleRunner } = await import('../src/orchestrator/controller.ts')
  const { computeDueRowsForTask } = await import('../src/orchestrator/due-rows.ts')
  const runner = makeCycleRunner(
    {
      getSessionById: async () =>
        ({ id: 'sess-1', user_id: 'u1', repo_key: 'r/k', project_dir: '/p' }) as any,
      getOrchestratorTaskForSession: async () =>
        ({
          id: TASK.id,
          timezone: 'UTC',
          lifecycle_stage: 'development',
          lifecycle_stage_explicit: true,
          macro_task_type: 'dev',
        }) as any,
      // Re-select DUE rows AT CYCLE TIME (the real behaviour: the queue entry carries
      // only session_id). This is what a stamp-at-enqueue fix would have starved.
      buildControllerContext: async () => ({
        repo: 'r/k',
        stage: 'development' as const,
        runtimeContext: {},
        runLog: [],
        dueRows: await computeDueRowsForTask(TASK.id, { sessionId: 'sess-1', now, tz: 'UTC' }),
      }),
      detectLifecycleStage: async () => 'development' as const,
    } as any,
    // Legacy-wave seams: record the commands the cycle actually EXECUTES.
    {
      executeCommand: async (unit: any) => {
        executed.push(unit.command)
        return { ok: true }
      },
      createPrForUnit: async () => null,
      dispatchReviewer: async () => null,
      proposeToChat: async () => {},
    } as any,
  )
  await runner({ id: 'q1', session_id: 'sess-1' } as any)
  active = false // the cycle settled
}

describe('due-scan tick + cycle — no per-tick re-inject, and the cycle still RUNS its rows', () => {
  beforeEach(() => {
    rows = [row({ id: 'r-exec', schedule_rule: every(1, 'days') })]
    enqueued = []
    executed = []
    macroResumes = 0
    active = false
    fakeNow = T0
    delete process.env.REMO_ORCHESTRATOR_LEGACY_WAVES
  })

  test('BLOCKER regression: the queued cycle still has its DUE rows and EXECUTES them', async () => {
    process.env.REMO_ORCHESTRATOR_LEGACY_WAVES = '1' // legacy wave path: assert real command execution
    const { scanAndEnqueueDueCycles } = await import('../src/orchestrator/controller.ts')

    await scanAndEnqueueDueCycles(T0)
    expect(enqueued).toEqual(['sess-1'])
    expect(rows[0].last_fired_at).toBeNull() // NOT stamped at enqueue-time

    await runCycleForSession(new Date(T0.getTime() + 1500)) // drained a moment later
    expect(executed).toEqual(['gsd-execute-phase']) // the cycle ran its row — NOT a no-op
    expect(rows[0].last_fired_at).not.toBeNull() // cadence advanced BY THE CYCLE
  })

  test('macro path: the cycle resumes the macro AND advances the cadence', async () => {
    const { scanAndEnqueueDueCycles } = await import('../src/orchestrator/controller.ts')

    await scanAndEnqueueDueCycles(T0)
    await runCycleForSession(new Date(T0.getTime() + 1500))
    expect(macroResumes).toBe(1)
    expect(rows[0].last_fired_at).not.toBeNull()
  })

  test('two ticks 60s apart with a daily-cadence row produce exactly ONE cycle', async () => {
    const { scanAndEnqueueDueCycles } = await import('../src/orchestrator/controller.ts')

    await scanAndEnqueueDueCycles(T0)
    await runCycleForSession(new Date(T0.getTime() + 1500))
    expect(enqueued).toHaveLength(1)
    expect(macroResumes).toBe(1)

    await scanAndEnqueueDueCycles(T0_PLUS_60S)
    expect(enqueued).toHaveLength(1) // still ONE — not re-injected a minute later
    expect(macroResumes).toBe(1)
  })

  test('a tick while the prior cycle is still in flight enqueues ZERO', async () => {
    const { scanAndEnqueueDueCycles } = await import('../src/orchestrator/controller.ts')

    await scanAndEnqueueDueCycles(T0)
    expect(enqueued).toHaveLength(1)

    // The cycle has NOT settled (`active` still true) and the rows are still unstamped
    // (they are only stamped when the cycle runs) — so ONLY the in-flight guard can
    // stop a second enqueue here. This is the exact stacking the incident showed.
    await scanAndEnqueueDueCycles(T0_PLUS_60S)
    expect(enqueued).toHaveLength(1)
  })

  test('after the cadence elapses and the prior cycle completed, the next tick DOES inject', async () => {
    const { scanAndEnqueueDueCycles } = await import('../src/orchestrator/controller.ts')

    await scanAndEnqueueDueCycles(T0)
    await runCycleForSession(new Date(T0.getTime() + 1500))

    const nextDay = new Date(T0.getTime() + 24 * 3_600_000 + 5000)
    await scanAndEnqueueDueCycles(nextDay)
    expect(enqueued).toEqual(['sess-1', 'sess-1'])

    await runCycleForSession(nextDay)
    expect(macroResumes).toBe(2)
  })
})
