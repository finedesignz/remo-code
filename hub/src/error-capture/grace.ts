/**
 * Error-capture offline-grace replay (W3/T4).
 *
 * Mirrors `hub/src/scheduler/grace.ts`. When `dispatchPendingError` finds the
 * target session offline, it parks the errorId here keyed by sessionId for
 * up to 10 minutes. On agent reconnect, `drainForSession` re-runs the
 * dispatcher for each parked errorId. Entries older than the TTL are
 * marked `skipped(target_offline_expired)`.
 *
 * In-memory only — best-effort across hub restarts (documented).
 */
import { updateErrorDispatchStatus } from '../db/error-capture-dal.ts'

interface Pending { errorId: string; expiresAt: number }

const TTL_MS = 10 * 60 * 1000
const SWEEP_INTERVAL_MS = 60_000

const bySession = new Map<string, Pending[]>()

export function register(sessionId: string, errorId: string): void {
  const list = bySession.get(sessionId) ?? []
  list.push({ errorId, expiresAt: Date.now() + TTL_MS })
  bySession.set(sessionId, list)
}

export async function drainForSession(sessionId: string): Promise<void> {
  const list = bySession.get(sessionId)
  if (!list || list.length === 0) return
  bySession.delete(sessionId)
  const now = Date.now()
  const { dispatchPendingError } = await import('./dispatcher.ts')
  for (const p of list) {
    if (p.expiresAt < now) {
      try {
        await updateErrorDispatchStatus(p.errorId, 'skipped', 'target_offline_expired')
      } catch (err: any) {
        console.error(`[error-capture.grace] expire mark failed error=${p.errorId}: ${err?.message ?? err}`)
      }
      continue
    }
    try {
      await dispatchPendingError(p.errorId)
    } catch (err: any) {
      console.error(`[error-capture.grace] replay failed error=${p.errorId}: ${err?.message ?? err}`)
    }
  }
}

function sweep(): void {
  const now = Date.now()
  for (const [sid, list] of bySession) {
    const live: Pending[] = []
    for (const p of list) {
      if (p.expiresAt < now) {
        void updateErrorDispatchStatus(p.errorId, 'skipped', 'target_offline_expired').catch(() => {})
      } else {
        live.push(p)
      }
    }
    if (live.length === 0) bySession.delete(sid)
    else bySession.set(sid, live)
  }
}

let sweepTimer: ReturnType<typeof setInterval> | null = null
export function startErrorGraceSweep(): void {
  if (sweepTimer) return
  sweepTimer = setInterval(sweep, SWEEP_INTERVAL_MS)
}
export function stopErrorGraceSweep(): void {
  if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = null }
}
