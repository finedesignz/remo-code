// hub/src/db/orchestrator-rows-dal.ts
// Phase 21 (auto-dev-orchestrator) — thin typed DAL for the orchestrator data
// model: orchestrator_rows, routine_run_log, routine_queue. NO business logic
// here — just typed insert/select helpers mirroring the existing DAL style
// (see orchestrator-dal.ts / scheduled-tasks-dal.ts). Schema lives in
// schema.sql; types match the DB CHECK constraints.

import { sql } from './postgres.ts';
import type { ScheduleRule } from '../scheduler/schedule-rules.ts';

export type LifecycleStage = 'development' | 'beta' | 'production-maintenance';

// frequency_label is free text in the DB (Never | Once | a cron/cadence
// label). Kept as string here; the controller interprets it (D1/D3).
export interface OrchestratorRow {
  id: string;
  task_id: string;
  command: string;
  enabled: boolean;
  schedule_rule: ScheduleRule | null;
  frequency_label: string | null;
  micro_prompt: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface NewOrchestratorRow {
  task_id: string;
  command: string;
  enabled?: boolean;
  schedule_rule?: ScheduleRule | null;
  frequency_label?: string | null;
  micro_prompt?: string | null;
  sort_order?: number;
}

export async function insertOrchestratorRow(row: NewOrchestratorRow): Promise<OrchestratorRow> {
  const rows = await sql<OrchestratorRow[]>`
    INSERT INTO orchestrator_rows (
      task_id, command, enabled, schedule_rule, frequency_label, micro_prompt, sort_order
    ) VALUES (
      ${row.task_id},
      ${row.command},
      ${row.enabled ?? true},
      ${row.schedule_rule ? sql.json(row.schedule_rule as any) : null},
      ${row.frequency_label ?? null},
      ${row.micro_prompt ?? null},
      ${row.sort_order ?? 0}
    )
    RETURNING *
  `;
  return rows[0];
}

export async function listOrchestratorRows(taskId: string): Promise<OrchestratorRow[]> {
  return sql<OrchestratorRow[]>`
    SELECT * FROM orchestrator_rows
    WHERE task_id = ${taskId}
    ORDER BY sort_order ASC, created_at ASC
  `;
}

// Patch a subset of an existing row's mutable fields (Phase 30 — applyStagePreset
// overwrite path). Only the provided fields are written; `updated_at` is bumped.
// Returns the updated row, or null when the id does not exist.
export interface OrchestratorRowPatch {
  enabled?: boolean;
  schedule_rule?: ScheduleRule | null;
  frequency_label?: string | null;
  micro_prompt?: string | null;
  sort_order?: number;
}

export async function updateOrchestratorRowFields(
  id: string,
  patch: OrchestratorRowPatch,
): Promise<OrchestratorRow | null> {
  const rows = await sql<OrchestratorRow[]>`
    UPDATE orchestrator_rows SET
      enabled         = COALESCE(${patch.enabled ?? null}, enabled),
      schedule_rule   = ${
        patch.schedule_rule === undefined
          ? sql`schedule_rule`
          : patch.schedule_rule === null
            ? null
            : sql.json(patch.schedule_rule as any)
      },
      frequency_label = ${patch.frequency_label === undefined ? sql`frequency_label` : patch.frequency_label},
      micro_prompt    = ${patch.micro_prompt === undefined ? sql`micro_prompt` : patch.micro_prompt},
      sort_order      = COALESCE(${patch.sort_order ?? null}, sort_order),
      updated_at      = now()
    WHERE id = ${id}
    RETURNING *
  `;
  return rows[0] ?? null;
}

// Delete a single row. Returns true when a row was removed. (Phase 31 — UI CRUD.)
export async function deleteOrchestratorRow(id: string): Promise<boolean> {
  const rows = await sql`DELETE FROM orchestrator_rows WHERE id = ${id} RETURNING id`;
  return rows.length > 0;
}

// Fetch a single row joined to its owning task's user_id, so the API can verify
// ownership without a second query. Returns null when the row id does not exist.
export async function getOrchestratorRowWithOwner(
  id: string,
): Promise<(OrchestratorRow & { user_id: string }) | null> {
  const rows = await sql<(OrchestratorRow & { user_id: string })[]>`
    SELECT r.*, t.user_id
    FROM orchestrator_rows r
    JOIN scheduled_tasks t ON t.id = r.task_id
    WHERE r.id = ${id}
  `;
  return rows[0] ?? null;
}

// Bulk-apply a new ordering. `orderedIds` lists row ids in the desired order;
// each row's sort_order is set to its index. Scoped to one task. (Phase 31.)
export async function reorderOrchestratorRows(
  taskId: string,
  orderedIds: string[],
): Promise<void> {
  for (let i = 0; i < orderedIds.length; i++) {
    await sql`
      UPDATE orchestrator_rows SET sort_order = ${i}, updated_at = now()
      WHERE id = ${orderedIds[i]} AND task_id = ${taskId}
    `;
  }
}

// ── orchestrator TASK (the one-per-session scheduled_tasks row) ───────────────
// Phase 31 — the web editor configures exactly one `task_type='orchestrator'`
// scheduled_tasks row per session. These helpers keep that surface grep-friendly
// and scoped by user_id. The DB partial unique index
// (idx_scheduled_tasks_orchestrator_unique) is the authoritative one-per-session
// backstop; the API maps its unique-violation to a 409.

export interface OrchestratorTask {
  id: string;
  user_id: string;
  session_id: string | null;
  name: string;
  lifecycle_stage: LifecycleStage;
  /**
   * Milestone TMAC §7.2: true when the user SET lifecycle_stage explicitly. When
   * false, the stored stage is a default and the controller may override it with
   * an auto-detected stage (stage-detect.ts); an explicit stage always wins.
   */
  lifecycle_stage_explicit: boolean;
  /** Milestone TMAC: dev|maintenance|security|brainstorming (macro prompt key). */
  macro_task_type: MacroTaskType;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

export type MacroTaskType = 'dev' | 'maintenance' | 'security' | 'brainstorming';

// Static column list, inlined per query. NOT a top-level `sql` fragment — the
// postgres tag must not be invoked at module-load time (some tests mock `sql`
// with a fake that throws on unrecognized queries; a top-level call would fire
// during their import of any module that transitively loads this file).

// The user's orchestrator task for a session (or null). Scoped by user_id.
export async function getOrchestratorTaskForSession(
  userId: string,
  sessionId: string,
): Promise<OrchestratorTask | null> {
  const rows = await sql<OrchestratorTask[]>`
    SELECT id, user_id, session_id, name, lifecycle_stage, lifecycle_stage_explicit, macro_task_type, enabled, created_at, updated_at FROM scheduled_tasks
    WHERE user_id = ${userId} AND session_id = ${sessionId}
      AND task_type = 'orchestrator'
    LIMIT 1
  `;
  return rows[0] ?? null;
}

// Fetch by task id, scoped to the owner. Used by row/stage mutations to verify
// ownership before touching child rows.
export async function getOrchestratorTaskById(
  userId: string,
  taskId: string,
): Promise<OrchestratorTask | null> {
  const rows = await sql<OrchestratorTask[]>`
    SELECT id, user_id, session_id, name, lifecycle_stage, lifecycle_stage_explicit, macro_task_type, enabled, created_at, updated_at FROM scheduled_tasks
    WHERE id = ${taskId} AND user_id = ${userId} AND task_type = 'orchestrator'
    LIMIT 1
  `;
  return rows[0] ?? null;
}

// Create the one orchestrator task for a session. Relies on the partial unique
// index to enforce one-per-session: a duplicate insert throws a unique-violation
// (Postgres code 23505), which the API maps to 409. `cron_expression` is a
// NOT NULL legacy column on scheduled_tasks; the orchestrator task is fired by
// its own queue (not the cron engine), so we store an inert sentinel.
export async function createOrchestratorTaskForSession(
  userId: string,
  sessionId: string,
  opts: { stage?: LifecycleStage; name?: string; macroTaskType?: MacroTaskType } = {},
): Promise<OrchestratorTask> {
  const stage = opts.stage ?? 'development';
  const name = opts.name ?? 'Orchestrator';
  const macroTaskType = opts.macroTaskType ?? 'dev';
  const rows = await sql<OrchestratorTask[]>`
    INSERT INTO scheduled_tasks (
      user_id, session_id, name, cron_expression, prompt,
      task_type, target_kind, target_id, lifecycle_stage, macro_task_type, enabled
    ) VALUES (
      ${userId}, ${sessionId}, ${name}, '@orchestrator', '',
      'orchestrator', 'session', ${sessionId}, ${stage}, ${macroTaskType}, false
    )
    RETURNING id, user_id, session_id, name, lifecycle_stage, lifecycle_stage_explicit, macro_task_type, enabled, created_at, updated_at
  `;
  return rows[0];
}

export async function updateOrchestratorTaskStage(
  userId: string,
  taskId: string,
  stage: LifecycleStage,
): Promise<OrchestratorTask | null> {
  const rows = await sql<OrchestratorTask[]>`
    UPDATE scheduled_tasks SET lifecycle_stage = ${stage}, lifecycle_stage_explicit = true, updated_at = now()
    WHERE id = ${taskId} AND user_id = ${userId} AND task_type = 'orchestrator'
    RETURNING id, user_id, session_id, name, lifecycle_stage, lifecycle_stage_explicit, macro_task_type, enabled, created_at, updated_at
  `;
  return rows[0] ?? null;
}

// Milestone TMAC: set the macro task_type (dev|maintenance|security|brainstorming).
export async function updateOrchestratorTaskMacroType(
  userId: string,
  taskId: string,
  macroTaskType: MacroTaskType,
): Promise<OrchestratorTask | null> {
  const rows = await sql<OrchestratorTask[]>`
    UPDATE scheduled_tasks SET macro_task_type = ${macroTaskType}, updated_at = now()
    WHERE id = ${taskId} AND user_id = ${userId} AND task_type = 'orchestrator'
    RETURNING id, user_id, session_id, name, lifecycle_stage, lifecycle_stage_explicit, macro_task_type, enabled, created_at, updated_at
  `;
  return rows[0] ?? null;
}

// True when an error is a Postgres unique-constraint violation (23505). Used by
// the create path to convert the one-per-session index collision into a 409.
export function isUniqueViolation(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as any).code === '23505';
}

// ── routine_run_log ──────────────────────────────────────────────────────────

export interface RoutineRunLogEntry {
  id: string;
  session_id: string;
  repo_key: string | null;
  command: string;
  decision_rationale: string | null;
  outcome: string | null;
  gap_dimension: string | null;
  pr_url: string | null;
  reviewer_verdict: string | null;
  deploy_verify_result: string | null;
  created_at: string;
}

export interface NewRoutineRunLogEntry {
  session_id: string;
  command: string;
  repo_key?: string | null;
  decision_rationale?: string | null;
  outcome?: string | null;
  gap_dimension?: string | null;
  pr_url?: string | null;
  reviewer_verdict?: string | null;
  deploy_verify_result?: string | null;
}

export async function insertRoutineRunLog(e: NewRoutineRunLogEntry): Promise<RoutineRunLogEntry> {
  const rows = await sql<RoutineRunLogEntry[]>`
    INSERT INTO routine_run_log (
      session_id, repo_key, command, decision_rationale, outcome,
      gap_dimension, pr_url, reviewer_verdict, deploy_verify_result
    ) VALUES (
      ${e.session_id},
      ${e.repo_key ?? null},
      ${e.command},
      ${e.decision_rationale ?? null},
      ${e.outcome ?? null},
      ${e.gap_dimension ?? null},
      ${e.pr_url ?? null},
      ${e.reviewer_verdict ?? null},
      ${e.deploy_verify_result ?? null}
    )
    RETURNING *
  `;
  return rows[0];
}

// Last N entries for a session, newest first (matches idx ordering). The
// controller reads these into tick context (D1/D4).
export async function recentRoutineRunLog(
  sessionId: string,
  limit = 20,
): Promise<RoutineRunLogEntry[]> {
  return sql<RoutineRunLogEntry[]>`
    SELECT * FROM routine_run_log
    WHERE session_id = ${sessionId}
    ORDER BY created_at DESC
    LIMIT ${limit}
  `;
}

// ── routine_queue ──────────────────────────────────────────────────────────

export type RoutineQueueStatus = 'pending' | 'running' | 'done' | 'failed' | 'cancelled';

export interface RoutineQueueEntry {
  id: string;
  session_id: string;
  priority: number;
  status: RoutineQueueStatus;
  enqueued_at: string;
  started_at: string | null;
}

export async function enqueueRoutine(
  sessionId: string,
  priority = 0,
): Promise<RoutineQueueEntry> {
  const rows = await sql<RoutineQueueEntry[]>`
    INSERT INTO routine_queue (session_id, priority)
    VALUES (${sessionId}, ${priority})
    RETURNING *
  `;
  return rows[0];
}

// Pending entries in drain order (priority DESC, then FIFO). Phase 22 reads
// these against the global concurrency cap.
export async function pendingRoutineQueue(): Promise<RoutineQueueEntry[]> {
  return sql<RoutineQueueEntry[]>`
    SELECT * FROM routine_queue
    WHERE status = 'pending'
    ORDER BY priority DESC, enqueued_at ASC
  `;
}

// ── orchestrator_approvals (Phase 29 — HITL merge approval markers) ──────────
// P28 proposes high-tier commands to chat; a human approval writes one marker row
// here keyed by the proposal tuple (session_id, command, content_sha). The
// off-hours merge command reads UNCONSUMED markers, merges matching PASS PRs, and
// flips consumed_at so a re-fired window cannot double-merge (R-ADO-25).

export interface OrchestratorApproval {
  id: string;
  session_id: string;
  command: string;
  content_sha: string;
  approved_at: string;
  consumed_at: string | null;
  created_at: string;
}

export interface NewOrchestratorApproval {
  session_id: string;
  command: string;
  content_sha: string;
}

// Insert (or no-op return existing) an approval marker for a proposal tuple. The
// UNIQUE (session_id, command, content_sha) index makes a duplicate human approval
// idempotent; ON CONFLICT returns the existing row.
export async function insertApproval(a: NewOrchestratorApproval): Promise<OrchestratorApproval> {
  const rows = await sql<OrchestratorApproval[]>`
    INSERT INTO orchestrator_approvals (session_id, command, content_sha)
    VALUES (${a.session_id}, ${a.command}, ${a.content_sha})
    ON CONFLICT (session_id, command, content_sha) DO UPDATE
      SET session_id = EXCLUDED.session_id
    RETURNING *
  `;
  return rows[0];
}

// Unconsumed approval markers for a session (the merge command's hot read).
export async function listUnconsumedApprovals(sessionId: string): Promise<OrchestratorApproval[]> {
  return sql<OrchestratorApproval[]>`
    SELECT * FROM orchestrator_approvals
    WHERE session_id = ${sessionId} AND consumed_at IS NULL
    ORDER BY approved_at ASC
  `;
}

// Mark one approval consumed (idempotency guard: only flips an unconsumed row).
// Returns the updated row, or null if it was already consumed / not found.
export async function markApprovalConsumed(id: string): Promise<OrchestratorApproval | null> {
  const rows = await sql<OrchestratorApproval[]>`
    UPDATE orchestrator_approvals
    SET consumed_at = now()
    WHERE id = ${id} AND consumed_at IS NULL
    RETURNING *
  `;
  return rows[0] ?? null;
}
