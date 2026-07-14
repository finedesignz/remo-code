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
import { validateRules, ruleToCron, normalizeRulesForStorage, type ScheduleRule } from '../scheduler/schedule-rules.ts'
import * as registry from '../scheduler/registry.ts'
import * as dispatcher from '../scheduler/dispatcher.ts'
import {
  validatePostRunActions,
  detectChainCycles,
  type PostRunAction,
} from '../scheduler/post-run/schema.ts'
import { buildTaskName, type TaskType, type TargetKind } from '../scheduler/auto-name.ts'
import { listSessions } from '../db/dal.ts'
import { listSupervisorsForUser } from '../db/supervisor-dal.ts'

export const scheduledTasks = new Hono()

// ── Schemas ───────────────────────────────────────────────────────────────────

// Phase 11: enum narrowed to the three user-pickable roots + nine chained
// workflow step kinds + internal `triage`. Legacy values
// (prompt/skill/continue_dev) were rewritten to the new triad by the
// schema.sql migration in commit b9edb82.
const TaskTypeEnum = z.enum([
  // User-pickable roots
  'dev', 'security', 'log_check', 'qc',
  // Chained workflow step kinds
  'dev_controller', 'dev_plan', 'dev_execute', 'dev_ship',
  'security_scan', 'security_triage', 'security_fix_or_issue',
  'log_pull', 'log_classify', 'log_triage',
  'qc_review', 'qc_fix', 'qc_verify',
  // Phase 21 (auto-dev-orchestrator): the session-level orchestrator task.
  // Allowed by the DB CHECK constraint in schema.sql; must be accepted here too.
  'orchestrator',
  // Milestone TEAB: Titanium Edge AutoBuilder run as a scheduled-task action.
  'teab',
  // Internal (synthesized by Coolify webhook)
  'triage',
])
const TargetKindEnum = z.enum(['session', 'supervisor', 'all_agents', 'all_supervisors'])
const CatchupPolicyEnum = z.enum(['skip', 'run_once'])

const CreateSchema = z.object({
  // Legacy: callers may still POST a full `name`; back-compat only. The
  // server always recomputes the prefix from (task_type, target, cron) and
  // composes the stored `name` as `<prefix> — <suffix>`. New clients should
  // send `name_suffix` and omit `name`.
  name: z.string().min(1).max(200).trim().optional(),
  name_suffix: z.string().max(200).optional(),
  task_type: TaskTypeEnum,
  target_kind: TargetKindEnum,
  target_id: z.string().min(1).nullable().optional(),
  payload: z.record(z.any()).optional(),
  // Optional top-level prompt mirror. The canonical home is `payload.prompt`,
  // but clients may also send it here; the server keeps the `prompt` column and
  // `payload.prompt` in sync on every write.
  prompt: z.string().optional(),
  // Either `cron_expr` (legacy) or `schedule_rules` (new). Validated below.
  cron_expr: z.string().min(1).max(200).optional(),
  schedule_rules: z.array(z.object({
    interval: z.number().int().min(1).max(999),
    unit: z.enum(['minutes', 'hours', 'days', 'weeks', 'months']),
    start_at: z.string().min(1),
    // P1 additive — deep validation (HH:MM format, ISO until, ranges) is done
    // by `validateRules` below; here we keep the Zod shape permissive so old
    // and new clients both parse.
    active_window: z.object({ from: z.string(), to: z.string() }).optional(),
    until: z.string().optional(),
    max_runs: z.number().int().min(1).max(100000).optional(),
    for: z.object({
      count: z.number().int().min(1).max(999),
      unit: z.enum(['minutes', 'hours', 'days', 'weeks', 'months']),
    }).optional(),
  })).min(1).max(20).optional(),
  timezone: z.string().min(1).max(100),
  // Milestone once. 'once' fires a single time at `run_at` (ISO 8601) and then
  // self-finalizes; 'cron' (default, omitted) is the recurring path and requires
  // cron_expr or schedule_rules. When schedule_kind='once', run_at is REQUIRED
  // and cron_expr/schedule_rules are ignored.
  schedule_kind: z.enum(['cron', 'once']).optional(),
  run_at: z.string().min(1).max(40).optional(),
  catchup_policy: CatchupPolicyEnum.optional(),
  max_concurrent: z.number().int().min(1).max(10).optional(),
  enabled: z.boolean().optional(),
  post_run_actions: z.array(z.any()).optional(),
  // Milestone TEAB — target repo (`repo_ident`) for a `task_type === 'teab'`
  // build task. Persisted on the dedicated `teab_repo_ident` column.
  teab_repo_ident: z.string().max(2000).nullable().optional(),
  // Default-on run-summary email opt-out. Omitted ⇒ true (owner gets a summary
  // per root run). Set false to suppress. See docs/scheduled-tasks.md.
  email_summary: z.boolean().optional(),
})

const PatchSchema = CreateSchema.partial()

// ── Helpers ───────────────────────────────────────────────────────────────────

function withNext3<T extends ScheduledTask>(task: T) {
  if (!task.enabled) return { ...task, next_3_runs: [] as string[] }
  // Milestone once: a one-time task's only "next run" is its run_at (no cron).
  if (task.schedule_kind === 'once') {
    const ms = task.run_at ? Date.parse(task.run_at) : NaN
    const next = Number.isFinite(ms) && ms > Date.now() ? [new Date(ms).toISOString()] : []
    return { ...task, next_3_runs: next }
  }
  const tz = task.timezone || 'UTC'
  const rules = Array.isArray(task.schedule_rules) ? (task.schedule_rules as ScheduleRule[]) : []
  if (rules.length > 0) {
    const merged: number[] = []
    for (const r of rules) {
      try {
        const expr = ruleToCron(r, tz)
        const startMs = Date.parse(r.start_at)
        const from = Number.isFinite(startMs) && startMs > Date.now() ? new Date(startMs) : new Date()
        for (const d of nextRuns(expr, tz, 3, from)) merged.push(d.getTime())
      } catch {}
    }
    merged.sort((a, b) => a - b)
    const top = Array.from(new Set(merged)).slice(0, 3).map(ms => new Date(ms).toISOString())
    return { ...task, next_3_runs: top }
  }
  const expr = task.cron_expr || task.cron_expression
  if (!expr) return { ...task, next_3_runs: [] as string[] }
  const runs = nextRuns(expr, tz, 3).map((d) => d.toISOString())
  return { ...task, next_3_runs: runs }
}

function targetIdRequired(kind: string): boolean {
  return kind === 'session' || kind === 'supervisor'
}

/**
 * Resolve the effective cron_expr to persist + register. Priority:
 *  - explicit `cron_expr` from the body (legacy clients)
 *  - rule[0] of `schedule_rules` converted to cron
 *  - existing row's cron_expr (PATCH path)
 *
 * Returns null if neither is available.
 */
function resolveCronExpr(
  body: { cron_expr?: string; schedule_rules?: ScheduleRule[] },
  tz: string,
): string | null {
  if (body.cron_expr) return body.cron_expr
  if (body.schedule_rules && body.schedule_rules.length > 0) {
    return ruleToCron(body.schedule_rules[0], tz)
  }
  return null
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

/**
 * Resolve the user's sessions + supervisors and compose the locked prefix
 * + final name. The server's prefix is authoritative on persist — the
 * client renders a preview but never gets to override the value stored on
 * `scheduled_tasks.name`.
 *
 * `legacyName` is the optional back-compat `name` body field; when no
 * suffix was provided but a legacy name was, we use the legacy value as
 * the suffix so users editing old rows don't lose their custom names.
 */
async function buildNameForUser(
  userId: string,
  input: {
    task_type: TaskType
    target_kind: TargetKind
    target_id: string | null
    payload: Record<string, any>
    cron_expr: string
  },
  suffix: string | null | undefined,
  legacyName: string | null | undefined,
): Promise<{ prefix: string; suffix: string; name: string }> {
  const [sessions, supervisors] = await Promise.all([
    listSessions(userId),
    listSupervisorsForUser(userId),
  ])
  const ctx = {
    sessions: (sessions as any[]).map((s) => ({
      id: s.id,
      name: s.name,
      project_dir: s.project_dir,
    })),
    supervisors: (supervisors as any[]).map((s) => ({
      id: s.id,
      hostname: s.hostname,
    })),
  }
  let effectiveSuffix = (suffix ?? '').trim()
  if (!effectiveSuffix && legacyName) {
    // Strip the prefix from legacyName if it starts with it; otherwise treat
    // the whole legacy name as a custom suffix.
    const probe = buildTaskName(input, '', ctx)
    const raw = legacyName.trim()
    if (probe.prefix && raw.toLowerCase().startsWith(probe.prefix.toLowerCase())) {
      effectiveSuffix = raw.slice(probe.prefix.length).replace(/^\s*[—\-:]+\s*/, '').trim()
    } else {
      effectiveSuffix = raw
    }
  }
  const built = buildTaskName(input, effectiveSuffix, ctx)
  // Fallback: if the prefix couldn't be computed (missing target etc.) but
  // we have a legacy or suffix value, keep `name` non-empty so the NOT NULL
  // column never breaks.
  if (!built.name) {
    const fallback = (legacyName || effectiveSuffix || 'Untitled task').trim()
    return { prefix: built.prefix, suffix: built.suffix, name: fallback }
  }
  return built
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

  // ── Milestone once: one-time task branch ───────────────────────────────────
  // A 'once' task carries no cron; it needs a valid `run_at` and reuses the
  // whole downstream pipeline verbatim. Handled up-front so the cron/rule
  // validation below is skipped cleanly.
  if (data.schedule_kind === 'once') {
    const runAtMs = data.run_at ? Date.parse(data.run_at) : NaN
    if (!Number.isFinite(runAtMs)) {
      return c.json({ error: 'run_at_required', detail: 'schedule_kind=once requires a valid ISO run_at' }, 400)
    }
    if (!isValidTimezone(data.timezone)) return c.json({ error: 'invalid_timezone' }, 400)
    if (targetIdRequired(data.target_kind) && !data.target_id) {
      return c.json({ error: 'target_id_required', detail: `target_id required for kind=${data.target_kind}` }, 400)
    }
    let onceActions: PostRunAction[] = []
    if (data.post_run_actions !== undefined) {
      const r = validatePostRunActions(data.post_run_actions)
      if (!r.ok) return c.json({ error: 'invalid_post_run_actions', detail: r.errors }, 400)
      onceActions = r.value
    }
    const cyc = await detectCyclesForUser(userId, '__new__', onceActions)
    if (!cyc.ok) return c.json({ error: 'chain_cycle', path: cyc.cycle }, 400)

    const sessionId = data.target_kind === 'session' && data.target_id ? data.target_id : null
    const oncePrompt =
      typeof data.payload?.prompt === 'string' ? data.payload.prompt
      : typeof data.prompt === 'string' ? data.prompt : ''
    const oncePayload = oncePrompt !== '' ? { ...(data.payload ?? {}), prompt: oncePrompt } : (data.payload ?? {})
    const built = await buildNameForUser(userId, {
      task_type: data.task_type,
      target_kind: data.target_kind,
      target_id: data.target_id ?? null,
      payload: oncePayload,
      cron_expr: '@once',
    }, data.name_suffix, data.name)

    const task = await createTaskV2({
      user_id: userId,
      name: built.name,
      task_type: data.task_type,
      target_kind: data.target_kind,
      target_id: data.target_id ?? null,
      payload: oncePayload,
      cron_expr: '@once',
      timezone: data.timezone,
      catchup_policy: data.catchup_policy ?? 'skip',
      max_concurrent: data.max_concurrent ?? 1,
      enabled: data.enabled ?? true,
      post_run_actions: onceActions,
      session_id: sessionId,
      cron_expression: '@once',
      prompt: oncePrompt,
      name_prefix: built.prefix || null,
      name_suffix: built.suffix || null,
      schedule_rules: null,
      teab_repo_ident: data.teab_repo_ident ?? null,
      email_summary: data.email_summary,
      schedule_kind: 'once',
      run_at: new Date(runAtMs),
    })
    registry.register(task)
    return c.json(withNext3(task), 201)
  }

  // Require either cron_expr or schedule_rules. Derive cron_expr from rule[0]
  // when only schedule_rules was sent. The legacy column stays populated.
  if (!data.cron_expr && (!data.schedule_rules || data.schedule_rules.length === 0)) {
    return c.json({ error: 'schedule_required', detail: 'cron_expr or schedule_rules is required' }, 400)
  }
  if (data.schedule_rules) {
    const rv = validateRules(data.schedule_rules)
    if (!rv.ok) return c.json({ error: 'invalid_schedule_rules', detail: rv.error }, 400)
    // Resolve `for:{count,unit}` → absolute `until` so storage carries a single
    // bound (see normalizeRuleForStorage). Mutates the local copy only.
    data.schedule_rules = normalizeRulesForStorage(data.schedule_rules as ScheduleRule[]) as any
  }
  const effectiveCron = resolveCronExpr(
    { cron_expr: data.cron_expr, schedule_rules: data.schedule_rules as ScheduleRule[] | undefined },
    data.timezone,
  )
  if (!effectiveCron) {
    return c.json({ error: 'schedule_required' }, 400)
  }

  const v = validateInputs({
    cron_expr: effectiveCron,
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

  // Single source of truth: the `prompt` column. Mirror it into
  // `payload.prompt` (and vice-versa) so create round-trips for the editor,
  // which reads `payload.prompt` first and falls back to the column.
  const createPrompt =
    typeof data.payload?.prompt === 'string'
      ? data.payload.prompt
      : typeof data.prompt === 'string'
        ? data.prompt
        : ''
  const createPayload =
    createPrompt !== ''
      ? { ...(data.payload ?? {}), prompt: createPrompt }
      : (data.payload ?? {})

  // Build the locked auto-name prefix server-side from current sessions +
  // supervisors. The client also computes a prefix for live preview, but the
  // server's value is authoritative on persist.
  const built = await buildNameForUser(userId, {
    task_type: data.task_type,
    target_kind: data.target_kind,
    target_id: data.target_id ?? null,
    payload: createPayload,
    cron_expr: effectiveCron,
  }, data.name_suffix, data.name)

  const task = await createTaskV2({
    user_id: userId,
    name: built.name,
    task_type: data.task_type,
    target_kind: data.target_kind,
    target_id: data.target_id ?? null,
    payload: createPayload,
    cron_expr: effectiveCron,
    timezone: data.timezone,
    catchup_policy: data.catchup_policy ?? 'skip',
    max_concurrent: data.max_concurrent ?? 1,
    enabled: data.enabled ?? true,
    post_run_actions: v.actions,
    session_id: sessionId,
    cron_expression: effectiveCron,
    prompt: createPrompt,
    name_prefix: built.prefix || null,
    name_suffix: built.suffix || null,
    schedule_rules: data.schedule_rules ?? null,
    teab_repo_ident: data.teab_repo_ident ?? null,
    email_summary: data.email_summary,
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

  if (data.schedule_rules) {
    const rv = validateRules(data.schedule_rules)
    if (!rv.ok) return c.json({ error: 'invalid_schedule_rules', detail: rv.error }, 400)
    data.schedule_rules = normalizeRulesForStorage(data.schedule_rules as ScheduleRule[]) as any
  }

  // Merge effective values for validation. If client sent schedule_rules,
  // derive a cron from rule[0]; otherwise fall back to explicit cron_expr.
  const effectiveTimezone = data.timezone ?? existing.timezone
  const derivedFromRules = data.schedule_rules
    ? resolveCronExpr({ schedule_rules: data.schedule_rules as ScheduleRule[] }, effectiveTimezone)
    : null
  const effective = {
    cron_expr: data.cron_expr ?? derivedFromRules ?? existing.cron_expr ?? existing.cron_expression,
    timezone: effectiveTimezone,
    target_kind: data.target_kind ?? existing.target_kind,
    target_id:
      data.target_id !== undefined ? data.target_id : existing.target_id,
    post_run_actions:
      data.post_run_actions !== undefined ? data.post_run_actions : existing.post_run_actions,
  }
  // Only re-validate targeting when the patch actually changes it. A pure
  // non-targeting PATCH (e.g. `{ enabled }`) must NOT 400 on a pre-existing
  // task that legitimately has a null target_id (e.g. internal system tasks
  // with target_kind='session' / target_id=null routed at dispatch time).
  const touchesTargeting =
    data.target_kind !== undefined || data.target_id !== undefined

  const v = validateInputs({
    // Validate the (possibly derived) effective cron when rules changed too.
    cron_expr: data.cron_expr ?? derivedFromRules ?? undefined,
    timezone: data.timezone,
    // Only enforce target_kind/target_id pairing when targeting is touched.
    target_kind: touchesTargeting ? effective.target_kind : undefined,
    target_id: effective.target_id ?? null,
    post_run_actions: data.post_run_actions,
  })
  if (!v.ok) return c.json(v.body, v.status)

  // For the target-pairing check we want it gated on the effective kind —
  // but only when the patch actually changes targeting.
  if (touchesTargeting && targetIdRequired(effective.target_kind) && !effective.target_id) {
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

  // Recompute the locked prefix from the effective (post-merge) fields and
  // re-compose the final name. Suffix sources, in priority:
  //   1) explicit `name_suffix` in the patch body
  //   2) existing row's `name_suffix`
  //   3) legacy `data.name` (treated as full custom name → suffix-only fallback)
  const effectivePayload = data.payload ?? existing.payload ?? {}
  const suffixSource =
    data.name_suffix !== undefined
      ? data.name_suffix
      : (existing.name_suffix ?? null)
  const built = await buildNameForUser(
    userId,
    {
      task_type: (data.task_type ?? existing.task_type) as TaskType,
      target_kind: effective.target_kind as TargetKind,
      target_id: effective.target_id ?? null,
      payload: effectivePayload,
      cron_expr: effective.cron_expr,
    },
    suffixSource,
    data.name,
  )

  // Keep the `prompt` column and `payload.prompt` in sync. The prompt may
  // arrive via `data.payload.prompt` (canonical) or a top-level `data.prompt`
  // mirror. When either is present, persist BOTH the column and the
  // payload.prompt so the dispatcher (`payload.prompt || prompt`) and the
  // editor (reads payload.prompt, falls back to column) stay consistent.
  const nextPrompt =
    typeof data.payload?.prompt === 'string'
      ? data.payload.prompt
      : typeof data.prompt === 'string'
        ? data.prompt
        : undefined
  let nextPayload = data.payload
  if (nextPrompt !== undefined) {
    nextPayload = { ...(data.payload ?? existing.payload ?? {}), prompt: nextPrompt }
  }

  const updated = await updateTaskV2(id, userId, {
    name: built.name,
    name_prefix: built.prefix || null,
    name_suffix: built.suffix || null,
    enabled: data.enabled,
    task_type: data.task_type,
    target_kind: data.target_kind,
    target_id: data.target_id !== undefined ? data.target_id ?? null : undefined,
    payload: nextPayload,
    prompt: nextPrompt,
    cron_expr: data.cron_expr ?? derivedFromRules ?? undefined,
    timezone: data.timezone,
    catchup_policy: data.catchup_policy,
    max_concurrent: data.max_concurrent,
    post_run_actions: data.post_run_actions !== undefined ? v.actions : undefined,
    schedule_rules: data.schedule_rules !== undefined ? (data.schedule_rules as any[]) : undefined,
    teab_repo_ident: data.teab_repo_ident !== undefined ? (data.teab_repo_ident ?? null) : undefined,
    email_summary: data.email_summary,
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
  // Await dispatch so we can return the created run_ids the client uses to
  // track progress via WS. Manual runs fail fast on offline targets instead
  // of silently grace-queuing (the UI has no way to surface a pending
  // grace-queued row otherwise).
  try {
    const res = await dispatcher.runNow(id, userId, { isManual: true })
    return c.json({ ok: true, status: 'dispatched', run_ids: res.runIds }, 202)
  } catch (err: any) {
    console.error(`[api.scheduled-tasks] run-now failed task=${id}: ${err?.message ?? err}`)
    return c.json({ error: 'dispatch_failed', message: err?.message ?? 'unknown' }, 500)
  }
})
