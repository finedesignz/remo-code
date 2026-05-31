/**
 * auto-dev P5 — repo-keyed deploy-failure routing.
 *
 * A Coolify `deployment.failed` webhook carries the failing app's
 * `git_repository`. The triage path historically routed via `pickSessionTarget`
 * (capacity-based), so a failure for repo X could land in a session bound to
 * repo Y. This resolver maps the webhook's `git_repository` to a `repo_key` and
 * returns an ONLINE agent-channel session actually bound to that repo, so the
 * fix lands in the right place.
 *
 *   git_repository ──(repoKeyFromGitRepository)──► repo_key
 *   repo_key ──(listSessionIdsForRepoKey)──► candidate session IDs
 *   ∩ online agent channels (getChannel) ──► first match
 *
 * Returns null when:
 *   - `git_repository` is absent / non-GitHub / unparseable (Coolify gives us
 *     only an `application_uuid` — there is no hub-side uuid→repo map today, so
 *     we key on `git_repository` and document the uuid-only fallback), OR
 *   - no session is bound to that repo, OR
 *   - a bound session exists but has no live agent socket.
 *
 * The caller (`sendTriage`) treats null as "no repo match" and falls back to
 * `pickSessionTarget` — preserving today's behavior exactly for the no-match
 * case (capacity routing / supervisor spawn).
 */
import { repoKeyFromGitRepository } from '../lib/repo-key.ts'
import { listSessionIdsForRepoKey } from '../db/dal.ts'
import { getChannel } from '../ws/registry.ts'

export interface RepoKeyedTarget {
  kind: 'repo_keyed_agent'
  agent_session_id: string
  repo_key: string
}

/**
 * Resolve an online agent session bound to the repo named by `gitRepository`.
 * Returns null when there is no parseable repo, no bound session, or no live
 * socket for any bound session.
 */
export async function resolveRepoKeyedAgentSession(
  userId: string,
  gitRepository: string | null | undefined,
): Promise<RepoKeyedTarget | null> {
  const repoKey = repoKeyFromGitRepository(gitRepository)
  if (!repoKey) return null

  let candidateIds: string[]
  try {
    candidateIds = await listSessionIdsForRepoKey(userId, repoKey)
  } catch (err: any) {
    console.warn(`[repo-routing] listSessionIdsForRepoKey failed key=${repoKey}: ${err?.message}`)
    return null
  }

  for (const sessionId of candidateIds) {
    if (getChannel(sessionId) != null) {
      return { kind: 'repo_keyed_agent', agent_session_id: sessionId, repo_key: repoKey }
    }
  }
  return null
}
