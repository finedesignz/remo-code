/**
 * Verify a claimed commit SHA actually exists on the GitHub remote before
 * trusting a revanote `resolved: true` callback.
 *
 * Incident (2026-09-14, Lakeside project): a background subagent marked 43
 * annotations `resolved` citing commit `86ad71296`, which was real but
 * dangling/unreachable on any branch — never pushed, never deployed. Nothing
 * in the hub verified the citation before forwarding `resolved: true` to
 * revanote. See docs/revanote.md "Resolved requires a pushed commit".
 *
 * Fails CLOSED: any inability to prove the commit exists on the remote
 * (missing sha, missing repo/installation context, 404, unparseable slug, or
 * any API error) means "not verified" — the caller must downgrade the
 * annotation to `resolved: false` rather than forward the claim.
 */
import { githubApiRequest, GitHubApiError } from '../auth/github-app.ts'

export interface CommitVerifyResult {
  verified: boolean
  /** null only when verified === true. */
  reason: string | null
}

function parseSlug(repoSlug: string): { owner: string; repo: string } | null {
  const m = /^([\w.-]+)\/([\w.-]+?)(?:\.git)?$/.exec(repoSlug.trim())
  if (!m) return null
  return { owner: m[1], repo: m[2] }
}

export async function verifyCommitOnRemote(opts: {
  installationId: number | null | undefined
  repoSlug: string | null | undefined
  commitSha: string | null | undefined
}): Promise<CommitVerifyResult> {
  const { installationId, repoSlug, commitSha } = opts

  if (!commitSha || typeof commitSha !== 'string' || !commitSha.trim()) {
    return { verified: false, reason: 'commit_sha_missing' }
  }
  if (!installationId || !repoSlug) {
    return { verified: false, reason: 'repo_context_missing' }
  }
  const parsed = parseSlug(repoSlug)
  if (!parsed) {
    return { verified: false, reason: 'repo_slug_unparseable' }
  }

  try {
    await githubApiRequest(
      installationId,
      'GET',
      `/repos/${parsed.owner}/${parsed.repo}/commits/${encodeURIComponent(commitSha.trim())}`,
    )
    return { verified: true, reason: null }
  } catch (err: any) {
    if (err instanceof GitHubApiError && err.status === 404) {
      return { verified: false, reason: 'commit_not_on_remote' }
    }
    return { verified: false, reason: 'commit_verify_failed' }
  }
}
