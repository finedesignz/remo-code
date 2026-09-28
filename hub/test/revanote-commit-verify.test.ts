/**
 * verifyCommitOnRemote — the gate proving a claimed commit SHA is actually
 * MERGED to the repo's default branch before a revanote `resolved: true` is
 * trusted. A commit merely pushed to any branch (e.g. an open, unmerged PR)
 * must NOT verify — only a sha that is the default-branch head or an
 * ancestor of it (compare status 'identical' or 'behind') counts.
 * See hub/src/revanote/commit-verify.ts and docs/revanote.md.
 *
 * githubApiRequest is mocked — no real network calls in tests.
 */
import { describe, test, expect, mock } from 'bun:test'

let lastCalls: Array<{ installationId: number; method: string; path: string }> = []
let repoLookup: 'ok' | 'error' = 'ok'
let compareResult: 'identical' | 'behind' | 'ahead' | 'diverged' | '404' | 'error' = 'identical'

mock.module('../src/auth/github-app.ts', () => {
  class GitHubApiError extends Error {
    status: number
    body: string
    constructor(status: number, body: string, msg: string) {
      super(msg)
      this.status = status
      this.body = body
    }
  }
  return {
    GitHubApiError,
    githubApiRequest: async (installationId: number, method: string, path: string) => {
      lastCalls.push({ installationId, method, path })
      if (/\/repos\/[^/]+\/[^/]+$/.test(path)) {
        if (repoLookup === 'error') throw new GitHubApiError(500, 'boom', 'github api 500')
        return { default_branch: 'main' }
      }
      if (path.includes('/compare/')) {
        if (compareResult === '404') throw new GitHubApiError(404, 'Not Found', 'github api 404')
        if (compareResult === 'error') throw new GitHubApiError(500, 'boom', 'github api 500')
        return { status: compareResult }
      }
      throw new Error(`unexpected path in test mock: ${path}`)
    },
  }
})

const { verifyCommitOnRemote } = await import('../src/revanote/commit-verify.ts')

describe('verifyCommitOnRemote', () => {
  test('missing commit_sha fails closed', async () => {
    const r = await verifyCommitOnRemote({ installationId: 123, repoSlug: 'owner/repo', commitSha: null })
    expect(r.verified).toBe(false)
    expect(r.reason).toBe('commit_sha_missing')
  })

  test('missing installation/repo context fails closed', async () => {
    const r1 = await verifyCommitOnRemote({ installationId: null, repoSlug: 'owner/repo', commitSha: 'abc123' })
    expect(r1.verified).toBe(false)
    expect(r1.reason).toBe('repo_context_missing')

    const r2 = await verifyCommitOnRemote({ installationId: 123, repoSlug: null, commitSha: 'abc123' })
    expect(r2.verified).toBe(false)
    expect(r2.reason).toBe('repo_context_missing')
  })

  test('unparseable repo slug fails closed', async () => {
    const r = await verifyCommitOnRemote({ installationId: 123, repoSlug: 'not a slug', commitSha: 'abc123' })
    expect(r.verified).toBe(false)
    expect(r.reason).toBe('repo_slug_unparseable')
  })

  test('commit is the default-branch head (identical) -> verified', async () => {
    repoLookup = 'ok'
    compareResult = 'identical'
    lastCalls = []
    const r = await verifyCommitOnRemote({ installationId: 123, repoSlug: 'owner/repo', commitSha: 'abc123' })
    expect(r.verified).toBe(true)
    expect(r.reason).toBeNull()
    expect(lastCalls).toEqual([
      { installationId: 123, method: 'GET', path: '/repos/owner/repo' },
      { installationId: 123, method: 'GET', path: '/repos/owner/repo/compare/main...abc123' },
    ])
  })

  test('commit is an ancestor of default-branch head (behind) -> verified', async () => {
    repoLookup = 'ok'
    compareResult = 'behind'
    const r = await verifyCommitOnRemote({ installationId: 123, repoSlug: 'owner/repo', commitSha: 'abc123' })
    expect(r.verified).toBe(true)
    expect(r.reason).toBeNull()
  })

  test('unmerged PR branch tip (ahead of default) -> NOT verified', async () => {
    repoLookup = 'ok'
    compareResult = 'ahead'
    const r = await verifyCommitOnRemote({ installationId: 123, repoSlug: 'owner/repo', commitSha: 'unmerged-sha' })
    expect(r.verified).toBe(false)
    expect(r.reason).toBe('commit_not_on_default_branch')
  })

  test('diverged from default branch -> NOT verified', async () => {
    repoLookup = 'ok'
    compareResult = 'diverged'
    const r = await verifyCommitOnRemote({ installationId: 123, repoSlug: 'owner/repo', commitSha: 'diverged-sha' })
    expect(r.verified).toBe(false)
    expect(r.reason).toBe('commit_not_on_default_branch')
  })

  test('commit not found on remote (compare 404) -> not verified', async () => {
    repoLookup = 'ok'
    compareResult = '404'
    const r = await verifyCommitOnRemote({ installationId: 123, repoSlug: 'owner/repo', commitSha: 'dangling-sha' })
    expect(r.verified).toBe(false)
    expect(r.reason).toBe('commit_not_on_remote')
  })

  test('compare API error -> not verified, fails closed', async () => {
    repoLookup = 'ok'
    compareResult = 'error'
    const r = await verifyCommitOnRemote({ installationId: 123, repoSlug: 'owner/repo', commitSha: 'abc123' })
    expect(r.verified).toBe(false)
    expect(r.reason).toBe('commit_verify_failed')
  })

  test('default-branch lookup error -> not verified, fails closed', async () => {
    repoLookup = 'error'
    const r = await verifyCommitOnRemote({ installationId: 123, repoSlug: 'owner/repo', commitSha: 'abc123' })
    expect(r.verified).toBe(false)
    expect(r.reason).toBe('default_branch_lookup_failed')
  })
})
