/**
 * Shared orphan-session-resume helper.
 *
 * Two callers:
 *   1. `hub/src/ws/agent.ts` supervisor.hello — resumes orphan runs whose
 *      supervisor just reconnected. (Scope: by supervisor_id.)
 *   2. `hub/src/ws/client.ts` client auth — when a browser connects (page load /
 *      refresh), resume any orphans for that user across any currently-online
 *      supervisor. (Scope: by user_id, picks online supervisor.)
 *
 * Invariants (same for both call paths):
 *
 *  - **`exit_reason='user_stopped'` is sacred.** A session the user explicitly
 *    killed (via Stop button → /api/supervisors/:id/stop or
 *    /api/sessions/:id) is NEVER auto-resumed. The latest `session_runs` row
 *    for the bound session is inspected; if any of its finalized rows carries
 *    `user_stopped`, we skip it.
 *  - **Age cap** — orphans older than 24h are finalized as `stale` and not
 *    replayed (matches agent.ts pre-existing behavior).
 *  - **Restart cap** — `restart_count >= 10` → finalize `max_restarts_exceeded`,
 *    skip replay.
 *  - **Concurrency budget** — every replay goes through `reserveSessionSlot`.
 *    If reservation fails, skip that one and continue with the rest.
 *  - **Errors per orphan are swallowed** — a failed send for one orphan does
 *    not abort the rest of the batch.
 */

import { reserveSessionSlot } from '../sessions/budget'
import { listOnlineSupervisorIdsForUser, getSupervisor } from '../ws/supervisor-registry'

const MAX_RESTART_COUNT = 10

// Exit-reason classification. Anything here = DO NOT resume.
// `user_stopped` is the new sentinel written by the Stop endpoints.
// `replaced` covers explicit operator/agent actions in the supervisor.
const NON_RESUMABLE_EXIT_REASONS = new Set([
  'user_stopped',
  'user_disconnect',
  'replaced',
])

export interface ResumeResult {
  resumed: string[]                  // new_run_id values
  skipped_user_stopped: string[]     // session_id or old run_id
  skipped_no_supervisor: string[]    // session_id or old run_id
  skipped_capacity: string[]
  skipped_max_restarts: string[]
  finalized_stale: string[]
}

function emptyResult(): ResumeResult {
  return {
    resumed: [],
    skipped_user_stopped: [],
    skipped_no_supervisor: [],
    skipped_capacity: [],
    skipped_max_restarts: [],
    finalized_stale: [],
  }
}

interface OrphanRow {
  id: string
  session_id: string | null
  supervisor_id: string | null
  repo_path: string
  branch: string | null
  restart_count: number | null
  started_at: Date
}

/**
 * Was the user's most-recent finalized action on this session_id a deliberate
 * `user_stopped`? If so, the orphan must NOT be resumed even if a brand-new
 * open run got reopened by some race (e.g. supervisor re-spawned out of band).
 */
async function lastUserStopped(sql: any, sessionId: string | null): Promise<boolean> {
  if (!sessionId) return false
  const rows = await sql`
    SELECT exit_reason
    FROM session_runs
    WHERE session_id = ${sessionId}
      AND ended_at IS NOT NULL
      AND exit_reason IS NOT NULL
    ORDER BY ended_at DESC
    LIMIT 1
  `
  if (rows.length === 0) return false
  return NON_RESUMABLE_EXIT_REASONS.has(rows[0].exit_reason)
}

/**
 * Sweep + replay a batch of orphans for ONE supervisor on behalf of ONE user.
 *
 * Internal helper shared by `resumeOrphansForSupervisor` (agent.ts path) and
 * `resumeOrphanSessionsForUser` (client.ts path). Returns a partial-result
 * object — callers merge multiple supervisors into one result.
 */
async function resumeOrphansInner(args: {
  sql: any
  userId: string
  supervisorId: string
}): Promise<ResumeResult> {
  const { sql, userId, supervisorId } = args
  const result = emptyResult()

  // 1. Stale-sweep — anything older than 24h on this supervisor, no matter the
  //    exit_reason origin, gets finalized as 'stale' before we look at fresh
  //    orphans. Matches the long-standing agent.ts behavior.
  const staleSweep = await sql`
    UPDATE session_runs
    SET ended_at = now(), exit_reason = 'stale'
    WHERE supervisor_id = ${supervisorId}
      AND ended_at IS NULL
      AND started_at <= now() - interval '24 hours'
    RETURNING id
  `
  for (const r of staleSweep) result.finalized_stale.push(r.id)

  // 2. Fresh orphans — open rows < 24h old.
  const orphans: OrphanRow[] = await sql`
    SELECT id, session_id, supervisor_id, repo_path, branch, restart_count, started_at
    FROM session_runs
    WHERE supervisor_id = ${supervisorId}
      AND user_id = ${userId}
      AND ended_at IS NULL
      AND started_at > now() - interval '24 hours'
    ORDER BY started_at ASC
  `

  if (orphans.length === 0) return result

  // 3. For each orphan: classify, optionally end + replay.
  for (const o of orphans) {
    // (a) user_stopped guard — the sacred invariant.
    if (await lastUserStopped(sql, o.session_id)) {
      // Finalize the dangling open row so we don't keep reconsidering it.
      await sql`
        UPDATE session_runs
        SET ended_at = now(), exit_reason = 'user_stopped'
        WHERE id = ${o.id}
      `
      result.skipped_user_stopped.push(o.session_id ?? o.id)
      continue
    }

    // (b) restart-count cap.
    if (typeof o.restart_count === 'number' && o.restart_count >= MAX_RESTART_COUNT) {
      await sql`
        UPDATE session_runs
        SET ended_at = now(), exit_reason = 'max_restarts_exceeded'
        WHERE id = ${o.id}
      `
      result.skipped_max_restarts.push(o.id)
      continue
    }

    // (c) End the orphan FIRST so it doesn't count against the cap when we
    //     reserve a slot for its replacement.
    await sql`UPDATE session_runs SET ended_at = now(), exit_reason = 'reboot' WHERE id = ${o.id}`

    // (d) Reserve a slot.
    const reservation = await reserveSessionSlot(userId, supervisorId)
    if (!reservation.ok) {
      result.skipped_capacity.push(o.id)
      continue
    }

    // (e) Create the new run row and send session.start to the live socket.
    const newRun = await sql`
      INSERT INTO session_runs (user_id, supervisor_id, repo_path, branch, pulled, initial_prompt, restart_of)
      VALUES (${userId}, ${supervisorId}, ${o.repo_path}, ${o.branch}, false, ${null}, ${o.id})
      RETURNING id
    `
    const newRunId = newRun[0].id

    const entry = getSupervisor(supervisorId)
    if (!entry) {
      // Race: supervisor went offline between picking it and sending. Treat as
      // no-supervisor. The new run row is left open; the next reconnect will
      // pick it up via the supervisor.hello path.
      result.skipped_no_supervisor.push(o.id)
      continue
    }

    try {
      entry.ws.send(JSON.stringify({
        type: 'session.start',
        req_id: newRunId,
        run_id: newRunId,
        repo_path: o.repo_path,
        branch: o.branch ?? undefined,
        pull: false,
        api_key: '__use_local__',
        hub_url: '__same__',
      }))
      result.resumed.push(newRunId)
    } catch (err: any) {
      console.error('[orphan-resume] send failed run=' + newRunId, err?.message)
      result.skipped_no_supervisor.push(o.id)
    }
  }

  return result
}

/**
 * Supervisor-scoped path — called from agent.ts supervisor.hello.
 *
 * The supervisor just reconnected. Resume all open runs for THIS supervisor.
 */
export async function resumeOrphansForSupervisor(args: {
  userId: string
  supervisorId: string
}): Promise<ResumeResult> {
  const { sql } = await import('../db/postgres')
  return resumeOrphansInner({ sql, userId: args.userId, supervisorId: args.supervisorId })
}

// ── Rate-limit: at most one client-driven resume sweep per (userId, 60s). ────
const recentClientResumeAt = new Map<string, number>()
const CLIENT_RESUME_WINDOW_MS = 60_000

/**
 * User-scoped path — called from client.ts on web client auth_ok.
 *
 * The user just connected a browser. Across every supervisor currently online
 * for this user, sweep open runs and resume them. Rate-limited to once per
 * (user, 60s) to avoid spamming supervisors when the user mashes refresh.
 *
 * Returns merged result. `skipped_no_supervisor` here covers the case where
 * NO supervisor is online for the user at all — the function returns early.
 */
export async function resumeOrphanSessionsForUser(userId: string): Promise<ResumeResult> {
  const result = emptyResult()

  // Rate-limit.
  const now = Date.now()
  const last = recentClientResumeAt.get(userId) ?? 0
  if (now - last < CLIENT_RESUME_WINDOW_MS) {
    return result
  }
  recentClientResumeAt.set(userId, now)

  // Pick online supervisors for this user.
  const supervisorIds = listOnlineSupervisorIdsForUser(userId)
  if (supervisorIds.length === 0) {
    // Nothing online → nothing to resume right now. The supervisor.hello path
    // will catch them on reconnect.
    return result
  }

  const { sql } = await import('../db/postgres')

  for (const supervisorId of supervisorIds) {
    try {
      const r = await resumeOrphansInner({ sql, userId, supervisorId })
      result.resumed.push(...r.resumed)
      result.skipped_user_stopped.push(...r.skipped_user_stopped)
      result.skipped_no_supervisor.push(...r.skipped_no_supervisor)
      result.skipped_capacity.push(...r.skipped_capacity)
      result.skipped_max_restarts.push(...r.skipped_max_restarts)
      result.finalized_stale.push(...r.finalized_stale)
    } catch (err: any) {
      console.error(`[orphan-resume] sweep failed supervisor=${supervisorId}`, err?.message)
    }
  }

  return result
}

// Test-only: clear the rate-limit map.
export function __resetClientResumeRateLimit() {
  recentClientResumeAt.clear()
}
