/**
 * Verify a claimed commit SHA is actually MERGED to the repo's default
 * branch before trusting a revanote `resolved: true` callback.
 *
 * Incident (2026-09-14, Lakeside project): a background subagent marked 43
 * annotations `resolved` citing commit `86ad71296`, which was real but
 * dangling/unreachable on any branch — never pushed, never deployed. Nothing
 * in the hub verified the citation before forwarding `resolved: true` to
 * revanote. See docs/revanote.md "Resolved requires a pushed commit".
 *
 * A GET /commits/{sha} 200 is NOT sufficient — GitHub returns 200 for a
 * commit reachable from ANY branch, so a pushed-but-unmerged PR branch tip
 * would pass. Owner rule: resolved only once the fix is MERGED to the
 * default branch. So this fetches the repo's `default_branch`, then compares
 * `{default_branch}...{sha}`: verified only when the compare `status` is
 * `identical` (sha IS the default-branch head) or `behind` (sha is an
 * ancestor of it). `ahead`/`diverged`/anything else means the sha is not on
 * the default branch.
 *
 * Fails CLOSED: any inability to prove the commit is on the default branch
 * (missing sha, missing repo/installation context, unparseable slug,
 * default-branch lookup failure, compare 404/error, or an unexpected compare
 * status) means "not verified" — the caller must downgrade the annotation to
 * `resolved: false` rather than forward the claim.
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

  let defaultBranch: string
  try {
    const repoMeta = await githubApiRequest<{ default_branch?: string }>(
      installationId,
      'GET',
      `/repos/${parsed.owner}/${parsed.repo}`,
    )
    if (!repoMeta || !repoMeta.default_branch) {
      return { verified: false, reason: 'default_branch_lookup_failed' }
    }
    defaultBranch = repoMeta.default_branch
  } catch {
    return { verified: false, reason: 'default_branch_lookup_failed' }
  }

  try {
    const sha = commitSha.trim()
    const compare = await githubApiRequest<{ status?: string }>(
      installationId,
      'GET',
      `/repos/${parsed.owner}/${parsed.repo}/compare/${encodeURIComponent(defaultBranch)}...${encodeURIComponent(sha)}`,
    )
    if (compare?.status === 'identical' || compare?.status === 'behind') {
      return { verified: true, reason: null }
    }
    return { verified: false, reason: 'commit_not_on_default_branch' }
  } catch (err: any) {
    if (err instanceof GitHubApiError && err.status === 404) {
      return { verified: false, reason: 'commit_not_on_remote' }
    }
    return { verified: false, reason: 'commit_verify_failed' }
  }
}
