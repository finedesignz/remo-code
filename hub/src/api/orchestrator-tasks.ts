// hub/src/api/orchestrator-tasks.ts
// Phase 31 (auto-dev-orchestrator) — REST for CONFIGURING the one-per-session
// orchestrator task + its `orchestrator_rows`. This router is DATA-ONLY: it does
// not start, fire, or queue anything (the controller/live path is flag-OFF). It
// is mounted as an authed user route (post-auth catch-all, like /api/scheduled-
// tasks), NOT a public webhook.
//
// All access is scoped by user_id: every task/row mutation first resolves the
// owning task via the user-scoped DAL helpers and 404s on a miss. The DB partial
// unique index (idx_scheduled_tasks_orchestrator_unique) is the authoritative
// one-per-session backstop; create maps its 23505 violation to a 409.
//
// frequency_label is free text — `Never` (parked/disabled), `Once` (run once),
// or a cadence label — interpreted by the Phase-23 controller, never here.

import { Hono } from 'hono';
import { z } from 'zod';
import {
  getOrchestratorTaskForSession,
  getOrchestratorTaskById,
  createOrchestratorTaskForSession,
  updateOrchestratorTaskStage,
  updateOrchestratorTaskMacroType,
  listOrchestratorRows,
  insertOrchestratorRow,
  updateOrchestratorRowFields,
  deleteOrchestratorRow,
  getOrchestratorRowWithOwner,
  reorderOrchestratorRows,
  isUniqueViolation,
  type LifecycleStage,
} from '../db/orchestrator-rows-dal.ts';
import { applyStagePreset } from '../orchestrator/stage-presets.ts';
import { isKnownCommand } from '../orchestrator/command-set.ts';
import { getSession } from '../db/dal.ts';

export const orchestratorTasks = new Hono();

// ── Schemas ──────────────────────────────────────────────────────────────────

const StageEnum = z.enum(['development', 'beta', 'production-maintenance']);

// A schedule_rule mirrors the ScheduleRule JSONB shape (interval/unit/start_at +
// optional active_window + bounds). Kept permissive here (the row is config, not
// armed); the controller validates eligibility at run time.
const ScheduleRuleSchema = z
  .object({
    interval: z.number().int().min(1).max(999),
    unit: z.enum(['minutes', 'hours', 'days', 'weeks', 'months']),
    start_at: z.string().min(1),
    active_window: z
      .object({ from: z.string(), to: z.string() })
      .optional(),
    until: z.string().optional(),
    max_runs: z.number().int().min(1).max(100000).optional(),
    for: z
      .object({
        count: z.number().int().min(1).max(999),
        unit: z.enum(['minutes', 'hours', 'days', 'weeks', 'months']),
      })
      .optional(),
  })
  .strict()
  .nullable();

// Milestone TMAC: the macro task_type (dev|maintenance|security|brainstorming).
const MacroTaskTypeEnum = z.enum(['dev', 'maintenance', 'security', 'brainstorming']);

const CreateTaskSchema = z.object({
  lifecycle_stage: StageEnum.optional(),
  name: z.string().min(1).max(200).optional(),
  macro_task_type: MacroTaskTypeEnum.optional(),
});

// PATCH accepts EITHER lifecycle_stage OR macro_task_type (or both); at least one.
const PatchTaskSchema = z
  .object({
    lifecycle_stage: StageEnum.optional(),
    macro_task_type: MacroTaskTypeEnum.optional(),
  })
  .refine((b) => b.lifecycle_stage != null || b.macro_task_type != null, {
    message: 'patch must set lifecycle_stage and/or macro_task_type',
  });

const ApplyPresetSchema = z.object({
  stage: StageEnum.optional(),
  overwrite: z.boolean().optional(),
});

// A row is either a known command OR a micro-prompt row (free-text body). One of
// the two must identify the row: a known command, or a micro_prompt with a
// `micro_prompt` body (its `command` defaults to 'micro-prompt').
const AddRowSchema = z
  .object({
    command: z.string().min(1).max(120).optional(),
    micro_prompt: z.string().min(1).max(4000).optional(),
    enabled: z.boolean().optional(),
    frequency_label: z.string().max(120).optional(),
    schedule_rule: ScheduleRuleSchema.optional(),
    sort_order: z.number().int().min(0).max(100000).optional(),
  })
  .refine(
    (b) => (b.command ? isKnownCommand(b.command) : false) || !!b.micro_prompt,
    { message: 'row must be a known command or carry a micro_prompt body' },
  );

const PatchRowSchema = z.object({
  enabled: z.boolean().optional(),
  frequency_label: z.string().max(120).nullable().optional(),
  micro_prompt: z.string().max(4000).nullable().optional(),
  schedule_rule: ScheduleRuleSchema.optional(),
  sort_order: z.number().int().min(0).max(100000).optional(),
});

const ReorderSchema = z.object({
  ordered_ids: z.array(z.string().min(1)).min(1).max(200),
});

// ── Task: get / create ───────────────────────────────────────────────────────

// GET the orchestrator task (+ rows) for a session. Returns { task: null } when
// the session has no orchestrator task yet.
orchestratorTasks.get('/:sessionId', async (c) => {
  const userId = c.get('userId') as string;
  const sessionId = c.req.param('sessionId');
  const session = await getSession(sessionId, userId);
  if (!session) return c.json({ error: 'session_not_found' }, 404);

  const task = await getOrchestratorTaskForSession(userId, sessionId);
  if (!task) return c.json({ task: null, rows: [] });
  const rows = await listOrchestratorRows(task.id);
  return c.json({ task, rows });
});

// POST create the orchestrator task for a session (one-per-session).
orchestratorTasks.post('/:sessionId', async (c) => {
  const userId = c.get('userId') as string;
  const sessionId = c.req.param('sessionId');
  const session = await getSession(sessionId, userId);
  if (!session) return c.json({ error: 'session_not_found' }, 404);

  const parsed = CreateTaskSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: 'invalid_body', detail: parsed.error.issues }, 400);

  try {
    const task = await createOrchestratorTaskForSession(userId, sessionId, {
      stage: parsed.data.lifecycle_stage,
      name: parsed.data.name,
      macroTaskType: parsed.data.macro_task_type,
    });
    return c.json({ task, rows: [] }, 201);
  } catch (err) {
    if (isUniqueViolation(err)) {
      return c.json({ error: 'orchestrator_task_exists' }, 409);
    }
    throw err;
  }
});

// PATCH lifecycle_stage and/or macro_task_type.
orchestratorTasks.patch('/:taskId', async (c) => {
  const userId = c.get('userId') as string;
  const taskId = c.req.param('taskId');
  const parsed = PatchTaskSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: 'invalid_body', detail: parsed.error.issues }, 400);

  let task = null as Awaited<ReturnType<typeof updateOrchestratorTaskStage>>;
  if (parsed.data.lifecycle_stage != null) {
    task = await updateOrchestratorTaskStage(userId, taskId, parsed.data.lifecycle_stage);
    if (!task) return c.json({ error: 'task_not_found' }, 404);
  }
  if (parsed.data.macro_task_type != null) {
    task = await updateOrchestratorTaskMacroType(userId, taskId, parsed.data.macro_task_type);
    if (!task) return c.json({ error: 'task_not_found' }, 404);
  }
  return c.json({ task });
});

// POST apply a lifecycle-stage preset → seeds/overwrites default row frequencies.
orchestratorTasks.post('/:taskId/apply-preset', async (c) => {
  const userId = c.get('userId') as string;
  const taskId = c.req.param('taskId');
  const task = await getOrchestratorTaskById(userId, taskId);
  if (!task) return c.json({ error: 'task_not_found' }, 404);

  const parsed = ApplyPresetSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: 'invalid_body', detail: parsed.error.issues }, 400);

  const stage: LifecycleStage = parsed.data.stage ?? task.lifecycle_stage;
  const result = await applyStagePreset(taskId, stage, { overwrite: parsed.data.overwrite });
  const rows = await listOrchestratorRows(taskId);
  return c.json({ result, rows });
});

// ── Rows: CRUD + reorder ─────────────────────────────────────────────────────

// POST add a command row or a micro-prompt row.
orchestratorTasks.post('/:taskId/rows', async (c) => {
  const userId = c.get('userId') as string;
  const taskId = c.req.param('taskId');
  const task = await getOrchestratorTaskById(userId, taskId);
  if (!task) return c.json({ error: 'task_not_found' }, 404);

  const parsed = AddRowSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: 'invalid_body', detail: parsed.error.issues }, 400);

  const b = parsed.data;
  const command = b.command ?? 'micro-prompt';
  const row = await insertOrchestratorRow({
    task_id: taskId,
    command,
    enabled: b.enabled ?? true,
    frequency_label: b.frequency_label ?? null,
    schedule_rule: b.schedule_rule ?? null,
    micro_prompt: b.micro_prompt ?? null,
    sort_order: b.sort_order ?? 0,
  });
  return c.json({ row }, 201);
});

// PATCH a row's mutable fields.
orchestratorTasks.patch('/rows/:rowId', async (c) => {
  const userId = c.get('userId') as string;
  const rowId = c.req.param('rowId');
  const owned = await getOrchestratorRowWithOwner(rowId);
  if (!owned || owned.user_id !== userId) return c.json({ error: 'row_not_found' }, 404);

  const parsed = PatchRowSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: 'invalid_body', detail: parsed.error.issues }, 400);

  const row = await updateOrchestratorRowFields(rowId, parsed.data);
  if (!row) return c.json({ error: 'row_not_found' }, 404);
  return c.json({ row });
});

// DELETE a row.
orchestratorTasks.delete('/rows/:rowId', async (c) => {
  const userId = c.get('userId') as string;
  const rowId = c.req.param('rowId');
  const owned = await getOrchestratorRowWithOwner(rowId);
  if (!owned || owned.user_id !== userId) return c.json({ error: 'row_not_found' }, 404);

  await deleteOrchestratorRow(rowId);
  return c.json({ ok: true });
});

// POST reorder all rows of a task.
orchestratorTasks.post('/:taskId/rows/reorder', async (c) => {
  const userId = c.get('userId') as string;
  const taskId = c.req.param('taskId');
  const task = await getOrchestratorTaskById(userId, taskId);
  if (!task) return c.json({ error: 'task_not_found' }, 404);

  const parsed = ReorderSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: 'invalid_body', detail: parsed.error.issues }, 400);

  await reorderOrchestratorRows(taskId, parsed.data.ordered_ids);
  const rows = await listOrchestratorRows(taskId);
  return c.json({ rows });
});
