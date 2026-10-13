// hub/src/db/orchestrator-proof-dal.ts
// PTYCAP-05: persistence for orchestrator_proof_runs (the throwaway-repo due->PR proof).
//
// Every transition is ONE conditional statement (claim, terminalize), so two ticks
// can never both win. The DAL never flips a flag or sets a cap (D-05): budgets are
// frozen into the row at arm time by the arm transaction.

import { sql } from './postgres.ts';
import type { ProofOutcome, ProofRun, TerminalProofStatus } from '../orchestrator/proof-types.ts';
import { outcomeToStatus } from '../orchestrator/proof-types.ts';

/**
 * THE atomic find-and-claim: armed -> running (idempotent for an already running
 * run) in a single UPDATE ... RETURNING. Returns the post-claim snapshot the prompt
 * is rendered from (no second lookup, F3-1), or null when the task has no active run.
 */
export async function claimActiveProofRunForTask(taskId: string): Promise<ProofRun | null> {
  const rows = await sql<ProofRun[]>`
    UPDATE orchestrator_proof_runs
    SET status = 'running', started_at = COALESCE(started_at, now()), updated_at = now()
    WHERE task_id = ${taskId} AND status IN ('armed','running')
    RETURNING *
  `;
  return rows[0] ?? null;
}

/** True when the task owns ANY proof run, active or terminal (F3-2 blocked check). */
export async function taskHasAnyProofRun(taskId: string): Promise<boolean> {
  const rows = await sql<{ n: string | number }[]>`
    SELECT 1 AS n FROM orchestrator_proof_runs WHERE task_id = ${taskId} LIMIT 1
  `;
  return rows.length > 0;
}

export interface TerminalizeArgs {
  status?: TerminalProofStatus;
  outcome: ProofOutcome;
  detail?: string | null;
  prUrl?: string | null;
  prNumber?: number | null;
}

/**
 * Conditional terminal transition. A null result means the claim was lost (the run
 * was already terminal): the caller MUST then do nothing further (single winner).
 */
export async function terminalizeProofRun(args: { runId: string } & TerminalizeArgs): Promise<ProofRun | null> {
  const status = args.status ?? outcomeToStatus(args.outcome);
  const rows = await sql<ProofRun[]>`
    UPDATE orchestrator_proof_runs
    SET status = ${status}, outcome = ${args.outcome}, outcome_detail = ${args.detail ?? null},
        pr_url = COALESCE(${args.prUrl ?? null}, pr_url), pr_number = COALESCE(${args.prNumber ?? null}, pr_number),
        terminal_at = now(), updated_at = now()
    WHERE id = ${args.runId} AND status IN ('armed','running')
    RETURNING *
  `;
  return rows[0] ?? null;
}

/**
 * Same transition keyed by task, for the path where the claim itself threw and no
 * run snapshot exists (fail closed as nothing:guard_error).
 */
export async function terminalizeActiveProofRunForTask(
  args: { taskId: string } & TerminalizeArgs,
): Promise<ProofRun | null> {
  const status = args.status ?? outcomeToStatus(args.outcome);
  const rows = await sql<ProofRun[]>`
    UPDATE orchestrator_proof_runs
    SET status = ${status}, outcome = ${args.outcome}, outcome_detail = ${args.detail ?? null},
        terminal_at = now(), updated_at = now()
    WHERE task_id = ${args.taskId} AND status IN ('armed','running')
    RETURNING *
  `;
  return rows[0] ?? null;
}

/** Idempotent: disables the proof's orchestrator task. */
export async function disableProofTask(userId: string, taskId: string): Promise<void> {
  await sql`
    UPDATE scheduled_tasks SET enabled = false
    WHERE id = ${taskId} AND user_id = ${userId} AND task_type = 'orchestrator'
  `;
}

/** Persist what the last inject did (plan 05-06 adds the outcome mapping on the same seam). */
export async function recordProofInjectOutcome(runId: string, outcomeKind: string): Promise<void> {
  await sql`
    UPDATE orchestrator_proof_runs
    SET last_inject_outcome = ${outcomeKind}, updated_at = now()
    WHERE id = ${runId} AND status IN ('armed','running')
  `;
}
