/**
 * Scheduler registry (W2/T5). Owns the in-memory map of croner jobs keyed by
 * scheduled_tasks.id. Each job's callback delegates to the dispatcher.
 * Distinct from the legacy v0 scheduler at `hub/src/scheduler/index.ts`.
 */
import { Cron } from 'croner'
import {
  type ScheduledTask,
  listEnabledTasks,
  getTaskById,
  setTaskFireTimestamps,
} from '../db/scheduled-tasks-dal.ts'

type Dispatcher = typeof import('./dispatcher.ts')
let _dispatcher: Dispatcher | null = null
async function dispatcher(): Promise<Dispatcher> {
  if (_dispatcher) return _dispatcher
  _dispatcher = await import('./dispatcher.ts')
  return _dispatcher
}

const jobs = new Map<string, Cron>()

export function get(taskId: string): Cron | undefined { return jobs.get(taskId) }
export function size(): number { return jobs.size }

export function nextRunFor(taskId: string): Date | null {
  const j = jobs.get(taskId)
  if (!j) return null
  try { return j.nextRun() ?? null } catch { return null }
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
  const existing = jobs.get(taskId)
  if (!existing) return
  try { existing.stop() } catch {}
  jobs.delete(taskId)
}

export function pauseAll(): void {
  for (const [, j] of jobs) { try { j.pause() } catch {} }
}

export function resumeAll(): void {
  for (const [, j] of jobs) { try { j.resume() } catch {} }
}

function registerInternal(task: ScheduledTask): void {
  const existing = jobs.get(task.id)
  if (existing) { try { existing.stop() } catch {} ; jobs.delete(task.id) }
  if (!task.enabled) return
  const expr = task.cron_expr || task.cron_expression
  if (!expr) {
    console.error(`[scheduler.registry] task=${task.id} has no cron expression`)
    return
  }
  const tz = task.timezone || 'UTC'
  try {
    const job = new Cron(expr, { timezone: tz, protect: true, paused: false }, async () => {
      try {
        const d = await dispatcher()
        await d.fire(task.id)
      } catch (err: any) {
        console.error(`[scheduler.registry] fire failed task=${task.id}: ${err?.message ?? err}`)
      }
    })
    jobs.set(task.id, job)
    const next = job.nextRun() ?? null
    void setTaskFireTimestamps(task.id, task.last_fire_at ? new Date(task.last_fire_at) : null, next)
  } catch (err: any) {
    console.error(`[scheduler.registry] registerInternal failed task=${task.id}: ${err?.message ?? err}`)
  }
}
