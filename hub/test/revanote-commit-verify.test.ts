/**
 * verifyCommitOnRemote — the gate proving a claimed commit SHA actually
 * exists on the GitHub remote before a revanote `resolved: true` is trusted.
 * See hub/src/revanote/commit-verify.ts and docs/revanote.md.
 *
 * githubApiRequest is mocked — no real network calls in tests.
 */
import { describe, test, expect, mock } from 'bun:test'

let lastCall: any = null
let mockBehavior: 'ok' | '404' | '500' = 'ok'

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
      lastCall = { installationId, method, path }
      if (mockBehavior === 'ok') return { sha: 'abc123' }
      if (mockBehavior === '404') throw new GitHubApiError(404, 'Not Found', 'github api 404')
      throw new GitHubApiError(500, 'boom', 'github api 500')
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

  test('commit exists on remote (200) -> verified', async () => {
    mockBehavior = 'ok'
    lastCall = null
    const r = await verifyCommitOnRemote({ installationId: 123, repoSlug: 'owner/repo', commitSha: 'abc123' })
    expect(r.verified).toBe(true)
    expect(r.reason).toBeNull()
    expect(lastCall).toEqual({ installationId: 123, method: 'GET', path: '/repos/owner/repo/commits/abc123' })
  })

  test('commit not found on remote (404) -> not verified, reason commit_not_on_remote', async () => {
    mockBehavior = '404'
    const r = await verifyCommitOnRemote({ installationId: 123, repoSlug: 'owner/repo', commitSha: 'dangling-sha' })
    expect(r.verified).toBe(false)
    expect(r.reason).toBe('commit_not_on_remote')
  })

  test('other API error -> not verified, fails closed', async () => {
    mockBehavior = '500'
    const r = await verifyCommitOnRemote({ installationId: 123, repoSlug: 'owner/repo', commitSha: 'abc123' })
    expect(r.verified).toBe(false)
    expect(r.reason).toBe('commit_verify_failed')
  })
})
