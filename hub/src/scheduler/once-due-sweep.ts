/**
 * Once-due sweep (milestone once) — the DURABLE, tick-based source of truth for
 * immediate/one-time tasks. Mirrors the shape of the other boot-started sweeps
 * (run-reaper / work-reaper): a periodic `setInterval` that queries DUE
 * `schedule_kind='once'` rows (`run_at <= now AND enabled = true`) and fires each
 * via `dispatcher.fire`.
 *
 * WHY THIS EXISTS (ai-review finding #2 — silent accept-never-dispatch):
 * The registry arms an immediate once task with `setTimeout(0)` for low latency,
 * but a timer is NOT durable — if the process dies between create and the
 * callback, or the fire throws before `claimOnceTask`, or a route swallows a
 * `register()` error, the work item would be accepted (201 + a `work_runs` row)
 * and NEVER dispatched. This sweep closes that: the row stays `enabled=true` until
 * a fire CLAIMS it, so the NEXT tick re-arms AND re-fires it regardless of any
 * in-process timer. `dispatcher.fire` → `claimOnceTask` (atomic
 * `... AND enabled=true` UPDATE) makes the sweep and the setTimeout mutually
 * exclusive: exactly one dispatch, ever. The setTimeout is now purely a latency
 * optimization sitting on top of a correct standalone fallback.
 */
import { listDueOnceTasks } from '../db/scheduled-tasks-dal.ts'

function parsePositiveIntEnv(raw: string | undefined, fallback: number): number {
  if (raw == null || raw === '') return fallback
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

function envFlagOn(raw: string | undefined): boolean {
  if (raw == null) return false
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase())
}

/** Sweep cadence. Default 10s — short so an immediate once task fires promptly
 *  even if the setTimeout(0) optimization is lost. */
export function onceSweepIntervalMs(): number {
  return parsePositiveIntEnv(process.env.REMO_ONCE_SWEEP_INTERVAL_MS, 10_000)
}

export interface OnceSweepDeps {
  listDueOnceTasks: typeof listDueOnceTasks
  fire: (taskId: string) => Promise<void>
}

/**
 * One pass. Fires every DUE once task. `dispatcher.fire` claims-then-dispatches,
 * so a row already claimed by the setTimeout path (now enabled=false) is not
 * returned by `listDueOnceTasks` and, even if raced, loses the claim and no-ops.
 * Returns the ids it attempted to fire this pass.
 */
export async function sweepDueOnceTasks(
  now: number = Date.now(),
  deps?: Partial<OnceSweepDeps>,
): Promise<string[]> {
  const listFn = deps?.listDueOnceTasks ?? listDueOnceTasks
  const fireFn = deps?.fire ?? (async (id: string) => {
    const d = await import('./dispatcher.ts')
    await d.fire(id)
  })

  let ids: string[] = []
  try {
    ids = await listFn(new Date(now))
  } catch (err: any) {
    console.warn(`[once-sweep] due-load failed: ${err?.message ?? err}`)
    return []
  }
  for (const id of ids) {
    try {
      await fireFn(id)
    } catch (err: any) {
      // A thrown fire leaves the row enabled=true (claim not committed) → the
      // NEXT tick retries it. Never swallow silently into a drop.
      console.warn(`[once-sweep] fire failed task=${id}: ${err?.message ?? err}`)
    }
  }
  return ids
}

let sweepTimer: ReturnType<typeof setInterval> | null = null

/** Start the periodic once-due sweep (idempotent). No-op when
 *  REMO_ONCE_SWEEP_DISABLED is set (1|true|yes|on). */
export function startOnceDueSweep(): void {
  if (envFlagOn(process.env.REMO_ONCE_SWEEP_DISABLED)) {
    console.log('[once-sweep] disabled via REMO_ONCE_SWEEP_DISABLED — sweep not started')
    return
  }
  if (sweepTimer) return
  sweepTimer = setInterval(() => {
    sweepDueOnceTasks().catch((err) =>
      console.warn(`[once-sweep] sweep pass failed: ${err?.message ?? err}`),
    )
  }, onceSweepIntervalMs())
  ;(sweepTimer as any)?.unref?.()
}

/** Stop the periodic sweep (test hook / graceful shutdown). */
export function stopOnceDueSweep(): void {
  if (sweepTimer) {
    clearInterval(sweepTimer)
    sweepTimer = null
  }
}
