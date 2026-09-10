/**
 * Phase 23 (auto-dev-orchestrator) — DUE-row eligibility (pure, no DB).
 *
 * Exercises the decision core's reuse of the scheduler's shouldSkipFire/boundReason
 * via the pure computeDueRows / isRowDue. Decisions D1 (run ALL due) and D3
 * (Never = disabled, Once = max_runs=1 auto-disable).
 *
 * Reqs: R-ADO-09.
 */
import { describe, test, expect } from 'bun:test'
import { computeDueRows, isRowDue } from '../src/orchestrator/due-rows.ts'
import type { OrchestratorRow } from '../src/db/orchestrator-rows-dal.ts'
import type { ScheduleRule } from '../src/scheduler/schedule-rules.ts'

function row(over: Partial<OrchestratorRow> = {}): OrchestratorRow {
  return {
    id: over.id ?? 'r1',
    task_id: 't1',
    command: over.command ?? 'gsd-execute-phase',
    enabled: over.enabled ?? true,
    schedule_rule: over.schedule_rule ?? null,
    frequency_label: over.frequency_label ?? null,
    micro_prompt: over.micro_prompt ?? null,
    sort_order: over.sort_order ?? 0,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    last_fired_at: over.last_fired_at ?? null,
  }
}

// An hourly rule whose start is well in the past, so cadence/window are satisfied.
const PAST = '2026-01-01T00:00:00.000Z'
const NOW = new Date('2026-06-06T12:00:00.000Z')
const hourly = (over: Partial<ScheduleRule> = {}): ScheduleRule => ({
  interval: 1,
  unit: 'hours',
  start_at: PAST,
  ...over,
})

describe('due-rows — Never / disabled', () => {
  test("frequency_label 'Never' is never due", () => {
    const r = row({ frequency_label: 'Never', schedule_rule: hourly() })
    expect(isRowDue(r, NOW, 'UTC', 0).due).toBe(false)
  })

  test('disabled row is never due', () => {
    const r = row({ enabled: false, schedule_rule: hourly() })
    expect(isRowDue(r, NOW, 'UTC', 0).due).toBe(false)
  })

  test('row with no schedule_rule (and not Once) is not due', () => {
    expect(isRowDue(row(), NOW, 'UTC', 0).due).toBe(false)
  })
})

describe('due-rows — Once (max_runs=1)', () => {
  test('Once fires when run-count is 0 and flags auto-disable', () => {
    const r = row({ frequency_label: 'Once' })
    const res = isRowDue(r, NOW, 'UTC', 0)
    expect(res.due).toBe(true)
    expect(res.autoDisableAfter).toBe(true)
  })

  test('Once does NOT fire again once it has run', () => {
    const r = row({ frequency_label: 'Once' })
    expect(isRowDue(r, NOW, 'UTC', 1).due).toBe(false)
  })

  test('rule.max_runs=1 behaves like Once', () => {
    const r = row({ schedule_rule: hourly({ max_runs: 1 }) })
    expect(isRowDue(r, NOW, 'UTC', 0)).toEqual({ due: true, autoDisableAfter: true })
    expect(isRowDue(r, NOW, 'UTC', 1).due).toBe(false)
  })
})

describe('due-rows — cron / active_window / bounds (delegates to shouldSkipFire/boundReason)', () => {
  test('hourly rule in the past is due now', () => {
    const r = row({ schedule_rule: hourly() })
    const res = isRowDue(r, NOW, 'UTC', 0)
    expect(res.due).toBe(true)
    expect(res.autoDisableAfter).toBe(false)
  })

  test('start_at in the future is NOT due', () => {
    const r = row({ schedule_rule: hourly({ start_at: '2099-01-01T00:00:00.000Z' }) })
    expect(isRowDue(r, NOW, 'UTC', 0).due).toBe(false)
  })

  test('outside active_window is NOT due', () => {
    // NOW is 12:00 UTC; window 22:00–23:00 excludes it.
    const r = row({ schedule_rule: hourly({ active_window: { from: '22:00', to: '23:00' } }) })
    expect(isRowDue(r, NOW, 'UTC', 0).due).toBe(false)
  })

  test('inside active_window IS due', () => {
    const r = row({ schedule_rule: hourly({ active_window: { from: '11:00', to: '13:00' } }) })
    expect(isRowDue(r, NOW, 'UTC', 0).due).toBe(true)
  })

  test('past until-bound stops the row (boundReason)', () => {
    const r = row({ schedule_rule: hourly({ until: '2026-01-02T00:00:00.000Z' }) })
    expect(isRowDue(r, NOW, 'UTC', 0).due).toBe(false)
  })

  test('max_runs>1 reached stops the row', () => {
    const r = row({ schedule_rule: hourly({ max_runs: 3 }) })
    expect(isRowDue(r, NOW, 'UTC', 2).due).toBe(true)
    expect(isRowDue(r, NOW, 'UTC', 3).due).toBe(false)
  })
})

describe('computeDueRows — full set, run ALL due (R-ADO-09)', () => {
  test('returns every due row, not just one', () => {
    const rows = [
      row({ id: 'a', command: 'cmd-a', schedule_rule: hourly() }), // due
      row({ id: 'b', command: 'cmd-b', frequency_label: 'Never', schedule_rule: hourly() }), // not due
      row({ id: 'c', command: 'cmd-c', frequency_label: 'Once' }), // due (once)
      row({ id: 'd', command: 'cmd-d', enabled: false, schedule_rule: hourly() }), // not due
    ]
    const due = computeDueRows(rows, { now: NOW, tz: 'UTC', runCountForRow: () => 0 })
    expect(due.map((d) => d.row.id).sort()).toEqual(['a', 'c'])
    expect(due.find((d) => d.row.id === 'c')!.autoDisableAfter).toBe(true)
  })

  test('run-count lookup gates the Once row off after it has run', () => {
    const rows = [row({ id: 'c', command: 'cmd-c', frequency_label: 'Once' })]
    const due = computeDueRows(rows, {
      now: NOW,
      tz: 'UTC',
      runCountForRow: (r) => (r.command === 'cmd-c' ? 1 : 0),
    })
    expect(due.length).toBe(0)
  })
})
