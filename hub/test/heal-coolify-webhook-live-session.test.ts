/**
 * PTYCAP-07 QC round 1 (codex #1): with REMO_HEAL_UNIFIED ON the Coolify webhook must hand a
 * failed deployment to the unified heal path EVEN WHEN a live dev session exists on the repo.
 * The legacy active-session suppression branch left the metadata run `pending` and never reached
 * routeHeal, so live-session-first routing was defeated. Flag OFF keeps the legacy suppression
 * exactly (covered in coolify-webhook.test.ts); a second case here pins that too.
 *
 * HTTP-level: drives the real handler through the Hono route. routeHeal itself (which
 * terminalizes the run) is replaced by a recorder; its terminalization is proven by the
 * heal-route-* tests.
 */
import { describe, test, expect, beforeAll, beforeEach, afterEach, mock } from 'bun:test'
import { Hono } from 'hono'

const TEST_USER_ID = '11111111-1111-1111-1111-111111111111'
const TEST_SECRET = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'

const state: {
  hasActiveSession: boolean
  runs: any[]
  attempts: any[]
  routeCalls: any[]
  legacyDispatches: any[]
} = { hasActiveSession: true, runs: [], attempts: [], routeCalls: [], legacyDispatches: [] }

const realDal = await import(`../src/db/dal.ts?real=${Date.now()}`)
mock.module('../src/db/dal.ts', () => ({
  ...realDal,
  getUserCoolifyWebhookConfig: async () => ({
    secret: TEST_SECRET,
    allowedIps: [],
    autoTriageEnabled: true,
  }),
  claimDeployFailure: async () => true,
  ensureInternalDeploymentTask: async () => 'task-internal-deploy',
  ensureInternalTriageTask: async () => 'task-internal-triage',
  insertDeploymentRun: async (input: any) => {
    const row = { id: 'run-' + (state.runs.length + 1), ...input }
    state.runs.push(row)
    return row
  },
  recordCoolifyWebhookAttempt: async (input: any) => {
    state.attempts.push(input)
  },
}))

mock.module('../src/scheduler/dispatcher.ts', () => ({
  runNow: async (taskId: string, userId: string, opts: any) => {
    state.legacyDispatches.push({ taskId, userId, opts })
    return { skipped: false }
  },
  finalizeRun: async () => {},
}))

mock.module('../src/sessions/repo-routing.ts', () => ({
  hasActiveSessionForRepo: async () => state.hasActiveSession,
  resolveRepoKeyedAgentSession: async () => null,
}))

const realReg = await import(`../src/ws/registry.ts?real=${Date.now()}`)
mock.module('../src/ws/registry.ts', () => ({
  ...realReg,
  listOnlineAgentSessionsForUser: () => ['sess-live'],
}))
const realSupReg = await import(`../src/ws/supervisor-registry.ts?real=${Date.now()}`)
mock.module('../src/ws/supervisor-registry.ts', () => ({
  ...realSupReg,
  listOnlineSupervisorIdsForUser: () => [],
}))

mock.module('../src/heal/sources/coolify.ts', () => ({
  buildCoolifyHealEvent: async (userId: string, runId: string) => ({
    source: 'coolify',
    user_id: userId,
    trigger_run_id: runId,
  }),
}))
mock.module('../src/heal/route.ts', () => ({
  routeHeal: async (event: any) => {
    state.routeCalls.push(event)
    return { kind: 'dispatched' }
  },
}))

let app: Hono
const prevFlag = process.env.REMO_HEAL_UNIFIED

beforeAll(async () => {
  const mod = await import('../src/api/coolify-webhook.ts')
  app = new Hono()
  app.route('/api/coolify', mod.coolifyWebhookRoutes)
})

beforeEach(() => {
  state.hasActiveSession = true
  state.runs.length = 0
  state.attempts.length = 0
  state.routeCalls.length = 0
  state.legacyDispatches.length = 0
})

afterEach(() => {
  if (prevFlag === undefined) delete process.env.REMO_HEAL_UNIFIED
  else process.env.REMO_HEAL_UNIFIED = prevFlag
})

const failedBody = JSON.stringify({
  event: 'deployment.failed',
  deployment_uuid: 'depl-1',
  application_uuid: 'app-1',
  git_repository: 'https://github.com/x/y',
  commit_sha: 'abc123',
})

async function post() {
  const res = await app.request(`/api/coolify/webhook/${TEST_USER_ID}/${TEST_SECRET}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: failedBody,
  })
  await new Promise((r) => setTimeout(r, 20)) // let the fire-and-forget dispatch settle
  return res
}

describe('coolify webhook x live session x REMO_HEAL_UNIFIED', () => {
  test('flag ON + live session on the repo -> routed through routeHeal, NOT suppressed', async () => {
    process.env.REMO_HEAL_UNIFIED = '1'
    const res = await post()
    expect(res.status).toBe(202)
    expect(state.runs.length).toBe(1)
    expect(state.routeCalls.length).toBe(1)
    expect(state.routeCalls[0].trigger_run_id).toBe(state.runs[0].id)
    const audit = state.attempts.find((a) => a.status === 'success')
    expect(audit?.reason).not.toContain('suppressed_active_dev_session')
  })

  test('flag OFF + live session -> legacy suppression unchanged (no dispatch, audit marker)', async () => {
    delete process.env.REMO_HEAL_UNIFIED
    const res = await post()
    expect(res.status).toBe(202)
    expect(state.routeCalls.length).toBe(0)
    expect(state.legacyDispatches.length).toBe(0)
    const audit = state.attempts.find((a) => a.status === 'success')
    expect(audit?.reason).toContain('skipped=suppressed_active_dev_session')
  })
})
