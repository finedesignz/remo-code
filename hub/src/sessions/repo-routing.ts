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
import { resolveRepoKeyFromAppUuid } from './coolify-app-repo.ts'

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
  appUuid?: string | null,
): Promise<RepoKeyedTarget | null> {
  // Prefer the webhook's `git_repository` when present + parseable. Coolify's
  // `deployment.failed` payload usually OMITS it (only `application_uuid`), so
  // fall back to the uuid→repo_key resolver (Coolify-API cache) when we can't
  // derive a key from the repo string. Either way we end with a `repo_key` and
  // do the SAME bound-session-with-live-socket match.
  let repoKey = repoKeyFromGitRepository(gitRepository)
  if (!repoKey && appUuid) {
    repoKey = await resolveRepoKeyFromAppUuid(appUuid, userId)
  }
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

/**
 * fix/coolify-triage-guard — active-session suppression check.
 *
 * Returns true when the user has a LIVE (online agent socket) session bound to
 * the repo named by `gitRepository`. This is the same definition of "active on
 * this repo" used by `resolveRepoKeyedAgentSession` and by GET /api/sessions'
 * `active` flag (a live `/ws/agent` channel). When true, a `deployment.failed`
 * webhook should SKIP auto-triage — a dev is already working + monitoring that
 * repo and an unsolicited triage session would interrupt them.
 *
 * Excludes rootless sessions and the orchestrator implicitly: orchestrator runs
 * against the root folder, not a per-app `repo_key`, and rootless sessions are
 * filtered out of `listSessionIdsForRepoKey`.
 *
 * Fail-OPEN is the caller's responsibility: this throws on a DB error rather
 * than swallowing it, so the caller can decide to dispatch-anyway-and-log.
 */
export async function hasActiveSessionForRepo(
  userId: string,
  gitRepository: string | null | undefined,
): Promise<boolean> {
  const target = await resolveRepoKeyedAgentSession(userId, gitRepository)
  return target != null
}
