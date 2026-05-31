// hub/src/lib/repo-key.ts
//
// Phase 08: GitHub-backed session keying. Tiny shared helper consumed by both
// hub (DAL upsert path) and supervisor (git introspection). No external deps.
//
// Spec: ARCHITECTURE.md §2.4 — parse SSH, HTTPS, and ssh:// GitHub remote URLs
// into a normalised {owner, repo} pair. Lowercase the result so the partial
// unique index `idx_sessions_user_repo_key` collapses casing variants.

export type GitOriginGithub = { owner: string; repo: string }

// Three accepted GitHub remote URL forms (host match is case-insensitive,
// trailing `.git` and trailing `/` are stripped, repo can contain dots/dashes
// and other path-safe chars). Anything else (gitlab, bitbucket, self-hosted,
// empty) returns null.
const RE_SSH = /^git@github\.com:([^/]+)\/(.+?)(?:\.git)?\/?$/i
const RE_HTTPS = /^https?:\/\/github\.com\/([^/]+)\/(.+?)(?:\.git)?\/?$/i
const RE_SSH_PROTO = /^ssh:\/\/git@github\.com\/([^/]+)\/(.+?)(?:\.git)?\/?$/i

export function parseGitRemote(remote: string | null | undefined): GitOriginGithub | null {
  if (!remote || typeof remote !== 'string') return null
  const trimmed = remote.trim()
  if (trimmed === '') return null

  for (const re of [RE_SSH_PROTO, RE_SSH, RE_HTTPS]) {
    const m = trimmed.match(re)
    if (m) {
      const owner = m[1]?.trim()
      const repo = m[2]?.trim()
      if (!owner || !repo) return null
      return { owner: owner.toLowerCase(), repo: repo.toLowerCase() }
    }
  }
  return null
}

export function buildRepoKey(o: GitOriginGithub): string {
  return `github://${o.owner.toLowerCase()}/${o.repo.toLowerCase()}`
}

// auto-dev P5: Coolify's webhook `git_repository` field is not always a full
// remote URL — it can arrive as a bare `owner/repo` slug. Try the URL parsers
// first (SSH/HTTPS/ssh://), then fall back to a bare `owner/repo` match so the
// repo-keyed deploy-failure resolver can map a Coolify failure to a session's
// `repo_key`. Returns null for anything non-GitHub / unparseable.
const RE_BARE_SLUG = /^([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/

export function repoKeyFromGitRepository(gitRepository: string | null | undefined): string | null {
  const remote = parseGitRemote(gitRepository)
  if (remote) return buildRepoKey(remote)

  // Bare `owner/repo` slug fallback (no scheme, no host).
  const trimmed = (gitRepository ?? '').trim()
  if (trimmed === '' || trimmed.includes('://') || trimmed.includes('@')) return null
  const m = trimmed.match(RE_BARE_SLUG)
  if (!m) return null
  const owner = m[1]?.trim()
  const repo = m[2]?.trim()
  if (!owner || !repo) return null
  return buildRepoKey({ owner, repo })
}
