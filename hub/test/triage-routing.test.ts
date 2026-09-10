/**
 * fix/sched-triage-routing — triage must reach a LIVE LOCAL-AGENT session, and
 * must fail FAST when there is none.
 *
 * Prod evidence: 31/32 `__internal_triage` runs finalized `failed/triage_timeout`
 * at ~878s with `session_id` NULL on every row. `pickSessionTarget` prefers an
 * online supervisor over a local agent, and the supervisor branch parked a waiter
 * keyed by the SUPERVISOR RUN id while the only reader (ws/agent.ts) looks it up
 * by SESSION id — unreachable by construction, so every run aged out at the 15min
 * sweep. The supervisor branch is gone; these tests lock in the replacement.
 */
import { describe, it, expect, mock, beforeEach } from 'bun:test'

const finalized: Array<{ runId: string; status: string; error: string | null }> = []
mock.module('../src/scheduler/dispatcher.ts', () => ({
  finalizeRun: async (runId: string, status: string, error: string | null) => {
    finalized.push({ runId, status, error })
  },
  removeRunContext: () => {},
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

const dispatched: Array<{ sessionId: string; token: string }> = []
mock.module('../src/dispatch/pipeline.ts', () => ({
  dispatch: async (req: any) => {
    dispatched.push({ sessionId: req.sessionId, token: req.token })
    return { kind: 'sent' }
  },
}))

// A supervisor spawn would have to go through these — they must never be called.
let supervisorSends = 0
mock.module('../src/ws/supervisor-registry.ts', () => ({
  sendToSupervisor: () => { supervisorSends++ },
  updateSupervisorState: async () => { supervisorSends++ },
  isSupervisorOnline: () => true,
}))

const { sendTriage } = await import('../src/scheduler/senders/triage.ts')

const task = { id: 'task-1', name: 'triage' } as any
const ctx = { runId: 'run-1', taskId: 'task-1', userId: 'user-1' }
const payload = {
  application_uuid: 'app-1',
  deployment_uuid: 'dep-1',
  git_repository: 'owner/repo',
  commit_sha: 'abc123',
  log_snippet: 'boom',
}

describe('sendTriage routing (fix/sched-triage-routing)', () => {
  beforeEach(() => {
    finalized.length = 0
    dispatched.length = 0
    repoKeyed = null
    onlineSessions = []
    supervisorSends = 0
  })

  it('routes to the repo-keyed agent session when one exists', async () => {
    repoKeyed = { agent_session_id: 'sess-repo', repo_key: 'owner/repo' }
    onlineSessions = ['sess-repo', 'sess-other']
    await sendTriage(task, ctx, payload)
    expect(dispatched).toEqual([{ sessionId: 'sess-repo', token: 'run-1' }])
    expect(finalized).toEqual([])
  })

  it('falls back to any online agent session', async () => {
    onlineSessions = ['sess-a', 'sess-b']
    await sendTriage(task, ctx, payload)
    expect(dispatched).toEqual([{ sessionId: 'sess-a', token: 'run-1' }])
  })

  it('finalizes IMMEDIATELY as no_target_available when no agent session is online', async () => {
    onlineSessions = []
    await sendTriage(task, ctx, payload)
    expect(finalized).toEqual([{ runId: 'run-1', status: 'failed', error: 'no_target_available' }])
    expect(dispatched).toEqual([])
  })

  it('never spawns a supervisor session (the unroutable path)', async () => {
    onlineSessions = []
    await sendTriage(task, ctx, payload)
    onlineSessions = ['sess-a']
    await sendTriage(task, ctx, payload)
    expect(supervisorSends).toBe(0)
  })
})
