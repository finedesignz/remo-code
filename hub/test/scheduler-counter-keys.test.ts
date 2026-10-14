/**
 * PTYCAP-04-03 Task 3: scheduler agent + triage senders carry their lifetime counter
 * key and both machine gates. DB-free: dispatch is a spy (mock.module on pipeline.ts),
 * automation-controls is the REAL module (only its gate objects are inspected).
 */
import { describe, it, expect, mock, beforeEach, afterAll } from 'bun:test'

const finalized: Array<{ runId: string; status: string; error: string | null }> = []
mock.module('../src/scheduler/dispatcher.ts', () => ({
  finalizeRun: async (runId: string, status: string, error: string | null) => {
    finalized.push({ runId, status, error })
  },
  removeRunContext: () => {},
  getRunContext: () => null,
}))
mock.module('../src/db/postgres.ts', () => ({ sql: async () => [] }))
mock.module('../src/db/dal.ts', () => ({
  insertMessage: async () => ({ id: 'm1', created_at: '' }),
}))
mock.module('../src/scheduler/context/runtime-context.ts', () => ({
  buildRuntimeContext: async () => ({}),
  renderRuntimeContextBlock: () => '## RUNTIME CONTEXT',
}))
mock.module('../src/telegram/launch.ts', () => ({
  launchSessionForUser: async () => ({ ok: false, reason: 'no_online_supervisor' }),
}))
let repoKeyed: { agent_session_id: string; repo_key: string } | null = null
mock.module('../src/sessions/repo-routing.ts', () => ({
  resolveRepoKeyedAgentSession: async () => repoKeyed,
}))
let onlineSessions: string[] = []
mock.module('../src/ws/registry.ts', () => ({
  listOnlineAgentSessionsForUser: () => onlineSessions,
  getChannel: (sid: string) => (onlineSessions.includes(sid) ? ({ ws: { send() {} } } as any) : null),
  broadcastToSubscribers: () => {},
}))
// Real gates.ts pulls DAL/usage modules; only the NAMES and order matter here.
const passGate = (name: string) => ({ name, async check() { return { ok: true } } })
mock.module('../src/dispatch/gates.ts', () => ({
  thresholdGate: passGate('threshold'),
  dailyCostCapGate: passGate('daily_cost_cap'),
  dailyTokenCapGate: passGate('daily_token_cap'),
}))
const dispatched: Array<{ req: any; deps: any }> = []
mock.module('../src/dispatch/pipeline.ts', () => ({
  dispatch: async (req: any, deps: any) => {
    dispatched.push({ req, deps })
    return { kind: 'dispatched' }
  },
}))

const controls = await import('../src/dispatch/automation-controls.ts')
const { sendAgentTask } = await import('../src/scheduler/senders/agent.ts')
const { sendTriage } = await import('../src/scheduler/senders/triage.ts')

afterAll(() => mock.restore())

const EXPECTED = ['automation_kill_switch', 'threshold', 'daily_cost_cap', 'daily_token_cap', 'lifetime_counter']

const agentTask = { id: 'task-42', name: 'Nightly', task_type: 'dev', prompt: 'Continue.', payload: {} } as any
const agentCtx = (over: any = {}) => ({
  runId: 'run-1',
  taskId: 'task-42',
  userId: 'user-1',
  target: { sessionId: 'sess-1' },
  ...over,
})
const triageTask = { id: 'triage-task', name: 'triage' } as any
const triageCtx = { runId: 'run-9', taskId: 'triage-task', userId: 'user-1' }
const payload = (uuid: string) => ({
  application_uuid: uuid,
  deployment_uuid: 'dep-1',
  git_repository: 'owner/repo',
  commit_sha: 'abc',
  log_snippet: 'boom',
})

beforeEach(() => {
  finalized.length = 0
  dispatched.length = 0
  repoKeyed = null
  onlineSessions = ['sess-1']
})

describe('sendAgentTask counter key + gates (D-01, D-05, D-08)', () => {
  it('counterKey = task:<task.id>; kill switch first, lifetime counter last, three existing unchanged', async () => {
    await sendAgentTask(agentTask, agentCtx())
    expect(dispatched).toHaveLength(1)
    expect(dispatched[0].req.counterKey).toBe('task:task-42')
    const gates = dispatched[0].deps.gates
    expect(gates.map((g: any) => g.name)).toEqual(EXPECTED)
    expect(gates[0]).toBe(controls.automationKillSwitchGate)
    expect(gates[gates.length - 1]).toBe(controls.automationLifetimeCounterGate)
  })

  it('manual Run Now carries the same key (same sender as cron)', async () => {
    await sendAgentTask(agentTask, agentCtx({ isManual: true }))
    expect(dispatched[0].req.counterKey).toBe('task:task-42')
  })

  it('lifetime exhaustion finalizes the run as skipped (not failed, not skipped_quota)', async () => {
    await sendAgentTask(agentTask, agentCtx())
    await dispatched[0].deps.store.markSkipped('run-1', 'lifetime_inject_exhausted:1000>=1000')
    expect(finalized).toEqual([{ runId: 'run-1', status: 'skipped', error: 'lifetime_inject_exhausted:1000>=1000' }])
  })
})

describe('sendTriage counter key + gates (panel F-5b)', () => {
  it('repo-keyed branch: counterKey = triage:<application_uuid>', async () => {
    repoKeyed = { agent_session_id: 'sess-repo', repo_key: 'owner/repo' }
    onlineSessions = ['sess-repo']
    await sendTriage(triageTask, triageCtx, payload('app-A'))
    expect(dispatched).toHaveLength(1)
    expect(dispatched[0].req.sessionId).toBe('sess-repo')
    expect(dispatched[0].req.counterKey).toBe('triage:app-A')
  })

  it('capacity-fallback branch: counterKey = triage:<application_uuid>', async () => {
    onlineSessions = ['sess-x']
    await sendTriage(triageTask, triageCtx, payload('app-B'))
    expect(dispatched[0].req.sessionId).toBe('sess-x')
    expect(dispatched[0].req.counterKey).toBe('triage:app-B')
  })

  it('two different applications produce two different keys', async () => {
    onlineSessions = ['sess-x']
    await sendTriage(triageTask, triageCtx, payload('app-A'))
    await sendTriage(triageTask, triageCtx, payload('app-B'))
    expect(dispatched[0].req.counterKey).not.toBe(dispatched[1].req.counterKey)
  })

  it('gate list: kill switch first, lifetime counter last, existing three between', async () => {
    onlineSessions = ['sess-x']
    await sendTriage(triageTask, triageCtx, payload('app-A'))
    const gates = dispatched[0].deps.gates
    expect(gates.map((g: any) => g.name)).toEqual(EXPECTED)
    expect(gates[0]).toBe(controls.automationKillSwitchGate)
    expect(gates[gates.length - 1]).toBe(controls.automationLifetimeCounterGate)
  })

  it('lifetime exhaustion finalizes the run as skipped (not failed, not skipped_quota)', async () => {
    onlineSessions = ['sess-x']
    await sendTriage(triageTask, triageCtx, payload('app-A'))
    await dispatched[0].deps.store.markSkipped('run-9', 'lifetime_inject_exhausted:5>=5')
    expect(finalized).toEqual([{ runId: 'run-9', status: 'skipped', error: 'lifetime_inject_exhausted:5>=5' }])
  })
})
