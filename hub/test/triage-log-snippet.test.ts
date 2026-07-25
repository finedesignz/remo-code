/**
 * fix/triage-log-snippet — the triage prompt must carry the failing deployment's
 * real logs. dispatchTriage used to hand the model `log_snippet: ''`.
 */
import { describe, it, expect, mock } from 'bun:test'

const realDal = await import('../src/db/dal.ts')
mock.module('../src/db/dal.ts', () => ({
  ...realDal,
  claimDeployFailure: async () => true,
  ensureInternalTriageTask: async () => 'triage-task-id',
}))

let lastPayload: any = null
mock.module('../src/scheduler/dispatcher.ts', () => ({
  runNow: async (_taskId: string, _userId: string, opts: any) => {
    lastPayload = opts.payloadOverride
    return 'run-x'
  },
  finalizeRun: async () => {},
}))

mock.module('../src/sessions/repo-routing.ts', () => ({
  resolveRepoKeyedAgentSession: async () => ({ agent_session_id: 's1', repo_key: 'o/r' }),
  hasActiveSessionForRepo: async () => true,
}))

const { fetchTriageLogSnippet, dispatchTriage, TRIAGE_LOG_SNIPPET_MAX } = await import(
  '../src/api/coolify-webhook.ts'
)

const cfg = { token: 't', baseUrl: 'https://coolify.example' }

describe('fetchTriageLogSnippet', () => {
  it('returns the log text when the fetch succeeds', async () => {
    const out = await fetchTriageLogSnippet('app-1', {
      config: () => cfg,
      fetchLogs: async () => ({ ok: true, status: 200, logs: 'boom: build failed' }),
    })
    expect(out).toBe('boom: build failed')
  })

  it('caps to the TAIL of the log (the failure lives at the end)', async () => {
    const logs = 'x'.repeat(TRIAGE_LOG_SNIPPET_MAX) + 'THE-ACTUAL-ERROR'
    const out = await fetchTriageLogSnippet('app-1', {
      config: () => cfg,
      fetchLogs: async () => ({ ok: true, status: 200, logs }),
    })
    expect(out.length).toBe(TRIAGE_LOG_SNIPPET_MAX)
    expect(out.endsWith('THE-ACTUAL-ERROR')).toBe(true)
  })

  it('marks an unconfigured Coolify explicitly (never a silent empty string)', async () => {
    const out = await fetchTriageLogSnippet('app-1', { config: () => null })
    expect(out).toBe('[log_fetch_failed: COOLIFY_TOKEN unset]')
  })

  it('marks a failed fetch explicitly', async () => {
    const out = await fetchTriageLogSnippet('app-1', {
      config: () => cfg,
      fetchLogs: async () => ({ ok: false, status: 401, logs: '', detail: 'Unauthenticated.' }),
    })
    expect(out).toContain('log_fetch_failed')
    expect(out).toContain('401')
  })

  it('marks an empty log body explicitly', async () => {
    const out = await fetchTriageLogSnippet('app-1', {
      config: () => cfg,
      fetchLogs: async () => ({ ok: true, status: 200, logs: '' }),
    })
    expect(out).toBe('[log_fetch_failed: empty log body]')
  })
})

describe('dispatchTriage log_snippet', () => {
  it('never dispatches an empty log_snippet', async () => {
    lastPayload = null
    await dispatchTriage('user-1', 'run-1', {
      event: 'deployment.failed',
      application_uuid: 'app-1',
      deployment_uuid: 'dep-1',
      git_repository: 'o/r',
      commit_sha: 'sha-1',
    } as any)
    expect(lastPayload).not.toBeNull()
    expect(lastPayload.log_snippet.length).toBeGreaterThan(0)
  })
})
