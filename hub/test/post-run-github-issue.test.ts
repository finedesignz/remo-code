/**
 * Tests for the github_issue post-run action (Plan 06-007).
 *
 * Strategy:
 *   - mock.module('../src/db/dal.ts') for the idempotency helpers + getRun
 *   - mock.module('@octokit/rest') for issues.create
 *   - Stub global fetch for the gateway credential lookup
 *   - Run executeGithubIssue twice and assert Octokit was invoked once,
 *     proving idempotency.
 *
 * The DB-backed e2e of hasOpenIssueForHash / recordOpenIssueForHash lives in
 * scheduled-tasks.e2e.test.ts (REMO_E2E_DB_URL gated, future plan).
 */
import { describe, test, expect, beforeEach, mock } from 'bun:test'

// ── In-memory idempotency store (mocked DAL) ────────────────────────────────
const idempotencyStore = new Map<string, { issueNumber: number; repo: string; createdAt: number }>()

mock.module('../src/db/dal.ts', () => ({
  hasOpenIssueForHash: async (userId: string, hash: string, _windowHours: number) => {
    const key = `${userId}|${hash}`
    const row = idempotencyStore.get(key)
    return !!row
  },
  recordOpenIssueForHash: async (userId: string, hash: string, issueNumber: number, repo: string) => {
    const key = `${userId}|${hash}`
    if (!idempotencyStore.has(key)) {
      idempotencyStore.set(key, { issueNumber, repo, createdAt: Date.now() })
    }
  },
}))

mock.module('../src/db/scheduled-tasks-dal.ts', () => ({
  getRun: async (_runId: string, _userId: string) => ({
    id: 'run_1',
    user_id: 'user_1',
    application_uuid: 'app-abc',
    deployment_uuid: 'deploy-xyz',
    git_repository: 'finedesignz/remo-code',
    commit_sha: 'abc123',
  }),
}))

// ── Mock @octokit/rest ──────────────────────────────────────────────────────
const octokitCalls: any[] = []
mock.module('@octokit/rest', () => ({
  Octokit: class {
    constructor(public opts: any) {}
    issues = {
      create: async (args: any) => {
        octokitCalls.push(args)
        return { data: { number: 42 } }
      },
    }
  },
}))

const TRIAGE_OUTPUT = JSON.stringify({
  error_type: 'BuildError',
  severity: 'high',
  root_cause: 'missing env var',
  suggested_fix: 'set FOO',
  confidence: 0.9,
  affected_files: ['src/index.ts'],
})

const ACTION = {
  type: 'github_issue' as const,
  on: 'failure' as const,
  config: {
    repo_full_name: 'finedesignz/remo-code',
    labels: ['triage'],
    assignees: ['finedesignz'],
  },
}

const CTX_BASE = {
  userId: 'user_1',
  runId: 'run_1',
  templateVars: {
    output_snippet: TRIAGE_OUTPUT,
    application_uuid: 'app-abc',
    deployment_uuid: 'deploy-xyz',
    git_repository: 'finedesignz/remo-code',
    commit_sha: 'abc123',
    run_url: 'https://app.remo-code.com/schedules/runs/run_1',
    error: '',
  },
}

// ── Stub global fetch for gateway credential lookup ─────────────────────────
const originalFetch = globalThis.fetch
let fetchCalls: string[] = []

beforeEach(() => {
  idempotencyStore.clear()
  octokitCalls.length = 0
  fetchCalls = []
  process.env.GATEWAY_URL = 'https://gateway.test'
  process.env.GATEWAY_API_KEY = 'olx_test'
  ;(globalThis as any).fetch = async (url: string | URL, _init?: any) => {
    fetchCalls.push(String(url))
    return new Response(JSON.stringify({ token: 'ghp_test_token' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }
})

describe('executeGithubIssue', () => {
  test('creates an issue on first invocation', async () => {
    const { executeGithubIssue } = await import('../src/scheduler/post-run/github-issue.ts')
    await executeGithubIssue(ACTION as any, CTX_BASE)
    expect(octokitCalls.length).toBe(1)
    const call = octokitCalls[0]
    expect(call.owner).toBe('finedesignz')
    expect(call.repo).toBe('remo-code')
    expect(call.title).toContain('high')
    expect(call.title).toContain('BuildError')
    expect(call.labels).toEqual(expect.arrayContaining(['severity:high', 'automated', 'remo-code', 'triage']))
    expect(call.assignees).toEqual(['finedesignz'])
    expect(fetchCalls.some((u) => u.includes('/api/credentials/service/github'))).toBe(true)
  })

  test('does not create a duplicate issue for the same (repo, app_uuid, deploy_uuid)', async () => {
    const { executeGithubIssue } = await import('../src/scheduler/post-run/github-issue.ts')
    await executeGithubIssue(ACTION as any, CTX_BASE)
    await executeGithubIssue(ACTION as any, CTX_BASE)
    expect(octokitCalls.length).toBe(1)
  })

  test('skips when no gateway token is returned', async () => {
    ;(globalThis as any).fetch = async () =>
      new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } })
    // Use a fresh deploy_uuid so idempotency doesn't short-circuit.
    const ctx = {
      ...CTX_BASE,
      templateVars: { ...CTX_BASE.templateVars, deployment_uuid: 'deploy-new' },
    }
    const { executeGithubIssue } = await import('../src/scheduler/post-run/github-issue.ts')
    await executeGithubIssue(ACTION as any, ctx)
    expect(octokitCalls.length).toBe(0)
  })

  test('ignores non-github_issue actions', async () => {
    const { executeGithubIssue } = await import('../src/scheduler/post-run/github-issue.ts')
    await executeGithubIssue({ type: 'webhook', on: 'failure', config: { url: 'https://x' } } as any, CTX_BASE)
    expect(octokitCalls.length).toBe(0)
  })
})

// Restore fetch on module unload (best effort).
;(globalThis as any).__restoreFetch = () => {
  globalThis.fetch = originalFetch
}
