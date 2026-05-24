import { Hono } from 'hono'
import { z } from 'zod'
import {
  listTasksForUser, getTask, createTask, updateTask, deleteTask,
  listRunsForTask,
} from '../db/scheduled-tasks-dal.ts'
import { getSession } from '../db/dal.ts'
import {
  isValidCron, nextRunsFor, registerJob, unregisterJob, replaceJob, fireTask,
} from '../scheduler/index.ts'

export const scheduledTasks = new Hono()

const OnCompleteSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('none') }),
  z.object({ type: z.literal('chain'), chain_task_id: z.string().min(1) }),
  z.object({ type: z.literal('notify'), notify_email: z.string().email().optional() }),
])

const CreateSchema = z.object({
  session_id: z.string().min(1),
  name: z.string().min(1).max(200),
  cron_expression: z.string().min(1).max(100),
  prompt: z.string().min(1).max(20_000),
  enabled: z.boolean().optional(),
  on_complete: OnCompleteSchema.optional(),
})

const PatchSchema = z.object({
  session_id: z.string().min(1).optional(),
  name: z.string().min(1).max(200).optional(),
  cron_expression: z.string().min(1).max(100).optional(),
  prompt: z.string().min(1).max(20_000).optional(),
  enabled: z.boolean().optional(),
  on_complete: OnCompleteSchema.optional(),
})

function withNextRuns<T extends { cron_expression: string }>(task: T) {
  return { ...task, next_runs: nextRunsFor(task.cron_expression, 3) }
}

scheduledTasks.get('/', async (c) => {
  const userId = c.get('userId') as string
  const rows = await listTasksForUser(userId)
  return c.json({ tasks: rows.map(withNextRuns) })
})

scheduledTasks.post('/', async (c) => {
  const userId = c.get('userId') as string
  const body = await c.req.json().catch(() => null)
  const parsed = CreateSchema.safeParse(body)
  if (!parsed.success) return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400)
  const data = parsed.data

  const cron = isValidCron(data.cron_expression)
  if (!cron.ok) return c.json({ error: 'invalid_cron', detail: cron.error }, 400)

  const session = await getSession(data.session_id, userId)
  if (!session) return c.json({ error: 'session_not_found' }, 404)

  const task = await createTask({ user_id: userId, ...data })
  registerJob(task)
  return c.json(withNextRuns(task), 201)
})

scheduledTasks.get('/:id', async (c) => {
  const userId = c.get('userId') as string
  const t = await getTask(c.req.param('id'), userId)
  if (!t) return c.json({ error: 'not_found' }, 404)
  return c.json(withNextRuns(t))
})

scheduledTasks.patch('/:id', async (c) => {
  const userId = c.get('userId') as string
  const id = c.req.param('id')
  const body = await c.req.json().catch(() => null)
  const parsed = PatchSchema.safeParse(body)
  if (!parsed.success) return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400)
  const fields = parsed.data

  if (fields.cron_expression) {
    const cron = isValidCron(fields.cron_expression)
    if (!cron.ok) return c.json({ error: 'invalid_cron', detail: cron.error }, 400)
  }
  if (fields.session_id) {
    const session = await getSession(fields.session_id, userId)
    if (!session) return c.json({ error: 'session_not_found' }, 404)
  }

  const updated = await updateTask(id, userId, fields)
  if (!updated) return c.json({ error: 'not_found' }, 404)
  await replaceJob(updated.id)
  return c.json(withNextRuns(updated))
})

scheduledTasks.delete('/:id', async (c) => {
  const userId = c.get('userId') as string
  const id = c.req.param('id')
  const ok = await deleteTask(id, userId)
  if (!ok) return c.json({ error: 'not_found' }, 404)
  unregisterJob(id)
  return c.json({ ok: true })
})

scheduledTasks.post('/:id/run', async (c) => {
  const userId = c.get('userId') as string
  const id = c.req.param('id')
  const task = await getTask(id, userId)
  if (!task) return c.json({ error: 'not_found' }, 404)
  const result = await fireTask(id)
  return c.json({ ok: true, run: result?.run ?? null })
})

scheduledTasks.get('/:id/runs', async (c) => {
  const userId = c.get('userId') as string
  const id = c.req.param('id')
  const task = await getTask(id, userId)
  if (!task) return c.json({ error: 'not_found' }, 404)
  const limit = Math.min(Number(c.req.query('limit') ?? 50), 200)
  const runs = await listRunsForTask(id, userId, limit)
  return c.json({ runs })
})
