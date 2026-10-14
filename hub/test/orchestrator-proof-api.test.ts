/**
 * PTYCAP-05-04 Task 1: GET /api/orchestrator/proof. Read-only, tenant-scoped status of the
 * throwaway-repo proof. The proof DAL is leaf-mocked with a per-user store so the isolation
 * test is real: another user's run exists and must never be returned.
 */
import { describe, test, expect, mock, beforeEach, afterAll } from 'bun:test'
import { Hono } from 'hono'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const dalCalls: { fn: string; args: any[] }[] = []
let store: Record<string, any[]> = {}
let listThrows = false
let countThrows = false
let injectCount = 3

mock.module('../src/db/orchestrator-proof-dal.ts', () => ({
  listProofRunsForUser: async (userId: string, limit = 20) => {
    dalCalls.push({ fn: 'list', args: [userId, limit] })
    if (listThrows) throw new Error('db exploded: password=hunter2')
    return (store[userId] ?? []).slice(0, limit)
  },
  countProofInjects: async (counterKey: string, since: any) => {
    dalCalls.push({ fn: 'count', args: [counterKey, since] })
    if (countThrows) throw new Error('count boom')
    return injectCount
  },
}))

const { orchestratorProofApi } = await import('../src/api/orchestrator-proof.ts')

afterAll(() => {
  mock.restore()
})

function appAs(userId: string): Hono<any> {
  const app = new Hono<{ Variables: { userId: string } }>()
  app.use('*', async (c, next) => {
    c.set('userId', userId)
    await next()
  })
  app.route('/api/orchestrator/proof', orchestratorProofApi)
  return app
}

function runRow(over: Record<string, unknown> = {}): any {
  return {
    id: 'run-1',
    user_id: 'u1',
    task_id: 'task-1',
    session_id: 'sess-1',
    repo_ident: 'github://acme/throwaway',
    counter_key: 'ck-secret-internal',
    branch: 'proof/abc',
    installation_id: 987654321,
    repo_owner: 'acme',
    repo_name: 'throwaway',
    default_branch: 'main',
    base_sha: 'deadbeef',
    ruleset_ids: [111, 222],
    ruleset_digest: '0123456789abcdef0123456789abcdef',
    ruleset_updated_at: '2026-10-01T00:00:00Z',
    protection_shape: 'branch_lock',
    required_contexts: ['ci'],
    arm_preconditions: { bypass_verification: 'verified', agent_permission: 'verified', secret: 'nope' },
    max_injects: 4,
    max_tokens: '1000000',
    max_wall_ms: '3600000',
    status: 'running',
    outcome: null,
    outcome_detail: null,
    pr_url: 'https://github.com/acme/throwaway/pull/1',
    pr_number: 1,
    last_ci_state: 'success',
    last_inject_outcome: 'dispatched',
    tokens_hwm: '12345',
    armed_at: '2026-10-12T00:00:00Z',
    updated_at: '2026-10-12T01:00:00Z',
    started_at: '2026-10-12T00:30:00Z',
    terminal_at: null,
    ...over,
  }
}

beforeEach(() => {
  dalCalls.length = 0
  store = {}
  listThrows = false
  countThrows = false
  injectCount = 3
})

describe('GET /api/orchestrator/proof', () => {
  test('no rows -> {run:null, history:[]}', async () => {
    const res = await appAs('u1').request('/api/orchestrator/proof')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ run: null, history: [] })
  })

  test('latest run plus up to 5 prior runs; asks DAL for 6', async () => {
    store.u1 = Array.from({ length: 8 }, (_, i) => runRow({ id: `run-${i}` }))
    const res = await appAs('u1').request('/api/orchestrator/proof')
    const body: any = await res.json()
    expect(body.run.id).toBe('run-0')
    expect(body.history.map((r: any) => r.id)).toEqual(['run-1', 'run-2', 'run-3', 'run-4', 'run-5'])
    expect(dalCalls.find((c) => c.fn === 'list')!.args).toEqual(['u1', 6])
  })

  test('allowlisted field mapping, no credential / internal fields', async () => {
    store.u1 = [runRow()]
    const res = await appAs('u1').request('/api/orchestrator/proof')
    const run = ((await res.json()) as any).run
    expect(run).toEqual({
      id: 'run-1',
      status: 'running',
      outcome: null,
      outcome_detail: null,
      repo_ident: 'github://acme/throwaway',
      branch: 'proof/abc',
      base_sha: 'deadbeef',
      default_branch: 'main',
      pr_url: 'https://github.com/acme/throwaway/pull/1',
      pr_number: 1,
      last_ci_state: 'success',
      last_inject_outcome: 'dispatched',
      protection_shape: 'branch_lock',
      ruleset_digest: '0123456789ab',
      budgets: { max_injects: 4, max_tokens: 1000000, max_wall_ms: 3600000 },
      usage: { injects: 3, tokens_hwm: 12345 },
      bypass_verification: 'verified',
      armed_at: '2026-10-12T00:00:00Z',
      started_at: '2026-10-12T00:30:00Z',
      terminal_at: null,
    })
    const raw = JSON.stringify(run)
    for (const k of ['installation_id', 'ruleset_ids', 'arm_preconditions', 'counter_key', 'ck-secret-internal', '987654321', 'secret']) {
      expect(raw).not.toContain(k)
    }
  })

  test('bypass_verification is unverified unless arm_preconditions says verified', async () => {
    store.u1 = [runRow({ arm_preconditions: {} }), runRow({ id: 'b', arm_preconditions: { bypass_verification: 'maybe' } })]
    const body: any = await (await appAs('u1').request('/api/orchestrator/proof')).json()
    expect(body.run.bypass_verification).toBe('unverified')
    expect(body.history[0].bypass_verification).toBe('unverified')
  })

  test('usage.injects counts since started_at, else armed_at, only for the active counter key', async () => {
    store.u1 = [runRow()]
    await appAs('u1').request('/api/orchestrator/proof')
    expect(dalCalls.find((c) => c.fn === 'count')!.args).toEqual(['ck-secret-internal', '2026-10-12T00:30:00Z'])
    dalCalls.length = 0
    store.u1 = [runRow({ started_at: null })]
    await appAs('u1').request('/api/orchestrator/proof')
    expect(dalCalls.find((c) => c.fn === 'count')!.args).toEqual(['ck-secret-internal', '2026-10-12T00:00:00Z'])
  })

  test('inject count failure yields usage.injects null, not a failed response', async () => {
    store.u1 = [runRow()]
    countThrows = true
    const res = await appAs('u1').request('/api/orchestrator/proof')
    expect(res.status).toBe(200)
    expect(((await res.json()) as any).run.usage).toEqual({ injects: null, tokens_hwm: 12345 })
  })

  test('tenancy: another user rows are never returned; user_id query/header ignored', async () => {
    store.u2 = [runRow({ id: 'other-run', user_id: 'u2' })]
    store.u1 = [runRow({ id: 'mine' })]
    const res = await appAs('u1').request('/api/orchestrator/proof?user_id=u2', { headers: { 'x-user-id': 'u2' } })
    const body: any = await res.json()
    expect(body.run.id).toBe('mine')
    expect(JSON.stringify(body)).not.toContain('other-run')
    expect(dalCalls.filter((c) => c.fn === 'list').every((c) => c.args[0] === 'u1')).toBe(true)

    store.u1 = []
    const empty: any = await (await appAs('u1').request('/api/orchestrator/proof?user_id=u2')).json()
    expect(empty).toEqual({ run: null, history: [] })
  })

  test('DB failure -> 500 {error:internal} with no message leak', async () => {
    listThrows = true
    const res = await appAs('u1').request('/api/orchestrator/proof')
    expect(res.status).toBe(500)
    const text = await res.text()
    expect(JSON.parse(text)).toEqual({ error: 'internal' })
    expect(text).not.toContain('hunter2')
  })

  test('no mutating method is registered (POST/PUT/PATCH/DELETE are not 2xx)', async () => {
    const app = appAs('u1')
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const res = await app.request('/api/orchestrator/proof', { method })
      expect(res.status === 404 || res.status === 405).toBe(true)
    }
  })

  test('source has no mutating handlers', () => {
    const src = readFileSync(join(import.meta.dir, '../src/api/orchestrator-proof.ts'), 'utf8')
    expect(/\.(post|put|patch|delete)\(/.test(src)).toBe(false)
  })
})
