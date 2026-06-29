/**
 * Milestone TEAB — Phase TEAB-03 unit coverage.
 *
 * Asserts the `'teab'` task type is wired end-to-end at the type/auto-name layer:
 *   - it is a valid `TaskType` in both the DAL and the auto-name module (compile-
 *     time `satisfies` checks; the file would not typecheck otherwise),
 *   - `computeTaskAutoName` produces a human "TEAB Build" prefix for a teab task.
 *
 * Pure-logic only — no DB / socket (those live in the e2e suite). Run per-file
 * with `bun test test/teab-task-type.test.ts` from `hub/`.
 */
import { describe, expect, it } from 'bun:test'
import type { TaskType as DalTaskType } from '../src/db/scheduled-tasks-dal.ts'
import {
  computeTaskAutoName,
  type TaskType as NameTaskType,
  type TaskNameContext,
} from '../src/scheduler/auto-name.ts'

describe('TEAB task type', () => {
  it("'teab' is a valid DAL TaskType", () => {
    const t = 'teab' satisfies DalTaskType
    expect(t).toBe('teab')
  })

  it("'teab' is a valid auto-name TaskType", () => {
    const t = 'teab' satisfies NameTaskType
    expect(t).toBe('teab')
  })

  it('auto-name renders a "TEAB Build" label for a teab task', () => {
    const ctx: TaskNameContext = {
      sessions: [],
      supervisors: [{ id: 'sup-1', hostname: 'dev-box' }],
    }
    const name = computeTaskAutoName(
      { task_type: 'teab', target_kind: 'supervisor', target_id: 'sup-1', cron_expr: '0 3 * * *' },
      ctx,
    )
    expect(name).toContain('TEAB Build')
    expect(name).toContain('dev-box')
  })
})
