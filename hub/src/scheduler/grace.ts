/**
 * Reconnect grace dispatch (W2/T12).
 *
 * When a task fires but the target is offline, the dispatcher parks the
 * pending runId here keyed by target key (sessionId or supervisorId).
 * On reconnect, we drain matching pendings and dispatch them via runNow.
 * Entries older than 10 min are expired via a 60s sweep.
 *
 * In-memory only — best-effort across hub restarts (documented).
 */
import {
  getTaskById,
  getRun as getRunRow,
  updateRunStatus,
} from '../db/scheduled-tasks-dal.ts'

interface Pending { runId: string; expiresAt: number }

const TTL_MS = 10 * 60 * 1000
const SWEEP_INTERVAL_MS = 60_000

const byTarget = new Map<string, Pending[]>()

export function registerPending(targetKey: string, runId: string): void {
  const list = byTarget.get(targetKey) ?? []
  list.push({ runId, expiresAt: Date.now() + TTL_MS })
  byTarget.set(targetKey, list)
}

export async function drainForTarget(targetKey: string, userId: string): Promise<void> {
  const list = byTarget.get(targetKey)
  if (!list || list.length === 0) return
  byTarget.delete(targetKey)
  const now = Date.now()
  for (const p of list) {
    if (p.expiresAt < now) {
      await updateRunStatus(p.runId, {
        status: 'skipped', error: 'target_offline', finished_at: new Date(),
      })
      continue
    }
    try {
      const run = await getRunRow(p.runId, userId)
      if (!run) continue
      if (run.status !== 'pending') continue
      const task = await getTaskById(run.task_id)
      if (!task) {
        await updateRunStatus(p.runId, {
          status: 'failed', error: 'task_deleted', finished_at: new Date(),
        })
        continue
      }
      const { runNow } = await import('./dispatcher.ts')
      // Close the original pending row as replayed so history stays clean,
      // then dispatch fresh. The new run gets a new row via runNow.
      await updateRunStatus(p.runId, {
        status: 'skipped', error: 'replayed_on_reconnect', finished_at: new Date(),
      })
      await runNow(task.id, userId, {})
    } catch (err: any) {
      console.error(`[scheduler.grace] drain failed run=${p.runId}: ${err?.message ?? err}`)
    }
  }
}

function sweep(): void {
  const now = Date.now()
  for (const [key, list] of byTarget) {
    const live: Pending[] = []
    for (const p of list) {
      if (p.expiresAt < now) {
        void updateRunStatus(p.runId, {
          status: 'skipped', error: 'target_offline', finished_at: new Date(),
        }).catch(() => {})
      } else {
        live.push(p)
      }
    }
    if (live.length === 0) byTarget.delete(key)
    else byTarget.set(key, live)
  }
}

let sweepTimer: ReturnType<typeof setInterval> | null = null
export function startSweeper(): void {
  if (sweepTimer) return
  sweepTimer = setInterval(sweep, SWEEP_INTERVAL_MS)
}
export function stopSweeper(): void {
  if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = null }
}

startSweeper()
