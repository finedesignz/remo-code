/**
 * Phase 12 Wave 4 — Launch a session's runner from Telegram.
 *
 * Mirrors the web `POST /api/supervisors/:id/start` mechanic verbatim:
 *
 *   1. Resolve the supervisor that owns the session (by hostname match
 *      against the user's supervisor list, or fall back to the user's
 *      single online supervisor when unambiguous).
 *   2. `reserveSessionSlot(userId, supervisorId)` — hub-authoritative
 *      concurrency gate. NO bypass: cost-cap / capacity is enforced.
 *   3. `createRun(...)` — persist the run row.
 *   4. `updateSupervisorState('starting', run.id)`.
 *   5. `sendToSupervisor({ type: 'session.start', ... })` with the
 *      `__use_local__` / `__same__` sentinels so the supervisor uses its
 *      local key + same-host hub URL.
 *
 * Returns a discriminated union the doctor flow translates into a
 * Telegram reply. No reply is sent from this module.
 */
import { sql } from '../db/postgres.ts'
import {
  listSupervisorsForUser,
} from '../db/supervisor-dal.ts'
import { reserveSessionSlot } from '../sessions/budget.ts'
import { getSessionSkipPermissions } from '../db/dal.ts'
import {
  isSupervisorOnline,
  sendToSupervisor,
  updateSupervisorState,
} from '../ws/supervisor-registry.ts'

export type LaunchResult =
  | { ok: true; runId: string; supervisorId: string; hostname: string; repoPath: string }
  | { ok: false; reason: 'session_not_found' }
  | { ok: false; reason: 'no_project_dir' }
  | { ok: false; reason: 'no_online_supervisor' }
  | { ok: false; reason: 'supervisor_ambiguous'; count: number }
  | { ok: false; reason: 'at_capacity'; running: number; cap: number }
  | { ok: false; reason: 'send_failed'; error: string }
  | { ok: false; reason: 'internal_error'; error: string }

interface SessionRow {
  id: string
  project_dir: string | null
  hostname: string | null
  is_orchestrator: boolean | null
}

/**
 * Pick the supervisor to launch on. We look up the session's `hostname`
 * column and find an ONLINE supervisor row for this user with the matching
 * hostname. If hostname is null on the session row, we fall back to "the
 * user's single online supervisor" when there's exactly one.
 */
async function pickSupervisorForSession(
  userId: string,
  session: SessionRow,
): Promise<
  | { ok: true; supervisorId: string; hostname: string }
  | { ok: false; reason: 'no_online_supervisor' | 'supervisor_ambiguous'; count?: number }
> {
  const sups = (await listSupervisorsForUser(userId)) as Array<{
    id: string
    hostname: string
  }>
  const online = sups.filter((s) => isSupervisorOnline(s.id))
  if (online.length === 0) return { ok: false, reason: 'no_online_supervisor' }

  if (session.hostname) {
    const match = online.find((s) => s.hostname === session.hostname)
    if (match) return { ok: true, supervisorId: match.id, hostname: match.hostname }
    // session has a hostname but no online sup matches → treat as offline.
    return { ok: false, reason: 'no_online_supervisor' }
  }

  if (online.length === 1) {
    return { ok: true, supervisorId: online[0]!.id, hostname: online[0]!.hostname }
  }
  return { ok: false, reason: 'supervisor_ambiguous', count: online.length }
}

export async function launchSessionForUser(args: {
  userId: string
  sessionId: string
}): Promise<LaunchResult> {
  try {
    const rows = await sql<SessionRow[]>`
      SELECT id, project_dir, hostname, is_orchestrator
        FROM sessions
       WHERE id = ${args.sessionId}
         AND user_id = ${args.userId}
         AND deleted_at IS NULL
       LIMIT 1
    `
    const session = rows[0]
    if (!session) return { ok: false, reason: 'session_not_found' }

    // Orchestrator sessions need the orchestrator-aware launch (mint key +
    // system prompt + the `orchestrator` session.start extension). A plain
    // session.start would spawn a non-orchestrator Claude with no hub key.
    if (session.is_orchestrator) {
      const { launchOrchestrator } = await import('../orchestrator/auto-launch.ts')
      const res = await launchOrchestrator({ userId: args.userId, requireEnabled: true, skipIfRunning: true })
      if (res.ok) {
        return { ok: true, runId: res.runId, supervisorId: res.supervisorId, hostname: '', repoPath: res.cwd }
      }
      switch (res.reason) {
        case 'already_running':
          // Treat as success — the doctor's deferred check confirms liveness.
          return { ok: true, runId: '', supervisorId: '', hostname: '', repoPath: '' }
        case 'at_capacity':
          return { ok: false, reason: 'at_capacity', running: res.running, cap: res.cap }
        case 'no_online_supervisor':
        case 'supervisor_has_no_roots':
          return { ok: false, reason: 'no_online_supervisor' }
        case 'send_failed':
          return { ok: false, reason: 'send_failed', error: res.error }
        case 'disabled':
          return { ok: false, reason: 'session_not_found' }
        default:
          return { ok: false, reason: 'internal_error', error: res.error }
      }
    }

    if (!session.project_dir) return { ok: false, reason: 'no_project_dir' }

    const pick = await pickSupervisorForSession(args.userId, session)
    if (!pick.ok) {
      if (pick.reason === 'supervisor_ambiguous') {
        return { ok: false, reason: 'supervisor_ambiguous', count: pick.count ?? 0 }
      }
      return { ok: false, reason: 'no_online_supervisor' }
    }

    // Concurrency gate — reserve + consume the run row atomically (one tx).
    const reservation = await reserveSessionSlot(args.userId, pick.supervisorId, {
      sessionId: null,
      repoPath: session.project_dir,
      branch: null,
      pulled: false,
      initialPrompt: null,
    })
    if (!reservation.ok) {
      if (reservation.reason === 'at_capacity') {
        return {
          ok: false,
          reason: 'at_capacity',
          running: reservation.running,
          cap: reservation.cap,
        }
      }
      return { ok: false, reason: 'no_online_supervisor' }
    }
    if (!reservation.run) {
      return { ok: false, reason: 'no_online_supervisor' }
    }

    const run = reservation.run
    await updateSupervisorState(pick.supervisorId, 'starting', run.id)

    const skipPerms = await getSessionSkipPermissions(session.id, args.userId)
    try {
      sendToSupervisor(pick.supervisorId, {
        type: 'session.start',
        req_id: run.id,
        run_id: run.id,
        repo_path: session.project_dir,
        branch: undefined,
        pull: false,
        initial_prompt: undefined,
        api_key: '__use_local__',
        hub_url: '__same__',
        dangerously_skip_permissions: skipPerms,
      } as any)
    } catch (err: any) {
      return { ok: false, reason: 'send_failed', error: err?.message ?? String(err) }
    }

    return {
      ok: true,
      runId: run.id,
      supervisorId: pick.supervisorId,
      hostname: pick.hostname,
      repoPath: session.project_dir,
    }
  } catch (err: any) {
    return { ok: false, reason: 'internal_error', error: err?.message ?? String(err) }
  }
}
