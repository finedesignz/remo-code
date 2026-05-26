/**
 * Catch-up on hub boot (W2/T11).
 *
 * For each enabled task, walk fires that should have happened between
 * `last_fire_at` (or `created_at`) and now. Cap at MAX_MISSED.
 *
 *   - `catchup_policy = 'skip'`     → insert ONE consolidated skipped row
 *                                     summarising all missed fires.
 *   - `catchup_policy = 'run_once'` → insert ONE consolidated skipped row
 *                                     covering the older missed fires (if any),
 *                                     then dispatch the most recent slot live.
 *
 * Consolidation rationale: a hub that was offline for hours of a 4h-cadence
 * task should produce ONE "Skipped N missed fires" history row, not N
 * identical rows. See `consolidateMissed` for the row shape.
 */
import { Cron } from 'croner'
import {
  listEnabledTasks,
  insertRunV2,
  type ScheduledTask,
} from '../db/scheduled-tasks-dal.ts'

const MAX_MISSED = 1000

function computeMissed(task: ScheduledTask): Date[] {
  const expr = task.cron_expr || task.cron_expression
  if (!expr) return []
  const tz = task.timezone || 'UTC'
  const since = task.last_fire_at
    ? new Date(task.last_fire_at)
    : task.created_at ? new Date(task.created_at) : null
  if (!since) return []
  try {
    const c = new Cron(expr, { timezone: tz, paused: true })
    const out: Date[] = []
    let cursor: Date | undefined = since
    while (out.length < MAX_MISSED) {
      const next = c.nextRun(cursor)
      if (!next) break
      if (next.getTime() >= Date.now()) break
      out.push(next)
      cursor = new Date(next.getTime() + 1000)
    }
    c.stop()
    return out
  } catch {
    return []
  }
}

/**
 * Insert a single consolidated skipped row for N missed fires.
 *
 * Exported for tests — pure DAL adapter, no hub state.
 */
export async function consolidateMissed(
  task: ScheduledTask,
  missed: Date[],
): Promise<void> {
  if (missed.length === 0) return
  const first = missed[0]
  const last = missed[missed.length - 1]
  const n = missed.length
  const snippet =
    n === 1
      ? `Skipped 1 missed fire at ${first.toISOString()} during hub downtime`
      : `Skipped ${n} missed fires from ${first.toISOString()} to ${last.toISOString()} during hub downtime`
  await insertRunV2({
    task_id: task.id,
    user_id: task.user_id,
    status: 'skipped',
    scheduled_for: first,
    target_kind: task.target_kind,
    target_id: task.target_id,
    error: `hub_restart:${n}_missed`,
    output_snippet: snippet,
    started_at: first,
    finished_at: new Date(),
  })
}

export async function runOnce(): Promise<{
  tasks: number; missed: number; dispatched: number; skipped: number
}> {
  const tasks = await listEnabledTasks()
  let missedTotal = 0
  let dispatched = 0
  let skipped = 0
  for (const t of tasks) {
    const missed = computeMissed(t)
    if (missed.length === 0) continue
    missedTotal += missed.length

    if (t.catchup_policy === 'run_once') {
      try {
        // Older missed slots → ONE consolidated row (if any).
        const older = missed.slice(0, -1)
        if (older.length > 0) {
          await consolidateMissed(t, older)
          skipped += older.length
        }
        const d = await import('./dispatcher.ts')
        await d.runNow(t.id, t.user_id, {})
        dispatched++
      } catch (err: any) {
        console.error(`[scheduler.catchup] dispatch failed task=${t.id}: ${err?.message}`)
      }
    } else {
      try {
        await consolidateMissed(t, missed)
        skipped += missed.length
      } catch (err: any) {
        console.error(`[scheduler.catchup] consolidated insert failed task=${t.id}: ${err?.message}`)
      }
    }
  }
  if (missedTotal > 0) {
    console.log(
      `[scheduler.catchup] tasks=${tasks.length} missed=${missedTotal} dispatched=${dispatched} skipped=${skipped}`,
    )
  }
  return { tasks: tasks.length, missed: missedTotal, dispatched, skipped }
}
