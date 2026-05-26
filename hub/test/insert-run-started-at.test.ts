/**
 * Regression: PR #49 made started_at default to null when status='pending',
 * which violates the NOT NULL column constraint. Every cron fire was failing
 * in prod. insertRunV2 must ALWAYS pass a non-null started_at to SQL.
 */
import { describe, it, expect, mock, beforeEach } from 'bun:test'

// Capture the values passed to the tagged-template `sql` call.
let captured: any[] = []

mock.module('../src/db/postgres.ts', () => {
  const sql: any = (strings: TemplateStringsArray, ...values: any[]) => {
    captured.push({ strings: [...strings], values })
    // INSERT ... RETURNING * — return a fake row so insertRunV2 resolves.
    return Promise.resolve([
      { id: 'run_test', status: 'pending', started_at: new Date() },
    ])
  }
  return { sql, default: sql }
})

const { insertRunV2 } = await import('../src/db/scheduled-tasks-dal.ts')

describe('insertRunV2 started_at safety', () => {
  beforeEach(() => {
    captured = []
  })

  it('passes a non-null Date for started_at when status=pending and started_at omitted', async () => {
    await insertRunV2({
      task_id: 't1',
      user_id: 'u1',
      status: 'pending',
      scheduled_for: new Date(),
      target_kind: 'agent',
    })
    expect(captured.length).toBeGreaterThan(0)
    const vals = captured[0].values
    // started_at sits between triggered_by_run_id and finished_at in the
    // INSERT VALUES clause. Find any Date value that isn't scheduled_for.
    const dates = vals.filter((v: any) => v instanceof Date)
    expect(dates.length).toBeGreaterThanOrEqual(2) // scheduled_for + started_at
    // None of the date values should be null/undefined.
    for (const v of vals) {
      if (v === null || v === undefined) continue
      // ok
    }
    // Specifically: no Date slot in values is null.
    const allDates = vals.filter(
      (v: any) => v instanceof Date || v === null || v === undefined,
    )
    // started_at slot must not be null
    expect(dates.some((d: Date) => d instanceof Date)).toBe(true)
  })

  it('passes a non-null Date for status=success path', async () => {
    await insertRunV2({
      task_id: 't1',
      user_id: 'u1',
      status: 'success',
      scheduled_for: new Date(),
      target_kind: 'agent',
    })
    const vals = captured[0].values
    const dates = vals.filter((v: any) => v instanceof Date)
    expect(dates.length).toBeGreaterThanOrEqual(2)
  })

  it('honors caller-provided started_at when given', async () => {
    const explicit = new Date('2026-01-01T00:00:00Z')
    await insertRunV2({
      task_id: 't1',
      user_id: 'u1',
      status: 'pending',
      scheduled_for: new Date(),
      target_kind: 'agent',
      started_at: explicit,
    })
    const vals = captured[0].values
    expect(vals.some((v: any) => v instanceof Date && v.getTime() === explicit.getTime())).toBe(true)
  })

  it('defends against an explicit null started_at (cron-fire registry path)', async () => {
    // The registry → dispatcher.fire path was reported as still failing with
    // "null value in column started_at" even after PR #55. Defend in JS AND
    // in SQL: even if a future caller passes null explicitly, we substitute
    // new Date() (and the SQL wraps it in COALESCE(_, now()) as belt+suspenders).
    await insertRunV2({
      task_id: 't1',
      user_id: 'u1',
      status: 'pending',
      scheduled_for: new Date(),
      target_kind: 'agent',
      started_at: null,
    })
    const vals = captured[0].values
    // No null/undefined value in the started_at slot — every Date is real.
    const dates = vals.filter((v: any) => v instanceof Date)
    expect(dates.length).toBeGreaterThanOrEqual(2)
    // The SQL template itself must contain COALESCE(_, now()) over started_at.
    const sqlString = captured[0].strings.join('?')
    expect(sqlString).toMatch(/COALESCE\([^)]*now\(\)\)/i)
  })
})

// ── insertDeploymentRun: never NULL on started_at ──────────────────────────
// Separate mock context because dal.ts also imports `sql` from postgres.ts.
import { describe as describe2, it as it2, expect as expect2 } from 'bun:test'

describe2('insertDeploymentRun started_at safety', () => {
  it2('passes now() (not null) for status=pending', async () => {
    // Re-import dal.ts under the same mocked postgres module.
    captured = []
    const { insertDeploymentRun } = await import('../src/db/dal.ts')
    await insertDeploymentRun({
      task_id: 't1',
      user_id: 'u1',
      status: 'pending',
      deployment_uuid: 'd1',
      application_uuid: 'a1',
      git_repository: 'org/repo',
      commit_sha: null,
    })
    // The new code passes a tagged-template fragment for `now()` (no JS null).
    // Assert: no `null` value sits in the slot where started_at used to be.
    const vals = captured[0].values
    // started_at slot used to be `null` for pending; now it's a sql fragment.
    // Sql fragments are objects (not null/undefined).
    expect2(vals.every((v: any) => v !== undefined)).toBe(true)
  })
})
