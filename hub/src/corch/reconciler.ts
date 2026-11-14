// hub/src/corch/reconciler.ts
//
// CORCH-01 (CORCH-R3.3, R3.6, R3.7): the ONLY periodic loop under hub/src/corch/. Every pass reads one page
// of at most 100 live runs (stable id order, a cursor carried between passes so unknown-inventory runs
// that stay `stalled` cannot starve the rest) and applies positive knowledge only (LD-13): a run is
// reclaimed when a FRESH inventory proves its session is gone, never because nothing is known. No
// fresh inventory marks it stalled once, with one owner notification. A hub restart therefore never
// reclaims, and never double-launches (the live-run unique indexes and the cap see the old run).

import { corchEnabled, corchLeaseMs, corchReconcileIntervalMs } from './flag.ts'
import { getCorch, type CorchDeps, type CorchDispatcher } from './dispatcher.ts'
import type { LiveRun } from './store.ts'
import { startGsdcIngest } from './gsdc-boot.ts'

const PASS_LIMIT = 100

let passRunning = false
/** Id of the last run the previous pass read; null = start from the first run. Reset when a page is short. */
let cursor: string | null = null

/** One reconcile pass. Returns immediately while the flag is OFF or another pass is still running. */
export async function reconcilePass(deps: CorchDeps, d: CorchDispatcher): Promise<void> {
  if (!corchEnabled()) return
  if (passRunning) return
  passRunning = true
  try {
    const now = Date.now()
    const lease = corchLeaseMs()
    const alive: string[] = []
    const aliveRuns: LiveRun[] = []
    const runs: LiveRun[] = await deps.store.liveRunsPage(cursor, PASS_LIMIT)
    // A full page continues after its last run next pass; a short page means the walk is complete.
    cursor = runs.length >= PASS_LIMIT ? runs[runs.length - 1]!.id : null
    for (const run of runs) {
      // A launch this process is still performing is not a candidate.
      if (d.inFlight.has(run.work_item_id)) continue

      // Launch needs a session id, so a run without one never launched anything: free it. It still consumes
      // an attempt so a deterministic crash/throw before the session is attached is bounded (blocked + one
      // notification) instead of re-claimed forever with attempts stuck at 0 (QC MED 2).
      if (!run.session_id) {
        if (now - new Date(run.started_at).getTime() > lease) await d.reclaimRun(run, 'claim_orphaned', true)
        continue
      }

      // Absence is proven ONLY by the owning supervisor's own fresh inventory (LD-13). A run with no
      // supervisor_id (hub crashed between launch and markRunLaunched) has no owner on record: another
      // supervisor's inventory can show it ALIVE, but never that it is gone (it may live on a supervisor
      // whose inventory is unavailable), so it can only stall, never be reclaimed.
      const owner = run.supervisor_id ? deps.inventory.forSupervisor(run.supervisor_id) : null
      const known = owner ?? deps.inventory.forUser(run.user_id)
      if (known.fresh && known.sessionIds.has(run.session_id)) {
        alive.push(run.id)
        aliveRuns.push(run)
        continue
      }
      if (now - new Date(run.heartbeat_at).getTime() <= lease) continue
      if (owner?.fresh) await d.reclaimRun(run, 'session_absent', true)
      else await d.stallRun(run)
    }
    if (alive.length > 0) await deps.store.touchHeartbeat(alive)
    // CORCH-09 (R3.8): the memlog claim is heartbeated from the same liveness signal. Best effort, never throws.
    for (const run of aliveRuns) await deps.workspace.heartbeat?.({ itemId: run.work_item_id, repoIdent: run.repo_ident }).catch(() => {})
    // Items waiting on their PR have no live run but still hold their claim until AAF closes them.
    try {
      for (const it of (await deps.store.prOpenItems?.(500)) ?? []) {
        await deps.workspace.heartbeat?.({ itemId: it.id, repoIdent: it.repo_ident }).catch(() => {})
      }
    } catch (err: any) {
      console.error(`[corch] pr_open heartbeat pass failed: ${err?.message ?? err}`)
    }
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

/**
 * Start the reconciler and evaluate the backlog that is ALREADY due once, event-driven: work whose
 * backoff or not_before expired while the hub was down gets no other trigger. evaluateAll() re-arms the
 * single not_before timer for the next future deadline when it finishes. No new loop (R3.6).
 */
export async function startCorchWith(d: CorchDispatcher): Promise<() => void> {
  if (!corchEnabled()) return () => {}
  const stop = startCorchReconciler(d.deps, d)
  await d.evaluateAll()
  return stop
}

/** Boot start: when enabled, build the singleton, start the reconciler, evaluate due backlog and arm the timer once. */
export async function startCorch(): Promise<void> {
  if (!corchEnabled()) return
  if (started) return
  started = true
  await startCorchWith(await getCorch())
  // CORCH-04: gsd-console SSE ingest (event-driven; a no-op unless REMO_CORCH_GSDC_URL and _TOKEN are set).
  startGsdcIngest()
}
