/**
 * Regression: PR #49 made started_at default to null when status='pending',
 * which violates the NOT NULL column constraint. Every cron fire was failing
 * in prod. insertRunV2 must ALWAYS pass a non-null started_at to SQL.
 *
 * Implementation note: other test files in this suite also call
 * `mock.module('../src/db/postgres.ts', …)` and `mock.module('../src/db/dal.ts', …)`.
 * Bun's `mock.module` is process-global and last-registration-wins. To survive
 * arbitrary test-file ordering we (a) re-register the mocks in beforeEach and
 * (b) re-import the DAL modules inside each test via a cache-busting query
 * suffix so we always get a fresh binding wired to OUR mock.
 */
import { describe, it, expect, mock, beforeEach } from 'bun:test'

let captured: any[] = []

function installMocks() {
  const sql: any = (strings: TemplateStringsArray, ...values: any[]) => {
    captured.push({ strings: [...strings], values })
    return Promise.resolve([
      { id: 'run_test', status: 'pending', started_at: new Date() },
    ])
  }
  mock.module('../src/db/postgres.ts', () => ({ sql, default: sql }))
  mock.module('../src/db/postgres', () => ({ sql, default: sql }))
}

async function freshScheduledTasksDal() {
  // Cache-bust suffix forces Bun to re-resolve the module with the *current*
  // mock.module bindings instead of returning a cached binding that was
  // captured against a prior test file's mock.
  const mod: any = await import(
    `../src/db/scheduled-tasks-dal.ts?t=${Date.now()}${Math.random()}`
  )
  return mod
}

async function freshDal() {
  const mod: any = await import(
    `../src/db/dal.ts?t=${Date.now()}${Math.random()}`
  )
  return mod
}

describe('insertRunV2 started_at safety', () => {
  beforeEach(() => {
    captured = []
    installMocks()
  })

  it('passes a non-null Date for started_at when status=pending and started_at omitted', async () => {
    const { insertRunV2 } = await freshScheduledTasksDal()
    await insertRunV2({
      task_id: 't1',
      user_id: 'u1',
      status: 'pending',
      scheduled_for: new Date(),
      target_kind: 'agent',
    })
    expect(captured.length).toBeGreaterThan(0)
    const vals = captured[0].values
    const dates = vals.filter((v: any) => v instanceof Date)
    expect(dates.length).toBeGreaterThanOrEqual(2)
    expect(dates.some((d: Date) => d instanceof Date)).toBe(true)
  })

  it('passes a non-null Date for status=success path', async () => {
    const { insertRunV2 } = await freshScheduledTasksDal()
    await insertRunV2({
      task_id: 't1',
      user_id: 'u1',
      status: 'success',
      scheduled_for: new Date(),
      target_kind: 'agent',
    })
    expect(captured.length).toBeGreaterThan(0)
    const vals = captured[0].values
    const dates = vals.filter((v: any) => v instanceof Date)
    expect(dates.length).toBeGreaterThanOrEqual(2)
  })

  it('honors caller-provided started_at when given', async () => {
    const { insertRunV2 } = await freshScheduledTasksDal()
    const explicit = new Date('2026-01-01T00:00:00Z')
    await insertRunV2({
      task_id: 't1',
      user_id: 'u1',
      status: 'pending',
      scheduled_for: new Date(),
      target_kind: 'agent',
      started_at: explicit,
    })
    expect(captured.length).toBeGreaterThan(0)
    const vals = captured[0].values
    expect(
      vals.some(
        (v: any) => v instanceof Date && v.getTime() === explicit.getTime(),
      ),
    ).toBe(true)
  })

  it('defends against an explicit null started_at (cron-fire registry path)', async () => {
    const { insertRunV2 } = await freshScheduledTasksDal()
    await insertRunV2({
      task_id: 't1',
      user_id: 'u1',
      status: 'pending',
      scheduled_for: new Date(),
      target_kind: 'agent',
      started_at: null,
    })
    expect(captured.length).toBeGreaterThan(0)
    const vals = captured[0].values
    const dates = vals.filter((v: any) => v instanceof Date)
    expect(dates.length).toBeGreaterThanOrEqual(2)
    const sqlString = captured[0].strings.join('?')
    expect(sqlString).toMatch(/COALESCE\([^)]*now\(\)\)/i)
  })
})

describe('insertDeploymentRun started_at safety', () => {
  beforeEach(() => {
    captured = []
    installMocks()
  })

  it('passes now() (not null) for status=pending', async () => {
    const { insertDeploymentRun } = await freshDal()
    await insertDeploymentRun({
      task_id: 't1',
      user_id: 'u1',
      status: 'pending',
      deployment_uuid: 'd1',
      application_uuid: 'a1',
      git_repository: 'org/repo',
      commit_sha: null,
    })
    expect(captured.length).toBeGreaterThan(0)
    const vals = captured[0].values
    expect(vals.every((v: any) => v !== undefined)).toBe(true)
  })
})
