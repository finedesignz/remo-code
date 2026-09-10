/**
 * Milestone once — /api/ext/work must NOT leave a phantom 'queued' work_runs row
 * when the one-time-task enqueue fails (ai-review finding #2).
 *
 * If `createTaskV2` throws AFTER the work_runs row is inserted, the route must
 * finalize that row to a terminal 'failed' state and return 502 — never a 201/202
 * with a 'queued' row that nothing drives. Proven by driving the real route with
 * `createTaskV2` mocked to throw.
 *
 * Bun mock hygiene (feedback_bun_mock_pollution): afterAll(mock.restore); the QC
 * gate runs each file in its own process.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-chars-long-aaaaaaaa'

import { describe, test, expect, afterAll, mock } from 'bun:test'
import { Hono } from 'hono'

const state = {
  finalizeCalls: [] as Array<{ workId: string; status: string; reason: string | undefined }>,
  createShouldThrow: true,
  registered: [] as string[],
}

const TARGET = {
  id: 'sess-1', name: 'site', project_dir: '/repos/site', runner_type: 'stream-json',
  status: 'online', hostname: 'box', repo_key: null, github_owner: 'acme', github_repo: 'site',
  last_activity: null,
}

// resolveSession issues a bare `sql` SELECT over sessions — return the target.
mock.module('../src/db/postgres.ts', () => ({
  sql: async () => [TARGET],
}))

mock.module('../src/db/work-dal.ts', () => ({
  isRepoWorkAllowed: async () => true,
  findWorkSite: async () => ({
    id: 'site-1', user_id: 'u1', repo_ident: 'github://acme/site', site_key: 'clientco',
    site_dir: 'sites/clientco', client_emails: ['owner@clientco.com'], auto_publish: false,
    default_branch: 'main',
  }),
  isKnownSender: () => true,
  insertWorkRun: async () => ({ id: 'work-1', status: 'queued' }),
  getWorkRun: async () => ({ id: 'work-1', status: 'failed' }),
  finalizeWork: async (workId: string, status: string, patch: any) => {
    state.finalizeCalls.push({ workId, status, reason: patch?.reason })
  },
}))

mock.module('../src/ask/dispatch.ts', () => ({
  findAskSession: async () => ({ id: 'work-sess', name: 's', project_dir: '/repos/site', runner_type: 'stream-json', status: 'online', hostname: 'box', is_orchestrator: false }),
  dispatchAsk: async () => ({ kind: 'dispatched' }),
}))

const realSupReg = await import('../src/ws/supervisor-registry.ts')
mock.module('../src/ws/supervisor-registry.ts', () => ({
  ...realSupReg,
  findSupervisorForSession: () => ({ userId: 'u1', supervisorId: 'sup-1' }),
  listOnlineSupervisorIdsForUser: () => ['sup-1'],
}))

mock.module('../src/ws/registry.ts', () => ({
  getChannel: () => ({ ws: { send: () => {} } }),
}))

// The failure under test: enqueue throws.
mock.module('../src/db/scheduled-tasks-dal.ts', () => ({
  createTaskV2: async () => { if (state.createShouldThrow) throw new Error('db insert failed'); return { id: 'task-1' } },
}))

mock.module('../src/scheduler/registry.ts', () => ({
  register: (t: any) => { state.registered.push(t.id) },
}))

const { ext } = await import('../src/api/ext.ts')

const app = new Hono()
app.use('*', async (c, next) => { c.set('userId', 'u1'); c.set('apiKeyId', 'k1'); await next() })
app.route('/api/ext', ext)

function postWork() {
  return app.request('/api/ext/work', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      repo: 'github://acme/site', site: 'clientco', request_text: 'change the headline',
      source: { kind: 'email', from: 'owner@clientco.com' },
    }),
  })
}

afterAll(() => mock.restore())

describe('/api/ext/work enqueue failure', () => {
  test('createTaskV2 throwing → 502 AND the work_runs row is finalized failed (no phantom queued)', async () => {
    state.finalizeCalls = []
    state.createShouldThrow = true
    const res = await postWork()
    expect(res.status).toBe(502)
    const body = await res.json()
    expect(body.error).toBe('enqueue_failed')
    expect(body.work_id).toBe('work-1')
    // The work run was driven to terminal 'failed' — never left 'queued'.
    expect(state.finalizeCalls).toHaveLength(1)
    expect(state.finalizeCalls[0]).toMatchObject({ workId: 'work-1', status: 'failed' })
    expect(state.finalizeCalls[0].reason).toContain('enqueue_failed')
  })

  test('happy enqueue → 202, registered, no failed-finalize', async () => {
    state.finalizeCalls = []
    state.registered = []
    state.createShouldThrow = false
    const res = await postWork()
    expect(res.status).toBe(202)
    expect(state.registered).toEqual(['task-1'])
    expect(state.finalizeCalls).toHaveLength(0)
  })
})
