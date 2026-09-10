/**
 * Shared session enrichment — the SINGLE source of truth for the derived
 * fields the web expects on a session row.
 *
 * `active` and `local_paths` are NOT columns on `sessions`; they are derived
 * from the supervisor registry at read time. The raw DAL `listSessions()`
 * therefore cannot return them.
 *
 * Every surface that hands session rows to the web MUST enrich them here.
 * `useSessions` (web) REPLACES its entire list on each WS `session_list`
 * message, so an unenriched broadcast silently strips `active` off rows the
 * REST call had just populated — which empties the grid's virtual Default tab
 * (membership = `sessions.filter(s => s.active)`) while List View, keyed on
 * `status`, keeps working. Keep the WS payload and the REST payload identical.
 */
import { listSessions } from '../db/dal'
import { getActiveSessionIdsForUser, getKnownLocalPathsForRepoKey } from '../ws/supervisor-registry.ts'

/**
 * Add the derived `active` + `local_paths` fields to raw `listSessions()` rows.
 *
 * `active` is authoritative from the supervisor's `session_inventory` push (the
 * supervisor is currently hosting a runner for this session_id), falling back
 * to the DB status column for pre-0.5.7 supervisors that push no inventory.
 */
export function enrichSessionsForUser<T extends { id: string; status: string; repo_key?: string | null }>(
  userId: string,
  rows: T[],
) {
  const activeIds = getActiveSessionIdsForUser(userId)
  return rows.map((s) => ({
    ...s,
    active: activeIds.has(s.id) || s.status === 'online' || s.status === 'thinking',
    local_paths: s.repo_key ? getKnownLocalPathsForRepoKey(userId, s.repo_key) : [],
  }))
}

/** `listSessions` + enrichment — the exact shape `GET /api/sessions` and every
 *  WS `session_list` broadcast must send. */
export async function listSessionsForUserEnriched(userId: string) {
  return enrichSessionsForUser(userId, (await listSessions(userId)) as any[])
}
