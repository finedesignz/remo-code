/**
 * PTYCAP-08-06 shared engine-test fixture (bounds + scope suites): a strict
 * recording fake plus row builders and the responders the read layer and the
 * safe-fix writer need. Not a test file; the suite does its own
 * mock.module('../src/db/postgres.ts', ...) with `fake.sql`.
 */
import { createTaskQcFakeSql } from './task-qc-fake-sql.ts'

export const USER = '00000000-0000-0000-0000-0000000000a1'
export const NOW = new Date('2026-10-13T12:00:00.000Z')

export const mk = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  user_id: USER,
  name: `Task ${id}`,
  task_type: 'dev',
  enabled: true,
  schedule_kind: 'cron',
  cron_expr: '0 3 * * *',
  cron_expression: '0 3 * * *',
  timezone: 'UTC',
  created_at: '2026-09-01T00:00:00.000Z',
  target_kind: 'session',
  target_id: 'live-1',
  session_id: 'live-1',
  prompt: `prompt-${id}`,
  payload: {},
  teab_repo_ident: null,
  last_fire_at: new Date(NOW.getTime() - 3_600_000).toISOString(),
  next_fire_at: new Date(NOW.getTime() + 3_600_000).toISOString(),
  ...over,
})

export const okRun = (taskId: string) => ({
  id: `ok-${taskId}`,
  task_id: taskId,
  status: 'success',
  error: null,
  started_at: new Date(NOW.getTime() - 3_600_000).toISOString(),
})

export const failRuns = (taskId: string, n: number) =>
  Array.from({ length: n }, (_, i) => ({
    id: `${taskId}-f${i}`,
    task_id: taskId,
    status: 'failed',
    error: 'boom',
    started_at: new Date(NOW.getTime() - (i + 1) * 3_600_000).toISOString(),
  }))

export function makeEngineWorld() {
  const fake = createTaskQcFakeSql()
  const world = {
    fake,
    store: {} as Record<string, any>,
    runs: [] as any[],
    sessions: [] as any[],
    live: [] as any[],
    siblings: [] as any[],
  }
  const reset = () => {
    fake.reset()
    world.store = {}
    world.runs = []
    world.sessions = [{ id: 'live-1', status: 'online', deleted_at: null, last_activity: null, created_at: null, repo_key: 'o/r' }]
    world.live = []
    world.siblings = []
    fake.onSelect(/FROM scheduled_tasks WHERE user_id/, () => Object.values(world.store))
    fake.onSelect(/ROW_NUMBER/, () => world.runs)
    fake.onSelect(/FROM sessions WHERE user_id = \? AND id = ANY/, () => world.sessions)
    fake.onSelect(/FROM sessions WHERE user_id = \? AND repo_key/, () => world.live)
    fake.onSelect(/FROM users/, () => [{ timezone: 'America/Los_Angeles' }])
    fake.onSelect(/FROM scheduled_tasks t/, () => world.siblings)
    fake.onSelect(/FROM scheduled_tasks WHERE id = \? AND user_id = \? FOR UPDATE/, (v) => (world.store[v[0]] ? [world.store[v[0]]] : []))
    fake.onSelect(/FROM sessions WHERE id = \? FOR UPDATE/, (v) => [{ id: v[0] }])
    fake.onSelect(/FROM scheduled_task_runs WHERE (task_id|session_id) = \? AND status IN/, () => [])
    fake.on(/^UPDATE scheduled_tasks SET timezone/, (v) => [{ timezone: v[0] }])
    fake.on(/^UPDATE scheduled_tasks SET payload/, (v) => [{ payload: { application_uuid: v[0] } }])
    fake.on(/^UPDATE scheduled_tasks SET session_id/, (v) => [{ session_id: v[1], target_id: v[3] }])
    fake.onInsert(/INSERT INTO task_qc_findings/, () => [{ id: `f-${fake.state.writes().length}` }])
  }
  reset()
  return { world, reset }
}

export const haltOk = async () => ({ halted: false })

export const baseDeps = (fake: { sql: any }, over: Record<string, unknown> = {}) => ({
  now: NOW,
  q: fake.sql,
  clock: () => NOW.getTime(),
  resolveAppUuid: async () => null,
  ...over,
})
