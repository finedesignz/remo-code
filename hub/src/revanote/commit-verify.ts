// hub/src/revanote/commit-verify.ts
// fix/revanote-verify-pushed — a "resolved" is only accepted for a commit that
// is actually on the remote.
//
// Incident (2026-09): an agent reported client comments `resolved: true` from
// commits that were never pushed (lost local commits). Revanote marked them
// done, the client saw nothing change, and nobody noticed for weeks. The
// agent's envelope is self-report; the prompt asking it to push first is not a
// control. So the HUB checks: a resolved reply must name its `commit_sha`, and
// the hub confirms through the GitHub App that the commit exists in the repo
// (and, when the reply names a `branch`, that the branch contains it). Anything
// else is downgraded to resolved:false with a reason, fail-closed.
//
// Escape hatch: REMO_REVANOTE_REQUIRE_PUSHED_COMMIT=0|false|no|off disables
// the check (e.g. a user with no GitHub App installation yet). Default ON.

export type VerifyFailReason =
  | 'commit_sha_missing'
  | 'commit_sha_invalid'
  | 'repo_unknown'
  | 'no_github_installation'
  | 'commit_not_pushed'
  | 'commit_not_on_branch'
  | 'verify_error'

export type VerifyResult =
  | { ok: true; sha: string; repo: string }
  | { ok: false; reason: VerifyFailReason; detail?: string }

export interface VerifyInput {
  owner: string | null
  repo: string | null
  commitSha: string | null | undefined
  branch?: string | null
  /** Candidate GitHub App installations for this user, best match first. */
  installationIds: number[]
}

export type GithubGet = (installationId: number, path: string) => Promise<any>

const SHA_RE = /^[0-9a-f]{7,40}$/i

export function isPushVerificationRequired(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.REMO_REVANOTE_REQUIRE_PUSHED_COMMIT
  if (raw == null || raw.trim() === '') return true
  return !['0', 'false', 'no', 'off'].includes(raw.trim().toLowerCase())
}

function statusOf(err: any): number | null {
  return typeof err?.status === 'number' ? err.status : null
}

/**
 * Confirm `commitSha` exists in `owner/repo` on GitHub (and is contained in
 * `branch` when given). Tries each installation in order: a 404/422 from one
 * installation may just mean it can't see the repo, so only "every
 * installation says not found" becomes `commit_not_pushed`.
 */
export async function verifyPushedCommit(input: VerifyInput, get: GithubGet): Promise<VerifyResult> {
  const sha = (input.commitSha ?? '').trim()
  if (!sha) return { ok: false, reason: 'commit_sha_missing' }
  if (!SHA_RE.test(sha)) return { ok: false, reason: 'commit_sha_invalid', detail: sha.slice(0, 64) }
  if (!input.owner || !input.repo) return { ok: false, reason: 'repo_unknown' }
  if (input.installationIds.length === 0) return { ok: false, reason: 'no_github_installation' }

  const owner = encodeURIComponent(input.owner)
  const repo = encodeURIComponent(input.repo)
  const slug = `${input.owner}/${input.repo}`
  let lastError: string | null = null

  for (const inst of input.installationIds) {
    let commit: any
    try {
      commit = await get(inst, `/repos/${owner}/${repo}/commits/${encodeURIComponent(sha)}`)
    } catch (err: any) {
      const st = statusOf(err)
      if (st === 404 || st === 422) continue
      lastError = err?.message ?? String(err)
      continue
    }
    if (!commit) continue // helper returned null for 404
    const fullSha: string = typeof commit.sha === 'string' ? commit.sha : sha

    const branch = (input.branch ?? '').trim()
    if (branch) {
      try {
        const cmp = await get(
          inst,
          `/repos/${owner}/${repo}/compare/${encodeURIComponent(branch)}...${encodeURIComponent(fullSha)}`,
        )
        // `behind`/`identical` ⇒ the commit is an ancestor of (or equal to) the branch head.
        if (cmp?.status !== 'identical' && cmp?.status !== 'behind') {
          return { ok: false, reason: 'commit_not_on_branch', detail: `${branch} (${cmp?.status ?? 'unknown'})` }
        }
      } catch (err: any) {
        const st = statusOf(err)
        if (st === 404) return { ok: false, reason: 'commit_not_on_branch', detail: `${branch} not found` }
        return { ok: false, reason: 'verify_error', detail: err?.message ?? String(err) }
      }
    }
    return { ok: true, sha: fullSha, repo: slug }
  }

  if (lastError) return { ok: false, reason: 'verify_error', detail: lastError }
  return { ok: false, reason: 'commit_not_pushed', detail: `${sha} not found in ${slug}` }
}

/** Resolve owner/repo + installations for an annotation run (real DB/GitHub). */
export async function loadVerifyContext(args: {
  userId: string
  sessionId: string | null
  repoSlugFallback: string | null
}): Promise<{ owner: string | null; repo: string | null; installationIds: number[] }> {
  const { sql } = await import('../db/postgres.ts')
  let owner: string | null = null
  let repo: string | null = null
  if (args.sessionId) {
    const rows = await sql<{ github_owner: string | null; github_repo: string | null }[]>`
      SELECT github_owner, github_repo FROM sessions
      WHERE id = ${args.sessionId} AND user_id = ${args.userId} LIMIT 1
    `
    owner = rows[0]?.github_owner ?? null
    repo = rows[0]?.github_repo ?? null
  }
  if ((!owner || !repo) && args.repoSlugFallback) {
    const m = args.repoSlugFallback.replace(/^github:\/\//, '').match(/^([^/\s]+)\/([^/\s]+?)(?:\.git)?$/)
    if (m) {
      owner = m[1]
      repo = m[2]
    }
  }
  const inst = await sql<{ id: string | number; account_login: string }[]>`
    SELECT id, account_login FROM github_installations
    WHERE user_id = ${args.userId} AND revoked_at IS NULL
    ORDER BY installed_at DESC
  `
  const lower = (owner ?? '').toLowerCase()
  const ids = [...inst]
    .sort((a, b) => Number(b.account_login.toLowerCase() === lower) - Number(a.account_login.toLowerCase() === lower))
    .map((r) => Number(r.id))
  return { owner, repo, installationIds: ids }
}

export async function realGithubGet(installationId: number, path: string): Promise<any> {
  const { githubApiRequest } = await import('../auth/github-app.ts')
  return githubApiRequest(installationId, 'GET', path)
}
