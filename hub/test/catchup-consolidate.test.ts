/**
 * Catchup consolidation (bug fix 2026-05-25).
 *
 * Before the fix: hub restart with N missed fires for a single task produced
 * N identical `skipped/catchup` rows in `scheduled_task_runs`. A real-world
 * 4h-cadence task that sat through a long offline window flooded the UI with
 * 20+ duplicate rows.
 *
 * After the fix: ONE row, `error='hub_restart:N_missed'`, with a human-readable
 * `output_snippet` summarising the window.
 *
 * Strategy: mock the DAL module so we never touch postgres, then drive
 * `consolidateMissed` directly + assert the single captured insert.
 */
import { describe, test, expect, beforeEach, mock } from 'bun:test'

const calls: any[] = []

mock.module('../src/db/scheduled-tasks-dal.ts', () => ({
  listEnabledTasks: async () => [],
  insertRunV2: async (input: any) => {
    calls.push(input)
    return { id: `run_${calls.length}`, ...input }
  },
  getRun: async (_runId: string, _userId: string) => ({
    id: 'run_1',
    user_id: 'user_1',
    application_uuid: 'app-abc',
    deployment_uuid: 'deploy-xyz',
    git_repository: 'finedesignz/remo-code',
    commit_sha: 'abc123',
  }),
}))

// Import AFTER the mock so the module binds to the stub.
const { consolidateMissed } = await import('../src/scheduler/catchup.ts')

const baseTask = {
  id: 'task_1',
  user_id: 'user_1',
  target_kind: 'session' as const,
  target_id: 'sess_1',
  catchup_policy: 'skip' as const,
  cron_expr: '0 */4 * * *',
  timezone: 'UTC',
  created_at: new Date('2026-05-24T00:00:00Z'),
  last_fire_at: null,
} as any

describe('catchup/consolidateMissed', () => {
  beforeEach(() => {
    calls.length = 0
  })

  test('20 missed slots → exactly 1 inserted row', async () => {
    const missed: Date[] = []
    const start = Date.parse('2026-05-23T00:00:00Z')
    for (let i = 0; i < 20; i++) {
      missed.push(new Date(start + i * 4 * 60 * 60 * 1000))
    }
    await consolidateMissed(baseTask, missed)
    expect(calls.length).toBe(1)
    const row = calls[0]
    expect(row.status).toBe('skipped')
    expect(row.error).toBe('hub_restart:20_missed')
    expect(row.output_snippet).toContain('Skipped 20 missed fires')
    expect(row.output_snippet).toContain('2026-05-23T00:00:00.000Z')
    expect(row.output_snippet).toContain(
      new Date(start + 19 * 4 * 60 * 60 * 1000).toISOString(),
    )
    expect(row.scheduled_for.getTime()).toBe(missed[0].getTime())
    expect(row.started_at.getTime()).toBe(missed[0].getTime())
    expect(row.finished_at).toBeInstanceOf(Date)
    expect(row.task_id).toBe('task_1')
    expect(row.target_kind).toBe('session')
  })

  test('1 missed slot → 1 row with singular snippet', async () => {
    const at = new Date('2026-05-25T08:00:00Z')
    await consolidateMissed(baseTask, [at])
    expect(calls.length).toBe(1)
    expect(calls[0].error).toBe('hub_restart:1_missed')
    expect(calls[0].output_snippet).toBe(
      'Skipped 1 missed fire at 2026-05-25T08:00:00.000Z during hub downtime',
    )
  })

  test('1000 missed slots → still 1 row (no per-fire fan-out)', async () => {
    const missed: Date[] = []
    const start = Date.parse('2026-01-01T00:00:00Z')
    for (let i = 0; i < 1000; i++) {
      missed.push(new Date(start + i * 60_000))
    }
    await consolidateMissed(baseTask, missed)
    expect(calls.length).toBe(1)
    expect(calls[0].error).toBe('hub_restart:1000_missed')
  })

  test('empty missed list → no insert', async () => {
    await consolidateMissed(baseTask, [])
    expect(calls.length).toBe(0)
  })
})
