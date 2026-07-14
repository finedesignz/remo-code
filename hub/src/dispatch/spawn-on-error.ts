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
 *      true (pipeline proceeds to send). Timeout → proactively `endRun` +
 *      `releaseSessionSlot` to free the slot NOW (HIGH-1 leak fix) and return
 *      false; the pipeline falls back to park/skip — the drained grace replay
 *      (or, if the supervisor was merely slow and brings the runner up later,
 *      its own first turn) handles the repair.
 *
 * Leak-safety summary: the only place a run row is created is step 4, guarded by
 * the same reserve→create→send→(release-on-failure) sequence the web/start and
 * supervisors/start endpoints use. EVERY outcome closes/frees the slot on a
 * bounded, connection-independent timescale: a reservation at capacity creates
 * nothing; createRun-throw releases; send-throw endRun+releases; success →
 * supervisor `runner.exit` closes it; TIMEOUT → we proactively endRun+release
 * (the spawn-on-error run has `session_id=null`, so the in-band
 * close-by-session path can never reap it — the proactive close is what bounds
 * it to MINUTES, not the 24h reconnect sweep). NO path leaves a NULL-session
 * run open past the timeout.
 *
 * Single-replica assumption (MED-1): the in-process `spawningSessions` lock
 * (below) is the double-spawn guard. It is correct WITHIN one process (the
 * has()/add() is synchronous — no await between them). The hub Dockerfile runs
 * a single `bun hub/src/index.ts` process and prod is deployed single-replica
 * on Coolify, so a cross-process lock is unnecessary. The cap reservation
 * (`reserveSessionSlot`) IS cross-process (`FOR UPDATE`), and the supervisor's
 * own `duplicate_run` guard is a final backstop. FOLLOW-UP: if the hub is ever
 * scaled to >1 replica, replace this Set with a DB advisory lock /
 * `INSERT ... ON CONFLICT` sentinel keyed by session_id.
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
    const { endRun } = await import('../db/supervisor-dal.ts')
    const { sendToSupervisor } = await import('../ws/supervisor-registry.ts')

    // Concurrency gate — SAME hub-authoritative reservation every start sender
    // uses, with the run row consumed INSIDE the reservation tx (closes the
    // over-admission race). At capacity → no run row, no leak, park/skip.
    let reservation
    try {
      reservation = await reserveSessionSlot(userId, supervisorId, {
        sessionId: null,
        repoPath: cwd,
        branch: null,
        pulled: false,
        initialPrompt: null,
      })
    } catch (err: any) {
      log.error('spawn_on_error.create_run_failed', {
        user_id: userId,
        session_id: sessionId,
        error: err?.message ?? String(err),
      })
      return false
    }
    if (!reservation.ok) {
      log.info('spawn_on_error.reserve_denied', {
        user_id: userId,
        session_id: sessionId,
        reason: reservation.reason,
      })
      return false
    }
    if (!reservation.run) {
      log.error('spawn_on_error.create_run_failed', {
        user_id: userId,
        session_id: sessionId,
        error: 'no run row returned',
      })
      return false
    }
    const runId = reservation.run.id

    // MACHINE-TRIGGERED path: this wake is driven by error-capture / feedback intake
    // (untrusted, anonymous-reachable), never by a human. It never runs with
    // permission prompts disabled, whatever the session row's default says.
    const skipPerms = false
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
        dangerously_skip_permissions: skipPerms,
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

    // HIGH-2: do NOT pre-emptively set the supervisor row to
    // state='starting', current_run_id=<our runId>. If the supervisor's cap
    // is >1 it may already have a live run, and forcing the row here clobbers
    // that run's current_run_id, desyncing the UI from the actually-active
    // run. The supervisor's own `status` announcements (handled in
    // ws/agent.ts) carry the real run_id and are authoritative — let them own
    // lifecycle state. Spawn-on-error must not author supervisor state.

    log.info('spawn_on_error.started', {
      user_id: userId,
      session_id: sessionId,
      supervisor_id: supervisorId,
      run_id: runId,
    })

    const online = await waitForOnline(sessionId, Date.now() + spawnTimeoutMs())
    if (online) {
      log.info('spawn_on_error.online', {
        user_id: userId,
        session_id: sessionId,
        run_id: runId,
      })
      return online
    }

    // HIGH-1 (the leak fix): on TIMEOUT, proactively finalize the run instead
    // of leaving it open for the supervisor. The created row has
    // session_id=null, so the in-band close-by-session path
    // (endOpenRunsForSession) can NEVER reach it — if the supervisor silently
    // dropped `session.start` (its own concurrency gate, not_git_repo, parse
    // mismatch, or any path that never echoes run_id back), this row would sit
    // `ended_at IS NULL`, counting against the concurrency cap, until WS-close
    // or the 24h reconnect stale-sweep. Repeated errors against an idle/
    // declining supervisor would accumulate NULL-session open rows → cap
    // exhaustion → blocks ALL launches incl. orchestrator (the known
    // at_capacity orphan-run leak class).
    //
    // So we write ended_at NOW (frees the slot, connection-independent,
    // minutes-scale bound = the timeout itself) and fall back to park/skip,
    // which the pipeline already does on `false`. If the supervisor genuinely
    // did spawn a runner for this run_id and is merely slow, closing the row
    // is harmless: there is no in-flight hub turn expected on this run (the
    // pipeline parked), and the supervisor's `duplicate_run` guard /
    // `runner.exit` reconciliation tolerate the already-closed row.
    try {
      await endRun(runId, null, 'spawn_on_error_timeout')
    } catch (err: any) {
      log.error('spawn_on_error.timeout_endrun_failed', {
        user_id: userId,
        session_id: sessionId,
        run_id: runId,
        error: err?.message ?? String(err),
      })
    }
    await releaseSessionSlot(userId, supervisorId)
    log.info('spawn_on_error.timeout', {
      user_id: userId,
      session_id: sessionId,
      run_id: runId,
    })
    return online
  } finally {
    spawningSessions.delete(sessionId)
  }
}
