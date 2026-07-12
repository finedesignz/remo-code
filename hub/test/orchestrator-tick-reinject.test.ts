/**
 * fix/orchestrator-tick-reinject — REGRESSION: the orchestrator must not re-inject
 * its macro prompt on every 60s due-scan tick.
 *
 * INCIDENT (prod, 2026-07-10 → 07-12): session 4090d376 (titanium-edge-aios) took
 * ~60 orchestrator turns/HOUR, 24/7 — 2,192 turns, 2.83B cache-read tokens — while
 * its DAILY scheduled_task never fired (its runs were all `orchestrator_due_tick_owned`).
 * The injects came from the due-scan tick itself: `orchestrator_rows` carried NO
 * cadence state, and `shouldSkipFire()` is an ELIGIBILITY predicate (start_at /
 * week+month parity / active_window) with no elapsed-since-last-fire check, so an
 * `Every 4h` row was DUE on all 1440 daily ticks.
 *
 * These tests fail against the pre-fix code (no `last_fired_at`, no in-flight guard).
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
})

// ── (2) tick-level: scanAndEnqueueDueCycles ──────────────────────────────────
// Mocked DB + queue. Asserts: two ticks 60s apart with a daily-cadence row enqueue
// exactly ONE cycle; a tick while the prior cycle is still in flight enqueues ZERO;
// after the cadence elapses (and the prior cycle settled) the next tick DOES enqueue.

const TASK = { id: 'task-1', session_id: 'sess-1', timezone: 'UTC' }
let rows: OrchestratorRow[] = []
let enqueued: string[] = []
let active = false

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
  markOrchestratorRowsFired: async (ids: string[], firedAt: Date) => {
    for (const r of rows) if (ids.includes(r.id)) r.last_fired_at = firedAt.toISOString()
    return ids.length
  },
  getOrchestratorTaskForSession: async () => null,
}))

mock.module('../src/orchestrator/queue.ts', () => ({
  enqueueCycle: async (sessionId: string) => {
    enqueued.push(sessionId)
    active = true // a cycle is now pending/running for this session
    return { id: 'q1', session_id: sessionId }
  },
  hasActiveCycle: async () => active,
  setCycleRunner: () => {},
  CyclePriority: { BUILD: 0, DEPLOY_FIX: 10 },
}))

afterAll(() => mock.restore())

describe('due-scan tick — no per-tick re-inject (regression)', () => {
  beforeEach(() => {
    rows = [row({ id: 'r-exec', schedule_rule: every(1, 'days') })]
    enqueued = []
    active = false
  })

  test('two ticks 60s apart with a daily-cadence row enqueue exactly ONE cycle', async () => {
    const { scanAndEnqueueDueCycles } = await import('../src/orchestrator/controller.ts')

    await scanAndEnqueueDueCycles(T0)
    expect(enqueued).toEqual(['sess-1'])
    expect(rows[0].last_fired_at).toBe(T0.toISOString()) // cadence ADVANCED

    active = false // the cycle settled well within the minute
    await scanAndEnqueueDueCycles(T0_PLUS_60S)
    expect(enqueued).toEqual(['sess-1']) // still exactly one — NOT re-injected
  })

  test('a tick while the prior cycle is still in flight enqueues ZERO', async () => {
    const { scanAndEnqueueDueCycles } = await import('../src/orchestrator/controller.ts')

    // Cold start: a never-fired row IS due, so this first tick enqueues.
    await scanAndEnqueueDueCycles(T0)
    expect(enqueued).toHaveLength(1)

    // The macro turn is still working (`active` left true). Even if the row were
    // due, the in-flight guard must refuse to stack a second cycle.
    rows[0].last_fired_at = null // force "due" so ONLY the in-flight guard can stop us
    await scanAndEnqueueDueCycles(T0_PLUS_60S)
    expect(enqueued).toHaveLength(1)
  })

  test('after the cadence elapses and the prior cycle settled, the next tick DOES enqueue', async () => {
    const { scanAndEnqueueDueCycles } = await import('../src/orchestrator/controller.ts')

    await scanAndEnqueueDueCycles(T0)
    expect(enqueued).toHaveLength(1)

    active = false // prior cycle completed
    const nextDay = new Date(T0.getTime() + 24 * 3_600_000 + 1000)
    await scanAndEnqueueDueCycles(nextDay)
    expect(enqueued).toEqual(['sess-1', 'sess-1'])
    expect(rows[0].last_fired_at).toBe(nextDay.toISOString())
  })
})
