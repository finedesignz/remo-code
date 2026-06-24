/**
 * Repo identity for grouping (web twin of hub/src/lib/repo-key.ts buildRepoKey).
 *
 * A membership keys a repo by a single normalized string:
 *   "github://<owner>/<repo>"   GitHub-backed (host-agnostic, preferred)
 *   "path://<absolute-path>"    local-only folder (host-specific fallback)
 *
 * Returns null when the row is unidentifiable (no GitHub identity, no path) —
 * such repos can never be grouped and always fall into the Ungrouped section.
 */

/** Build the canonical github:// ident (lowercased, matches buildRepoKey). */
export function buildGithubIdent(owner: string, repo: string): string {
  return `github://${owner.toLowerCase()}/${repo.toLowerCase()}`
}

/** Normalize a `owner/repo` full_name into the github:// ident, or null. */
export function githubIdentFromFullName(fullName: string | null | undefined): string | null {
  if (!fullName) return null
  const slash = fullName.indexOf('/')
  if (slash <= 0 || slash === fullName.length - 1) return null
  return buildGithubIdent(fullName.slice(0, slash), fullName.slice(slash + 1))
}

/**
 * Resolve a repo_ident from a row carrying any of: a precomputed `repo_key`
 * (already "github://owner/repo"), GitHub `owner`/`repo` (or `full_name`), or a
 * local `path`. GitHub identity wins over path (host-agnostic).
 */
export function repoIdent(row: {
  repo_key?: string | null
  owner?: string | null
  repo?: string | null
  full_name?: string | null
  path?: string | null
}): string | null {
  if (row.repo_key) return row.repo_key
  if (row.owner && row.repo) return buildGithubIdent(row.owner, row.repo)
  const fromFull = githubIdentFromFullName(row.full_name)
  if (fromFull) return fromFull
  if (row.path) return `path://${row.path}`
  return null
}

/** Reserved id for the implicit, trailing "Ungrouped" section. */
export const UNGROUPED_ID = '__ungrouped__'
