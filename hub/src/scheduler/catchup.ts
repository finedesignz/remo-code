/**
 * Catch-up on hub boot (W2/T11).
 *
 * For each enabled task, walk fires that should have happened between
 * `last_fire_at` (or `created_at`) and now. Cap at 100 to avoid blowing
 * up if the hub was off for weeks.
 *
 *   - `catchup_policy = 'skip'`     → batch-insert all missed as skipped(catchup)
 *   - `catchup_policy = 'run_once'` → dispatch only the most recent missed fire
 */
import { Cron } from 'croner'
import {
  listEnabledTasks,
  insertRunV2,
  type ScheduledTask,
} from '../db/scheduled-tasks-dal.ts'

const MAX_MISSED = 100

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
        const d = await import('./dispatcher.ts')
        // Record older missed slots as skipped so history is honest;
        // only re-fire the latest missed slot.
        for (let i = 0; i < missed.length - 1; i++) {
          await insertRunV2({
            task_id: t.id, user_id: t.user_id, status: 'skipped',
            scheduled_for: missed[i], target_kind: t.target_kind,
            target_id: t.target_id, error: 'catchup',
          })
          skipped++
        }
        await d.runNow(t.id, t.user_id, {})
        dispatched++
      } catch (err: any) {
        console.error(`[scheduler.catchup] dispatch failed task=${t.id}: ${err?.message}`)
      }
    } else {
      for (const at of missed) {
        try {
          await insertRunV2({
            task_id: t.id, user_id: t.user_id, status: 'skipped',
            scheduled_for: at, target_kind: t.target_kind,
            target_id: t.target_id, error: 'catchup',
          })
          skipped++
        } catch (err: any) {
          console.error(`[scheduler.catchup] insert failed task=${t.id}: ${err?.message}`)
        }
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
