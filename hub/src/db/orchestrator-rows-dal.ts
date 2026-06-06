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
