/**
 * Spawn-on-error — lazy-start an OFFLINE-but-existing session so an inbound
 * repair (error-capture dispatch, or any pipeline caller that opts in) actually
 * auto-repairs instead of finalizing `skipped/session_offline`.
 *
 * This is the `ensureOnline` adapter the dispatch pipeline (`pipeline.ts`) calls
 * INSIDE the offline-park branch — i.e. only AFTER every gate has passed
 * (cost-cap / threshold / dedupe / rate-limit are non-bypassable and run first;
 * a cost-capped or deduped repair never reaches here). When the target session
 * exists but has no live agent socket, we:
 *
 *   1. Bail unless `REMO_SPAWN_ON_ERROR` is enabled (default OFF → dormant).
 *   2. Resolve the session's supervisor target + working dir. A supervisor MUST
 *      be connected for this user, else we give up → pipeline parks/skips.
 *   3. Reserve a concurrency slot via the SAME hub-authoritative gate every
 *      start sender uses (`reserveSessionSlot`). At capacity → give up cleanly
 *      (NO run row created, NO leak).
 *   4. `createRun` + fire the canonical `session.start` directive (NOT the dead
 *      `session.launch` drift). On send failure → `endRun` + `releaseSessionSlot`
 *      so the run row never sits open (the at-capacity orphan-run leak class).
 *   5. Poll for the agent socket to appear up to a bounded timeout
 *      (`REMO_SPAWN_ON_ERROR_TIMEOUT_MS`, default 25s). Online in time → return
 *      true (pipeline proceeds to send). Timeout → return false; the run we
 *      created is a REAL spawning run (the supervisor owns its lifecycle and
 *      will close it on exit), and the pipeline falls back to park/skip — the
 *      drained grace replay (or the spawned runner's own first turn) handles the
 *      repair. We do NOT force-close a run that may still be coming up.
 *
 * Runaway guard: at most ONE in-flight spawn per session (an in-memory lock).
 * A second repair for a session already spawning skips the start and just waits
 * on / falls through with the existing attempt.
 *
 * Leak-safety summary: the only place a run row is created is step 4, guarded by
 * the same reserve→create→send→(release-on-failure) sequence the web/start and
 * supervisors/start endpoints use. A reservation that wins but whose send throws
 * is released; a reservation at capacity creates nothing.
 */
import { getChannel } from '../ws/registry.ts'
import { log } from '../observability/logger.ts'

// Heavy deps (supervisor-registry, budget, DAL) are imported LAZILY inside the
// function below — not statically — so that merely importing this module (e.g.
// via the error-capture dispatcher's `ensureOnline` dep) does NOT pull the
// supervisor-registry → registry.broadcastToUser graph into every caller's
// module graph. This keeps subsystem unit tests (which mock `ws/registry.ts`
// with a minimal surface) from breaking on a transitive export they never use,
// and mirrors the dynamic-import pattern in `ws/agent.ts`. The flag-OFF /
// already-online fast paths return before any of these are loaded.

/** Feature flag — OFF by default; ships dormant until deliberately enabled. */
export function spawnOnErrorEnabled(): boolean {
  return process.env.REMO_SPAWN_ON_ERROR === '1' || process.env.REMO_SPAWN_ON_ERROR === 'true'
}

function spawnTimeoutMs(): number {
  const raw = Number(process.env.REMO_SPAWN_ON_ERROR_TIMEOUT_MS)
  return Number.isFinite(raw) && raw > 0 ? raw : 25_000
}

const POLL_INTERVAL_MS = 500

/** Sessions with an in-flight spawn attempt (runaway guard). */
const spawningSessions = new Set<string>()

/** Test-only reset. */
export function _resetSpawnLocks(): void {
  spawningSessions.clear()
}

/**
 * Resolve the supervisor + working dir to start `sessionId` for `userId`.
 * Returns null when no supervisor is connected or no working dir is known.
 *
 * v1: first online supervisor for the user (mirrors `POST /sessions/:id/launch`
 * — multi-host targeting is out of scope). Working dir = the session's recorded
 * `project_dir` (the supervisor binds the spawned runner to the session row by
 * project_dir match, identical to every other start sender).
 */
async function resolveStartTarget(
  userId: string,
  sessionId: string,
): Promise<{ supervisorId: string; cwd: string } | null> {
  const { listOnlineSupervisorIdsForUser, isSupervisorOnline } = await import(
    '../ws/supervisor-registry.ts'
  )
  const { getSession } = await import('../db/dal.ts')

  const supervisorIds = listOnlineSupervisorIdsForUser(userId)
  if (supervisorIds.length === 0) return null
  const supervisorId = supervisorIds[0]
  if (!isSupervisorOnline(supervisorId)) return null

  const session = await getSession(sessionId, userId)
  if (!session) return null
  const cwd = (session as any).project_dir as string | null
  if (!cwd) return null

  return { supervisorId, cwd }
}

async function waitForOnline(sessionId: string, deadline: number): Promise<boolean> {
  while (Date.now() < deadline) {
    if (getChannel(sessionId) != null) return true
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
  }
  return getChannel(sessionId) != null
}

/**
 * Lazy-start `sessionId` and wait (bounded) for its agent socket to appear.
 * Returns true iff the session is online by the deadline. Every early-exit path
 * (flag off, already online, no supervisor, at capacity, already spawning,
 * resolve failure) returns false WITHOUT leaking a run row.
 *
 * Intended to be passed as the pipeline's `ensureOnline` dep. Safe to call even
 * when the session is already online (returns true immediately).
 */
export async function ensureSessionOnline(userId: string, sessionId: string): Promise<boolean> {
  // Fast path: already online (e.g. raced online between isOnline and here).
  if (getChannel(sessionId) != null) return true
  if (!spawnOnErrorEnabled()) return false

  // Runaway guard: one spawn per session at a time. A concurrent repair for a
  // session already spawning just waits for the existing attempt to land. The
  // check-and-set is SYNCHRONOUS (no await between has() and add()) so two
  // concurrent callers can't both pass the guard and double-start.
  if (spawningSessions.has(sessionId)) {
    return waitForOnline(sessionId, Date.now() + spawnTimeoutMs())
  }
  spawningSessions.add(sessionId)

  try {
    const target = await resolveStartTarget(userId, sessionId)
    if (!target) {
      log.info('spawn_on_error.no_target', { user_id: userId, session_id: sessionId })
      return false
    }
    const { supervisorId, cwd } = target

    const { reserveSessionSlot, releaseSessionSlot } = await import('../sessions/budget.ts')
    const { createRun, endRun } = await import('../db/supervisor-dal.ts')
    const { sendToSupervisor, updateSupervisorState } = await import('../ws/supervisor-registry.ts')

    // Concurrency gate — SAME hub-authoritative reservation every start sender
    // uses. At capacity → no run row, no leak, fall back to park/skip.
    const reservation = await reserveSessionSlot(userId, supervisorId)
    if (!reservation.ok) {
      log.info('spawn_on_error.reserve_denied', {
        user_id: userId,
        session_id: sessionId,
        reason: reservation.reason,
      })
      return false
    }

    // Create the run row INSIDE the reservation window, exactly like the web
    // start path. On any failure below, release the slot + end the run so we
    // never leave a wedged open run.
    let runId: string
    try {
      const run = (await createRun({
        userId,
        sessionId: null,
        supervisorId,
        repoPath: cwd,
        branch: null,
        pulled: false,
        initialPrompt: null,
      })) as { id: string }
      runId = run.id
    } catch (err: any) {
      await releaseSessionSlot(userId, supervisorId)
      log.error('spawn_on_error.create_run_failed', {
        user_id: userId,
        session_id: sessionId,
        error: err?.message ?? String(err),
      })
      return false
    }

    try {
      sendToSupervisor(supervisorId, {
        type: 'session.start',
        req_id: runId,
        run_id: runId,
        repo_path: cwd,
        branch: undefined,
        pull: false,
        initial_prompt: undefined,
        api_key: '__use_local__',
        hub_url: '__same__',
      } as any)
    } catch (err: any) {
      // Send failed → the run never began. End it + release the slot so the
      // open-run count can't strand at the cap (orphan-run leak class).
      try {
        await endRun(runId, null, `spawn_on_error_dispatch_failed: ${err?.message ?? 'unknown'}`)
      } catch {}
      await releaseSessionSlot(userId, supervisorId)
      log.error('spawn_on_error.dispatch_failed', {
        user_id: userId,
        session_id: sessionId,
        error: err?.message ?? String(err),
      })
      return false
    }

    try {
      await updateSupervisorState(supervisorId, 'starting', runId)
    } catch {}

    log.info('spawn_on_error.started', {
      user_id: userId,
      session_id: sessionId,
      supervisor_id: supervisorId,
      run_id: runId,
    })

    const online = await waitForOnline(sessionId, Date.now() + spawnTimeoutMs())
    log.info(online ? 'spawn_on_error.online' : 'spawn_on_error.timeout', {
      user_id: userId,
      session_id: sessionId,
      run_id: runId,
    })
    // On timeout we deliberately leave the run row alone: it is a genuine
    // spawning run whose lifecycle the supervisor owns (it will close it on
    // exit). The pipeline falls back to park/skip; the grace drain (or the
    // runner's own first turn after it finishes coming up) handles the repair.
    return online
  } finally {
    spawningSessions.delete(sessionId)
  }
}
