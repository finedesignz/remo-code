/**
 * REST router for scheduled tasks (W3/T13).
 *
 * Backs the V2 dispatcher (`hub/src/scheduler/`). User-scoped CRUD plus
 * `run-now`. All bodies are Zod-validated. Cron expressions are validated
 * via `scheduler/cron.ts`; IANA timezones via `isValidTimezone`. Post-run
 * actions are validated via the discriminated union in
 * `scheduler/post-run/schema.ts` and chain cycles are detected across the
 * user's full task graph at write time.
 *
 * NOTE: The legacy v0 router shape (POST body keyed by `session_id`/
 * `cron_expression`/`prompt`/`on_complete`) is gone — this is the V2
 * contract that Wave 4 web UI consumes.
 */
import { Hono } from 'hono'
import { z } from 'zod'
import {
  type ScheduledTask,
  listTasksForUser,
  getTask,
  createTaskV2,
  updateTaskV2,
  deleteTask,
} from '../db/scheduled-tasks-dal.ts'
import { validate as validateCron, nextRuns, isValidTimezone } from '../scheduler/cron.ts'
import * as registry from '../scheduler/registry.ts'
import * as dispatcher from '../scheduler/dispatcher.ts'
import {
  validatePostRunActions,
  detectChainCycles,
  type PostRunAction,
} from '../scheduler/post-run/schema.ts'

export const scheduledTasks = new Hono()

// ── Schemas ───────────────────────────────────────────────────────────────────

const TaskTypeEnum = z.enum(['prompt', 'skill', 'security_scan', 'log_check', 'continue_dev', 'triage'])
const TargetKindEnum = z.enum(['session', 'supervisor', 'all_agents', 'all_supervisors'])
const CatchupPolicyEnum = z.enum(['skip', 'run_once'])

const CreateSchema = z.object({
  name: z.string().min(1).max(200).trim(),
  task_type: TaskTypeEnum,
  target_kind: TargetKindEnum,
  target_id: z.string().min(1).nullable().optional(),
  payload: z.record(z.any()).optional(),
  cron_expr: z.string().min(1).max(200),
  timezone: z.string().min(1).max(100),
  catchup_policy: CatchupPolicyEnum.optional(),
  max_concurrent: z.number().int().min(1).max(10).optional(),
  enabled: z.boolean().optional(),
  post_run_actions: z.array(z.any()).optional(),
})

const PatchSchema = CreateSchema.partial()

// ── Helpers ───────────────────────────────────────────────────────────────────

function withNext3<T extends ScheduledTask>(task: T) {
  if (!task.enabled) return { ...task, next_3_runs: [] as string[] }
  const expr = task.cron_expr || task.cron_expression
  const tz = task.timezone || 'UTC'
  if (!expr) return { ...task, next_3_runs: [] as string[] }
  const runs = nextRuns(expr, tz, 3).map((d) => d.toISOString())
  return { ...task, next_3_runs: runs }
}

function targetIdRequired(kind: string): boolean {
  return kind === 'session' || kind === 'supervisor'
}

interface ValidateOptions {
  cron_expr?: string
  timezone?: string
  target_kind?: string
  target_id?: string | null | undefined
  post_run_actions?: unknown
}

function validateInputs(input: ValidateOptions):
  | { ok: true; actions: PostRunAction[] }
  | { ok: false; status: 400; body: Record<string, unknown> } {
  if (input.cron_expr !== undefined) {
    const v = validateCron(input.cron_expr)
    if (!v.ok) return { ok: false, status: 400, body: { error: 'invalid_cron', detail: v.error } }
  }
  if (input.timezone !== undefined) {
    if (!isValidTimezone(input.timezone)) {
      return { ok: false, status: 400, body: { error: 'invalid_timezone' } }
    }
  }
  if (input.target_kind !== undefined) {
    if (targetIdRequired(input.target_kind) && !input.target_id) {
      return {
        ok: false,
        status: 400,
        body: { error: 'target_id_required', detail: `target_id required for kind=${input.target_kind}` },
      }
    }
  }
  let actions: PostRunAction[] = []
  if (input.post_run_actions !== undefined) {
    const r = validatePostRunActions(input.post_run_actions)
    if (!r.ok) {
      return { ok: false, status: 400, body: { error: 'invalid_post_run_actions', detail: r.errors } }
    }
    actions = r.value
  }
  return { ok: true, actions }
}

/**
 * Build the user's full task graph (including the proposed task) and run
 * cycle detection. `selfTaskId` is the id being edited/created; for create
 * we pass a sentinel "__new__" that won't collide with real UUIDs.
 */
async function detectCyclesForUser(
  userId: string,
  selfTaskId: string,
  selfActions: PostRunAction[],
): Promise<{ ok: true } | { ok: false; cycle: string[] }> {
  const all = await listTasksForUser(userId)
  const graph = all
    .filter((t) => t.id !== selfTaskId)
    .map((t) => ({ id: t.id, actions: (t.post_run_actions ?? []) as PostRunAction[] }))
  graph.push({ id: selfTaskId, actions: selfActions })
  return detectChainCycles(graph)
}

// ── Routes ────────────────────────────────────────────────────────────────────

scheduledTasks.get('/', async (c) => {
  const userId = c.get('userId') as string
  const rows = await listTasksForUser(userId)
  return c.json({ tasks: rows.map(withNext3) })
})

scheduledTasks.get('/:id', async (c) => {
  const userId = c.get('userId') as string
  const t = await getTask(c.req.param('id'), userId)
  if (!t) return c.json({ error: 'not_found' }, 404)
  return c.json(withNext3(t))
})

scheduledTasks.post('/', async (c) => {
  const userId = c.get('userId') as string
  const body = await c.req.json().catch(() => null)
  const parsed = CreateSchema.safeParse(body)
  if (!parsed.success) {
    return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400)
  }
  const data = parsed.data

  const v = validateInputs({
    cron_expr: data.cron_expr,
    timezone: data.timezone,
    target_kind: data.target_kind,
    target_id: data.target_id,
    post_run_actions: data.post_run_actions,
  })
  if (!v.ok) return c.json(v.body, v.status)

  // Cycle detection across the user's task graph + the proposed actions.
  const cyc = await detectCyclesForUser(userId, '__new__', v.actions)
  if (!cyc.ok) return c.json({ error: 'chain_cycle', path: cyc.cycle }, 400)

  // Session-typed tasks pin `session_id` to the target session; fan-out
  // kinds (all_agents/all_supervisors) leave it NULL.
  const sessionId =
    data.target_kind === 'session' && data.target_id ? data.target_id : null

  const task = await createTaskV2({
    user_id: userId,
    name: data.name,
    task_type: data.task_type,
    target_kind: data.target_kind,
    target_id: data.target_id ?? null,
    payload: data.payload ?? {},
    cron_expr: data.cron_expr,
    timezone: data.timezone,
    catchup_policy: data.catchup_policy ?? 'skip',
    max_concurrent: data.max_concurrent ?? 1,
    enabled: data.enabled ?? true,
    post_run_actions: v.actions,
    session_id: sessionId,
    cron_expression: data.cron_expr,
    prompt: typeof data.payload?.prompt === 'string' ? data.payload.prompt : '',
  })

  registry.register(task)
  return c.json(withNext3(task), 201)
})

scheduledTasks.patch('/:id', async (c) => {
  const userId = c.get('userId') as string
  const id = c.req.param('id')
  const existing = await getTask(id, userId)
  if (!existing) return c.json({ error: 'not_found' }, 404)

  const body = await c.req.json().catch(() => null)
  const parsed = PatchSchema.safeParse(body)
  if (!parsed.success) {
    return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400)
  }
  const data = parsed.data

  // Merge effective values for validation.
  const effective = {
    cron_expr: data.cron_expr ?? existing.cron_expr ?? existing.cron_expression,
    timezone: data.timezone ?? existing.timezone,
    target_kind: data.target_kind ?? existing.target_kind,
    target_id:
      data.target_id !== undefined ? data.target_id : existing.target_id,
    post_run_actions:
      data.post_run_actions !== undefined ? data.post_run_actions : existing.post_run_actions,
  }
  const v = validateInputs({
    // Only re-validate fields the caller actually changed; on partial PATCH
    // we still want to reject if e.g. only the cron was sent and it's bad.
    cron_expr: data.cron_expr,
    timezone: data.timezone,
    target_kind: data.target_kind,
    // target_id pairing depends on the effective kind, so always check it:
    target_id: effective.target_id ?? null,
    post_run_actions: data.post_run_actions,
  })
  if (!v.ok) return c.json(v.body, v.status)

  // For the target-pairing check we want it gated on the effective kind:
  if (targetIdRequired(effective.target_kind) && !effective.target_id) {
    return c.json(
      { error: 'target_id_required', detail: `target_id required for kind=${effective.target_kind}` },
      400,
    )
  }

  // Cycle detection using the effective post_run_actions for this task.
  const cyc = await detectCyclesForUser(
    userId,
    id,
    (effective.post_run_actions ?? []) as PostRunAction[],
  )
  if (!cyc.ok) return c.json({ error: 'chain_cycle', path: cyc.cycle }, 400)

  const updated = await updateTaskV2(id, userId, {
    name: data.name,
    enabled: data.enabled,
    task_type: data.task_type,
    target_kind: data.target_kind,
    target_id: data.target_id !== undefined ? data.target_id ?? null : undefined,
    payload: data.payload,
    cron_expr: data.cron_expr,
    timezone: data.timezone,
    catchup_policy: data.catchup_policy,
    max_concurrent: data.max_concurrent,
    post_run_actions: data.post_run_actions !== undefined ? v.actions : undefined,
  })
  if (!updated) return c.json({ error: 'not_found' }, 404)

  await registry.replace(updated.id)
  return c.json(withNext3(updated))
})

scheduledTasks.delete('/:id', async (c) => {
  const userId = c.get('userId') as string
  const id = c.req.param('id')
  const existing = await getTask(id, userId)
  if (!existing) return c.json({ error: 'not_found' }, 404)
  registry.unregister(id)
  await deleteTask(id, userId)
  return c.json({ ok: true })
})

scheduledTasks.post('/:id/run-now', async (c) => {
  const userId = c.get('userId') as string
  const id = c.req.param('id')
  const task = await getTask(id, userId)
  if (!task) return c.json({ error: 'not_found' }, 404)
  // Fire-and-forget. The dispatcher persists run rows and broadcasts WS
  // events; client subscribes to those for live progress.
  void dispatcher.runNow(id, userId).catch((err) =>
    console.error(`[api.scheduled-tasks] run-now failed task=${id}: ${err?.message ?? err}`),
  )
  return c.json({ ok: true, status: 'dispatched' }, 202)
})
