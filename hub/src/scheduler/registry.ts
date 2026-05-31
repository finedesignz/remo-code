/**
 * Scheduler registry (W2/T5). Owns the in-memory map of croner jobs keyed by
 * scheduled_tasks.id. Each job's callback delegates to the dispatcher.
 *
 * A task may have MULTIPLE rules (`schedule_rules` array on the task row).
 * Each rule arms its own Cron registration; all rules route to the same
 * `dispatcher.fire(taskId)`. A short cross-rule dedupe window prevents two
 * rules whose cron expressions overlap from double-firing.
 *
 * Distinct from the legacy v0 scheduler at `hub/src/scheduler/index.ts`.
 */
import { Cron } from 'croner'
import {
  type ScheduledTask,
  listEnabledTasks,
  getTaskById,
  setTaskFireTimestamps,
} from '../db/scheduled-tasks-dal.ts'
import { ruleToCron, shouldSkipFire, type ScheduleRule } from './schedule-rules.ts'

type Dispatcher = typeof import('./dispatcher.ts')
let _dispatcher: Dispatcher | null = null
async function dispatcher(): Promise<Dispatcher> {
  if (_dispatcher) return _dispatcher
  _dispatcher = await import('./dispatcher.ts')
  return _dispatcher
}

const jobs = new Map<string, Cron[]>()
const lastFireAt = new Map<string, number>()
const DEDUPE_WINDOW_MS = 5000

export function get(taskId: string): Cron | undefined { return jobs.get(taskId)?.[0] }
export function size(): number { return jobs.size }

export function nextRunFor(taskId: string): Date | null {
  const list = jobs.get(taskId)
  if (!list || list.length === 0) return null
  let best: Date | null = null
  for (const j of list) {
    try {
      const n = j.nextRun()
      if (n && (!best || n.getTime() < best.getTime())) best = n
    } catch {}
  }
  return best
}

export async function loadAll(): Promise<number> {
  const tasks = await listEnabledTasks()
  for (const t of tasks) registerInternal(t)
  console.log(`[scheduler.registry] loaded ${tasks.length} enabled task(s)`)
  return tasks.length
}

export function register(task: ScheduledTask): void { registerInternal(task) }

export async function replace(taskId: string): Promise<void> {
  unregister(taskId)
  const t = await getTaskById(taskId)
  if (t && t.enabled) registerInternal(t)
}

export function unregister(taskId: string): void {
  const list = jobs.get(taskId)
  if (!list) return
  for (const j of list) { try { j.stop() } catch {} }
  jobs.delete(taskId)
  lastFireAt.delete(taskId)
}

export function pauseAll(): void {
  for (const [, list] of jobs) for (const j of list) { try { j.pause() } catch {} }
}

export function resumeAll(): void {
  for (const [, list] of jobs) for (const j of list) { try { j.resume() } catch {} }
}

function registerInternal(task: ScheduledTask): void {
  const existing = jobs.get(task.id)
  if (existing) { for (const j of existing) { try { j.stop() } catch {} } ; jobs.delete(task.id) }
  if (!task.enabled) return
  const tz = task.timezone || 'UTC'

  // Resolve schedule sources, in priority:
  //   1) task.schedule_rules (new shape)
  //   2) task.cron_expr / cron_expression (legacy)
  const rules: ScheduleRule[] = Array.isArray(task.schedule_rules) ? task.schedule_rules : []
  const legacyExpr = task.cron_expr || task.cron_expression

  const armed: Cron[] = []

  const armCron = (expr: string, rule: ScheduleRule | null) => {
    try {
      const job = new Cron(expr, { timezone: tz, protect: true, paused: false }, async () => {
        // Cross-rule dedupe — if any rule for this task fired within the
        // dedupe window, drop this fire.
        const now = Date.now()
        const last = lastFireAt.get(task.id) ?? 0
        if (now - last < DEDUPE_WINDOW_MS) return
        // Rule-level skip gate (start_at + weekly/monthly interval anchoring +
        // active-window). Pass the task timezone so window bounds resolve in
        // task-local wall-clock time.
        if (rule && shouldSkipFire(rule, new Date(now), tz)) return
        lastFireAt.set(task.id, now)
        try {
          const d = await dispatcher()
          await d.fire(task.id)
        } catch (err: any) {
          console.error(`[scheduler.registry] fire failed task=${task.id}: ${err?.message ?? err}`)
        }
      })
      armed.push(job)
    } catch (err: any) {
      console.error(`[scheduler.registry] arm failed task=${task.id} expr=${expr}: ${err?.message ?? err}`)
    }
  }

  if (rules.length > 0) {
    for (const r of rules) armCron(ruleToCron(r, tz), r)
  } else if (legacyExpr) {
    armCron(legacyExpr, null)
  } else {
    console.error(`[scheduler.registry] task=${task.id} has no schedule_rules or cron expression`)
    return
  }

  if (armed.length === 0) return
  jobs.set(task.id, armed)

  // Record the soonest next fire across all rules.
  let nextOverall: Date | null = null
  for (const j of armed) {
    try {
      const n = j.nextRun() ?? null
      if (n && (!nextOverall || n.getTime() < nextOverall.getTime())) nextOverall = n
    } catch {}
  }
  void setTaskFireTimestamps(task.id, task.last_fire_at ? new Date(task.last_fire_at) : null, nextOverall)
}
