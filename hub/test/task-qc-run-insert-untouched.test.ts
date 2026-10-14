/**
 * PTYCAP-08 QC round 2 (codex new MAJOR 1): flag-OFF true no-op. Task QC may add NO work to
 * an ordinary scheduled_task_runs insert: no trigger, no advisory lock, no extra statement.
 * The in-flight atomicity lives entirely on the task-QC writer side (row locks the writer
 * takes itself), so the run-insert SQL must be exactly the pre-feature statement.
 */
import { afterAll, describe, expect, mock, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createTaskQcFakeSql } from './fixtures/task-qc-fake-sql.ts'

const fake = createTaskQcFakeSql()
mock.module('../src/db/postgres.ts', () => ({ sql: fake.sql }))
afterAll(() => {
  mock.restore()
})

const { insertRunV2 } = (await import(`../src/db/scheduled-tasks-dal.ts?runinsert=${Date.now()}`)) as typeof import('../src/db/scheduled-tasks-dal.ts')

// The statement as it stood before PTYCAP-08, whitespace-normalised by the fake (placeholders are `?`).
const BASE_INSERT_RUN_V2 =
  'INSERT INTO scheduled_task_runs ( task_id, user_id, session_id, status, error, scheduled_for, target_kind, target_id, triggered_by_run_id, started_at, finished_at, output_snippet ) VALUES ( ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, now()), ?, ? ) RETURNING *'

describe('run insertion is untouched by Task QC', () => {
  test('insertRunV2 issues exactly one statement, byte-identical to the pre-feature SQL, for session-bound and null-session runs', async () => {
    for (const sessionId of ['s1', null]) {
      fake.reset()
      fake.on('INSERT INTO scheduled_task_runs', [{ id: 'r1' }])
      await insertRunV2({
        task_id: 't1',
        user_id: 'u1',
        status: 'pending',
        scheduled_for: new Date(),
        target_kind: sessionId ? 'session' : 'agent',
        target_id: sessionId,
        session_id: sessionId,
      } as any)
      expect(fake.state.statements.map((s) => s.text)).toEqual([BASE_INSERT_RUN_V2])
      expect(fake.state.lockCalls).toBe(0)
      expect(fake.state.beginCalls).toBe(0)
      fake.assertNoUnknown()
    }
  })

  test('no source file that inserts a run takes an advisory lock, and the schema attaches nothing to scheduled_task_runs', () => {
    const root = join(import.meta.dir, '..', 'src')
    for (const f of ['db/scheduled-tasks-dal.ts', 'db/dal.ts']) {
      const src = readFileSync(join(root, f), 'utf8')
      expect(src).not.toMatch(/pg_advisory|session_lock|taskqc-session/i)
    }
    const schema = readFileSync(join(root, 'db', 'schema.sql'), 'utf8')
    expect(schema).not.toMatch(/CREATE (OR REPLACE )?(CONSTRAINT )?TRIGGER[^;]*scheduled_task_runs/i)
  })
})
