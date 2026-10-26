/**
 * The ONE disconnect (stop) of a session, shared by every stop route:
 *
 *   - POST /api/sessions/:id/disconnect   (the human, cookie/JWT)
 *   - POST /api/ext/sessions/:id/stop     (an `ext:launch` api key)
 *
 * Both call this function so their behaviour cannot drift. It takes a RUNNING session
 * OFFLINE without removing it (the row is KEPT, `deleted_at` stays NULL, so a later launch
 * of the same session id resumes the same history):
 *
 *   1. Send `{type:'shutdown', reason:'user_disconnect'}` to the session's channel so the
 *      SessionBridge stops the runner (SIGINT -> SIGKILL).
 *   2. End every open `session_runs` row with exit_reason `user_disconnect` so the
 *      concurrency slot is freed. This reason is load-bearing: the orphan-resume path
 *      (`orchestrator/orphan-resume.ts` NON_RESUMABLE_EXIT_REASONS) never resurrects a run
 *      that ended with it, so a stopped session stays stopped.
 *   3. Mark the session status `offline`.
 *   4. Close the socket (code 4011) after a 5 s grace for the runner to exit.
 *
 * Idempotent. The caller has already ownership-checked the session and passes the status it
 * read, so `alreadyOffline` is true exactly when the session was offline, had no live
 * channel and no open run - nothing was stopped.
 *
 * The kill switch (automation controls) is deliberately NOT consulted: a halt must never
 * prevent a stop.
 */
import { markSessionOffline } from '../db/dal'
import { getChannel } from '../ws/registry'

/** The exit reason written on every open run; also what orphan-resume treats as "do not resume". */
export const USER_DISCONNECT_REASON = 'user_disconnect'

export interface DisconnectResult {
  /** True when there was nothing to stop: offline, no channel, no open run. */
  alreadyOffline: boolean
}

export async function disconnectSession(args: {
  sessionId: string
  userId: string
  /** The `sessions.status` the caller read when it ownership-checked the session. */
  status: string | null | undefined
}): Promise<DisconnectResult> {
  const { sessionId, userId } = args

  // Tell the runner to shut down (best-effort; offline sessions have no channel).
  const channel = getChannel(sessionId)
  if (channel) {
    try {
      channel.ws.send(JSON.stringify({ type: 'shutdown', reason: USER_DISCONNECT_REASON }))
    } catch {}
  }

  // End open runs so the slot is freed. Best-effort - never blocks the offline
  // transition (the supervisor's runner.exit / #223 reconcile is the backstop).
  let endedRuns: number | null = null
  try {
    const { endOpenRunsForSession } = await import('../db/supervisor-dal.ts')
    endedRuns = await endOpenRunsForSession(sessionId, userId, USER_DISCONNECT_REASON)
  } catch (err: any) {
    console.error('[sessions.disconnect] failed to end open runs', err?.message)
  }

  // KEEP the row - status offline only, never soft-delete.
  await markSessionOffline(sessionId, userId)

  // Give the runner ~5s to exit gracefully before forcibly closing the socket.
  if (channel) {
    setTimeout(() => {
      const ch = getChannel(sessionId)
      if (ch) {
        try { ch.ws.close(4011, 'session disconnected by user') } catch {}
      }
    }, 5_000)
  }

  return { alreadyOffline: args.status === 'offline' && !channel && endedRuns === 0 }
}
