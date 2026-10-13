/**
 * PTYCAP-04 QC m2: countFiresForTask must not count kill-switch-halted skips toward a task's
 * `max_runs`. The behavioral proof of the filter is the real-Postgres check (13) in
 * test/e2e/automation-controls-checks.ts; this DB-free test pins the shape of the query the
 * dispatcher actually issues (it excludes ONLY skipped rows whose error starts with the
 * stable halt prefix, and still scopes by task id).
 */
import { describe, test, expect, mock, afterAll } from 'bun:test'

process.env.JWT_SECRET = process.env.JWT_SECRET || 'x'.repeat(32)
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://localhost:5432/placeholder'

const seen: Array<{ text: string; values: unknown[] }> = []
mock.module('../src/db/postgres.ts', () => ({
  sql: async (strings: TemplateStringsArray, ...values: unknown[]) => {
    seen.push({ text: strings.join('?'), values })
    return [{ n: '7' }]
  },
}))
afterAll(() => mock.restore())

const { countFiresForTask } = await import('../src/db/scheduled-tasks-dal.ts')

describe('countFiresForTask halt exclusion', () => {
  test('excludes skipped rows with the automation_halted: error prefix, nothing else, scoped to the task', async () => {
    const n = await countFiresForTask('task-1')
    expect(n).toBe(7)
    const q = seen[0]!
    expect(q.values).toEqual(['task-1'])
    expect(q.text).toContain("'automation_halted:'")
    expect(q.text).toContain("status = 'skipped'")
    expect(q.text).toContain('starts_with(')
    expect(q.text).toContain('NOT (')
  })
})
