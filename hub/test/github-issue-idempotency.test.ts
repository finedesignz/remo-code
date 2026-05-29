/**
 * TRIAGE-2026-05-28 Bundle 7 step 1.
 *
 * Placeholder-before-create idempotency:
 *   1. placeOpenIssuePlaceholder claims (issue_number=0) BEFORE octokit
 *   2. updateOpenIssuePlaceholder fills in the real issue_number on success
 *   3. deleteOpenIssuePlaceholder removes the sentinel on Octokit failure
 */
import { describe, test, expect, beforeEach, mock } from 'bun:test'

type Row = { issueNumber: number; repo: string }
const store = new Map<string, Row>()
const events: string[] = []

// Spread real dal so unmocked exports stay resolvable for sibling files in the
// full suite (Bun mock.module is process-global). See memory: bun-mock-pollution.
const realDalGI = await import(`../src/db/dal.ts?real=${Date.now()}`)
mock.module('../src/db/dal.ts', () => ({
  ...realDalGI,
  hasOpenIssueForHash: async (userId: string, hash: string, _w: number) => {
    return store.has(`${userId}|${hash}`)
  },
  recordOpenIssueForHash: async (_u: string, _h: string, _n: number, _r: string) => {
    events.push('record-legacy')
  },
  placeOpenIssuePlaceholder: async (userId: string, hash: string, repo: string) => {
    const k = `${userId}|${hash}`
    if (store.has(k)) return false
    store.set(k, { issueNumber: 0, repo })
    events.push(`place:${hash}`)
    return true
  },
  updateOpenIssuePlaceholder: async (userId: string, hash: string, issueNumber: number) => {
    const k = `${userId}|${hash}`
    const r = store.get(k)
    if (r) store.set(k, { ...r, issueNumber })
    events.push(`update:${hash}=${issueNumber}`)
  },
  deleteOpenIssuePlaceholder: async (userId: string, hash: string) => {
    const k = `${userId}|${hash}`
    const r = store.get(k)
    if (r && r.issueNumber === 0) {
      store.delete(k)
      events.push(`delete:${hash}`)
    }
  },
}))

mock.module('../src/db/scheduled-tasks-dal.ts', () => ({
  getRun: async () => ({
    id: 'run_1',
    user_id: 'user_1',
    application_uuid: 'app-1',
    deployment_uuid: 'deploy-1',
    git_repository: 'finedesignz/remo-code',
  }),
}))

let octokitFail = false
mock.module('@octokit/rest', () => ({
  Octokit: class {
    constructor(public opts: any) {}
    issues = {
      create: async (_args: any) => {
        if (octokitFail) throw new Error('boom')
        return { data: { number: 99 } }
      },
    }
  },
}))

const ACTION = {
  type: 'github_issue' as const,
  on: 'failure' as const,
  config: { repo_full_name: 'finedesignz/remo-code' },
}

const TRIAGE = JSON.stringify({
  error_type: 'TestError',
  severity: 'high',
  root_cause: 'x',
  suggested_fix: 'y',
  confidence: 0.5,
  affected_files: [],
})

const CTX = {
  userId: 'user_1',
  runId: 'run_1',
  templateVars: {
    output_snippet: TRIAGE,
    application_uuid: 'app-1',
    deployment_uuid: 'deploy-1',
    git_repository: 'finedesignz/remo-code',
    commit_sha: 'sha',
    run_url: 'https://x/r/1',
    error: '',
  },
}

beforeEach(() => {
  store.clear()
  events.length = 0
  octokitFail = false
  process.env.GATEWAY_URL = 'https://gateway.test'
  process.env.GATEWAY_API_KEY = 'olx_test'
  ;(globalThis as any).fetch = async () =>
    new Response(JSON.stringify({ token: 'ghp_x' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
})

describe('github-issue placeholder lifecycle', () => {
  test('place → update on octokit success', async () => {
    const { executeGithubIssue } = await import('../src/scheduler/post-run/github-issue.ts')
    await executeGithubIssue(ACTION as any, CTX)
    expect(events[0]).toMatch(/^place:/)
    expect(events.some((e) => e.startsWith('update:'))).toBe(true)
    expect(events.some((e) => e.startsWith('delete:'))).toBe(false)
    // store has the real issue number now
    const row = Array.from(store.values())[0]
    expect(row.issueNumber).toBe(99)
  })

  test('place → delete on octokit failure', async () => {
    octokitFail = true
    const { executeGithubIssue } = await import('../src/scheduler/post-run/github-issue.ts')
    await executeGithubIssue(ACTION as any, CTX)
    expect(events[0]).toMatch(/^place:/)
    expect(events.some((e) => e.startsWith('delete:'))).toBe(true)
    // store cleaned up — next call can retry
    expect(store.size).toBe(0)
  })

  test('second concurrent call loses the placeholder race and does NOT create', async () => {
    const { executeGithubIssue } = await import('../src/scheduler/post-run/github-issue.ts')
    await executeGithubIssue(ACTION as any, CTX) // wins placeholder, creates issue
    const beforeSecond = events.length
    await executeGithubIssue(ACTION as any, CTX) // hasOpenIssueForHash sees row → returns early
    // No new place/update/delete events on the second call
    expect(events.length).toBe(beforeSecond)
  })
})
