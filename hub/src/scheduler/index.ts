/**
 * Hub-side cron scheduler. Registers a croner job per enabled scheduled_task,
 * fires the configured prompt into the target session as if it were a user
 * message, captures the next assistant_message turn to finalize the run, and
 * executes any on_complete action (chain another task / notify via email).
 *
 * No separate worker process. All state lives in-memory + Postgres.
 */
import { Cron } from 'croner'
import {
  type ScheduledTask,
  type OnCompleteAction,
  type ScheduledTaskRun,
  listAllEnabledTasks,
  getTask,
  getTaskById,
  insertRun,
  finalizeRun,
  setTaskFireTimes,
} from '../db/scheduled-tasks-dal.ts'
import { insertMessage, getSession } from '../db/dal.ts'
import { getChannel, broadcastToSubscribers, broadcastToUser } from '../ws/registry.ts'
import { sendEmailNotification } from './notify.ts'

const jobs = new Map<string, Cron>()

// session_id -> queue of pending runs waiting for the agent's next assistant_message
interface PendingTurn {
  runId: string
  taskId: string
  userId: string
  startedAt: number
}
const pendingTurns = new Map<string, PendingTurn[]>()

const TURN_TIMEOUT_MS = 30 * 60 * 1000 // 30 min hard cap per run

export function isValidCron(expr: string): { ok: true } | { ok: false; error: string } {
  try {
    const c = new Cron(expr, { paused: true })
    const next = c.nextRun()
    c.stop()
    if (!next) return { ok: false, error: 'expression yields no future runs' }
    return { ok: true }
  } catch (err: any) {
    return { ok: false, error: err?.message || 'invalid cron expression' }
  }
}

export function nextRunsFor(expr: string, count = 3): Date[] {
  try {
    const c = new Cron(expr, { paused: true })
    const out: Date[] = []
    let from: Date | undefined
    for (let i = 0; i < count; i++) {
      const n = c.nextRun(from)
      if (!n) break
      out.push(n)
      from = new Date(n.getTime() + 1000)
    }
    c.stop()
    return out
  } catch {
    return []
  }
}

export async function loadAll() {
  const tasks = await listAllEnabledTasks()
  for (const t of tasks) registerJob(t)
  console.log(`[scheduler] loaded ${tasks.length} enabled task(s)`)
}

export function registerJob(task: ScheduledTask) {
  unregisterJob(task.id)
  if (!task.enabled) return
  try {
    const job = new Cron(task.cron_expression, { protect: true }, async () => {
      await fireTask(task.id).catch((err) =>
        console.error(`[scheduler] fire failed task=${task.id}`, err?.message),
      )
    })
    jobs.set(task.id, job)
    const next = job.nextRun()
    void setTaskFireTimes(task.id, task.last_run_at ? new Date(task.last_run_at) : null, next ?? null)
  } catch (err: any) {
    console.error(`[scheduler] registerJob failed task=${task.id}: ${err.message}`)
  }
}

export function unregisterJob(taskId: string) {
  const existing = jobs.get(taskId)
  if (existing) {
    try { existing.stop() } catch {}
    jobs.delete(taskId)
  }
}

export async function replaceJob(taskId: string) {
  const t = await getTaskById(taskId)
  if (!t) { unregisterJob(taskId); return }
  registerJob(t)
}

/**
 * Fire a task once. Resolves the target session, inserts a run, sends the
 * prompt to the agent via the existing user_message path, and registers
 * the run as a pending turn waiting for the agent's next assistant_message.
 */
export async function fireTask(taskId: string): Promise<{ run: ScheduledTaskRun } | null> {
  const task = await getTaskById(taskId)
  if (!task) return null

  const session = await getSession(task.session_id, task.user_id)
  if (!session) {
    const run = await insertRun({
      task_id: task.id, user_id: task.user_id, session_id: null,
      status: 'failed', error: 'session_not_found',
    })
    await afterFinalize(task, run)
    return { run }
  }

  const channel = getChannel(task.session_id)
  if (!channel) {
    const run = await insertRun({
      task_id: task.id, user_id: task.user_id, session_id: task.session_id,
      status: 'skipped', error: 'session_offline',
    })
    await afterFinalize(task, run)
    bumpFireTimes(task)
    return { run }
  }

  // Insert user message in chat so the prompt shows up in history
  const storedContent = `[scheduled: ${task.name}]\n\n${task.prompt}`
  const msg = await insertMessage(task.session_id, 'user', storedContent)

  // Start run
  const run = await insertRun({
    task_id: task.id, user_id: task.user_id, session_id: task.session_id,
    status: 'running',
  })

  // Broadcast user message to subscribers so the UI shows it immediately
  broadcastToSubscribers(task.session_id, {
    type: 'message', session_id: task.session_id, message: msg,
  })

  // Push to the agent
  try {
    channel.ws.send(JSON.stringify({
      type: 'user_message',
      id: msg.id,
      content: task.prompt,
      ts: msg.created_at,
    }))
  } catch (err: any) {
    const finalized = await finalizeRun(run.id, 'failed', `agent_send_failed: ${err?.message ?? 'unknown'}`)
    if (finalized) await afterFinalize(task, finalized)
    bumpFireTimes(task)
    return { run }
  }

  // Register pending turn — finalized when the next assistant_message hits onAssistantMessage
  const queue = pendingTurns.get(task.session_id) ?? []
  queue.push({ runId: run.id, taskId: task.id, userId: task.user_id, startedAt: Date.now() })
  pendingTurns.set(task.session_id, queue)

  bumpFireTimes(task)
  broadcastToUser(task.user_id, { type: 'scheduled_task_run', run, task_id: task.id })
  return { run }
}

function bumpFireTimes(task: ScheduledTask) {
  const job = jobs.get(task.id)
  const next = job?.nextRun() ?? null
  void setTaskFireTimes(task.id, new Date(), next)
}

/**
 * Called from ws/agent.ts when an assistant_message is finalized. If a
 * scheduled run is pending for this session, mark it success and run
 * the on_complete action.
 */
export async function onAssistantMessage(sessionId: string) {
  const queue = pendingTurns.get(sessionId)
  if (!queue || queue.length === 0) return
  const pending = queue.shift()!
  if (queue.length === 0) pendingTurns.delete(sessionId)

  const finalized = await finalizeRun(pending.runId, 'success')
  if (!finalized) return
  const task = await getTaskById(pending.taskId)
  if (task) await afterFinalize(task, finalized)
}

async function afterFinalize(task: ScheduledTask, run: ScheduledTaskRun) {
  broadcastToUser(task.user_id, { type: 'scheduled_task_run', run, task_id: task.id })
  const action = task.on_complete
  if (!action || action.type === 'none') return
  try {
    if (action.type === 'chain' && action.chain_task_id) {
      const child = await getTask(action.chain_task_id, task.user_id)
      if (child) void fireTask(child.id)
    } else if (action.type === 'notify') {
      await sendEmailNotification({
        userId: task.user_id,
        to: action.notify_email,
        subject: `[remo-code] ${task.name} ${run.status}`,
        body: `Task "${task.name}" finished with status ${run.status}.\n` +
              (run.error ? `Error: ${run.error}\n` : '') +
              `Started: ${run.started_at}\nCompleted: ${run.completed_at ?? 'n/a'}`,
      })
    }
  } catch (err: any) {
    console.error(`[scheduler] on_complete action failed task=${task.id}`, err?.message)
  }
}

/** Background sweep: time out pending turns that have run too long. */
setInterval(async () => {
  const now = Date.now()
  for (const [sessionId, queue] of pendingTurns) {
    while (queue.length && now - queue[0].startedAt > TURN_TIMEOUT_MS) {
      const stale = queue.shift()!
      const finalized = await finalizeRun(stale.runId, 'failed', 'turn_timeout')
      if (finalized) {
        const task = await getTaskById(stale.taskId)
        if (task) await afterFinalize(task, finalized)
      }
    }
    if (queue.length === 0) pendingTurns.delete(sessionId)
  }
}, 60_000)
