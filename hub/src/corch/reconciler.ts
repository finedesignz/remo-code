// hub/src/corch/reconciler.ts
//
// CORCH-01 (CORCH-R3.3, R3.6, R3.7): the ONLY periodic loop under hub/src/corch/. Every pass reads at
// most 100 live runs (oldest heartbeat first) and applies positive knowledge only (LD-13): a run is
// reclaimed when a FRESH inventory proves its session is gone, never because nothing is known. No
// fresh inventory marks it stalled once, with one owner notification. A hub restart therefore never
// reclaims, and never double-launches (the live-run unique indexes and the cap see the old run).

import { corchEnabled, corchLeaseMs, corchReconcileIntervalMs } from './flag.ts'
import { getCorch, type CorchDeps, type CorchDispatcher } from './dispatcher.ts'
import type { LiveRun } from './store.ts'

const PASS_LIMIT = 100

let passRunning = false

/** One reconcile pass. Returns immediately while the flag is OFF or another pass is still running. */
export async function reconcilePass(deps: CorchDeps, d: CorchDispatcher): Promise<void> {
  if (!corchEnabled()) return
  if (passRunning) return
  passRunning = true
  try {
    const now = Date.now()
    const lease = corchLeaseMs()
    const alive: string[] = []
    const runs: LiveRun[] = await deps.store.liveRunsOldestHeartbeat(PASS_LIMIT)
    for (const run of runs) {
      // A launch this process is still performing is not a candidate.
      if (d.inFlight.has(run.work_item_id)) continue

      // Launch needs a session id, so a run without one never launched anything: free it, no attempt.
      if (!run.session_id) {
        if (now - new Date(run.started_at).getTime() > lease) await d.reclaimRun(run, 'claim_orphaned', false)
        continue
      }

      const known = run.supervisor_id ? deps.inventory.forSupervisor(run.supervisor_id) : deps.inventory.forUser(run.user_id)
      if (known.fresh && known.sessionIds.has(run.session_id)) {
        alive.push(run.id)
        continue
      }
      if (now - new Date(run.heartbeat_at).getTime() <= lease) continue
      if (known.fresh) await d.reclaimRun(run, 'session_absent', true)
      else await d.stallRun(run)
    }
    if (alive.length > 0) await deps.store.touchHeartbeat(alive)
  } finally {
    passRunning = false
  }
}

/**
 * Start the single interval. A no-op (no interval, no dep touched) while the flag is OFF.
 * Returns a stop function.
 */
export function startCorchReconciler(deps: CorchDeps, d: CorchDispatcher): () => void {
  if (!corchEnabled()) return () => {}
  const handle = setInterval(() => {
    void reconcilePass(deps, d).catch((err) => console.error(`[corch] reconcile pass failed: ${err?.message ?? err}`))
  }, corchReconcileIntervalMs())
  ;(handle as { unref?: () => void })?.unref?.()
  return () => clearInterval(handle)
}

let started = false

/** Boot start: when enabled, build the singleton, start the reconciler and arm the not_before timer once. */
export async function startCorch(): Promise<void> {
  if (!corchEnabled()) return
  if (started) return
  started = true
  const d = await getCorch()
  startCorchReconciler(d.deps, d)
  await d.armNotBeforeTimer()
}
