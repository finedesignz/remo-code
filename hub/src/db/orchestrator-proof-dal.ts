// hub/src/db/orchestrator-proof-dal.ts
// PTYCAP-05: persistence for orchestrator_proof_runs (the throwaway-repo due->PR proof).
//
// Every transition is ONE conditional statement (claim, terminalize), so two ticks
// can never both win. The DAL never flips a flag or sets a cap (D-05): budgets are
// frozen into the row at arm time by the arm transaction.

import { sql } from './postgres.ts';
import type { ProofOutcome, ProofRun, TerminalProofStatus } from '../orchestrator/proof-types.ts';
import { outcomeToStatus, PROOF_BRANCH_PREFIX } from '../orchestrator/proof-types.ts';

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

// ── Arm / disarm / enable: each ONE transaction under a per-user advisory lock (F2-1) ──

export class ProofStateError extends Error {
  constructor(public code: 'other_repo_allowlisted' | 'proof_already_active' | 'proof_not_armed', message?: string) {
    super(message ?? code);
    this.name = 'ProofStateError';
  }
}

export interface ProofFrozenFields {
  installationId: number;
  repoOwner: string;
  repoName: string;
  defaultBranch: string;
  baseSha: string;
  rulesetIds: number[];
  rulesetDigest: string;
  rulesetUpdatedAt: string | null;
  protectionShape: string;
  requiredContexts: string[];
  armPreconditions: Record<string, unknown>;
  maxInjects: number;
  maxTokens: number;
  maxWallMs: number;
}

export interface ArmProofRunArgs extends ProofFrozenFields {
  userId: string;
  sessionId: string;
  repoIdent: string;
  /** schedule_rule of the single 'proof' orchestrator_rows row (so the due-scan can fire it). */
  scheduleRule: { interval: number; unit: string; start_at: string };
}

const proofLockKey = (userId: string) => 'proof-arm:' + userId;

/**
 * Arm: create the DISABLED proof task, its one due row, the exact allowlist row and the
 * frozen proof row atomically. Any throw rolls everything back. The DAL never flips a
 * flag or sets a cap (D-05): the budgets arrive frozen in `args`.
 */
export async function armProofRunTx(args: ArmProofRunArgs): Promise<{ run: ProofRun; taskId: string }> {
  try {
    return await (sql as any).begin(async (tx: any) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext(${proofLockKey(args.userId)})::bigint)`;

      const allow = (await tx`
        SELECT repo_ident FROM orchestrator_autospawn_allowlist WHERE user_id = ${args.userId}
      `) as Array<{ repo_ident: string }>;
      if (allow.some((r) => r.repo_ident !== args.repoIdent)) throw new ProofStateError('other_repo_allowlisted');

      const active = (await tx`
        SELECT id FROM orchestrator_proof_runs
        WHERE user_id = ${args.userId} AND status IN ('armed','running') LIMIT 1
      `) as Array<{ id: string }>;
      if (active.length > 0) throw new ProofStateError('proof_already_active');

      const existing = (await tx`
        SELECT id FROM scheduled_tasks
        WHERE user_id = ${args.userId} AND session_id = ${args.sessionId} AND task_type = 'orchestrator' LIMIT 1
      `) as Array<{ id: string }>;
      let taskId: string;
      if (existing.length > 0) {
        taskId = existing[0].id;
        await tx`
          UPDATE scheduled_tasks SET enabled = false, macro_task_type = 'dev'
          WHERE id = ${taskId} AND user_id = ${args.userId}
        `;
      } else {
        const created = (await tx`
          INSERT INTO scheduled_tasks (
            user_id, session_id, name, cron_expression, prompt,
            task_type, target_kind, target_id, lifecycle_stage, macro_task_type, enabled
          ) VALUES (
            ${args.userId}, ${args.sessionId}, 'Orchestrator', '@orchestrator', '',
            'orchestrator', 'session', ${args.sessionId}, 'development', 'dev', false
          )
          RETURNING id
        `) as Array<{ id: string }>;
        taskId = created[0].id;
      }

      await tx`
        INSERT INTO orchestrator_rows (task_id, command, enabled, schedule_rule, sort_order)
        VALUES (${taskId}, 'proof', true, ${tx.json(args.scheduleRule as any)}, 0)
      `;
      await tx`
        INSERT INTO orchestrator_autospawn_allowlist (user_id, repo_ident)
        VALUES (${args.userId}, ${args.repoIdent})
        ON CONFLICT (user_id, repo_ident) DO NOTHING
      `;

      const runId = crypto.randomUUID();
      const inserted = (await tx`
        INSERT INTO orchestrator_proof_runs (
          id, user_id, task_id, session_id, repo_ident, counter_key, branch, installation_id,
          repo_owner, repo_name, default_branch, base_sha, ruleset_ids, ruleset_digest,
          ruleset_updated_at, protection_shape, required_contexts, arm_preconditions,
          max_injects, max_tokens, max_wall_ms
        ) VALUES (
          ${runId}, ${args.userId}, ${taskId}, ${args.sessionId}, ${args.repoIdent},
          ${'task:' + taskId}, ${PROOF_BRANCH_PREFIX + runId}, ${args.installationId},
          ${args.repoOwner}, ${args.repoName}, ${args.defaultBranch}, ${args.baseSha},
          ${args.rulesetIds}::bigint[], ${args.rulesetDigest},
          ${args.rulesetUpdatedAt}, ${args.protectionShape}, ${args.requiredContexts}::text[],
          ${tx.json(args.armPreconditions as any)},
          ${args.maxInjects}, ${args.maxTokens}, ${args.maxWallMs}
        )
        RETURNING *
      `) as ProofRun[];
      return { run: inserted[0], taskId };
    });
  } catch (err: any) {
    if (err?.code === '23505') throw new ProofStateError('proof_already_active', err?.message);
    throw err;
  }
}

/**
 * Disarm: end the user's active run as 'disarmed' (no outcome), disable its task and
 * proof row, and remove ONLY the exact (user_id, repo_ident) allowlist row.
 * Rule 6: the allowlist row is configuration, deleted by exact (user_id, repo_ident)
 * WHERE, never a bare DELETE. Idempotent when nothing is active.
 */
export async function disarmProofRunTx(args: { userId: string; detail?: string | null }): Promise<
  { disarmed: false } | { disarmed: true; run: ProofRun }
> {
  return (sql as any).begin(async (tx: any) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${proofLockKey(args.userId)})::bigint)`;
    const ended = (await tx`
      UPDATE orchestrator_proof_runs
      SET status = 'disarmed', outcome = NULL, outcome_detail = ${args.detail ?? 'disarmed by owner'},
          terminal_at = now(), updated_at = now()
      WHERE user_id = ${args.userId} AND status IN ('armed','running')
      RETURNING *
    `) as ProofRun[];
    if (ended.length === 0) return { disarmed: false as const };
    const run = ended[0];
    await tx`UPDATE scheduled_tasks SET enabled = false WHERE id = ${run.task_id} AND user_id = ${args.userId}`;
    await tx`UPDATE orchestrator_rows SET enabled = false WHERE task_id = ${run.task_id} AND command = 'proof'`;
    await tx`
      DELETE FROM orchestrator_autospawn_allowlist
      WHERE user_id = ${args.userId} AND repo_ident = ${run.repo_ident}
    `;
    return { disarmed: true as const, run };
  });
}

/** Enable: only an 'armed' run may have its task switched on (the owner's go). */
export async function enableProofTaskTx(args: { userId: string }): Promise<{ run: ProofRun }> {
  return (sql as any).begin(async (tx: any) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${proofLockKey(args.userId)})::bigint)`;
    const armed = (await tx`
      SELECT * FROM orchestrator_proof_runs WHERE user_id = ${args.userId} AND status = 'armed' LIMIT 1
    `) as ProofRun[];
    if (armed.length === 0) throw new ProofStateError('proof_not_armed');
    await tx`UPDATE scheduled_tasks SET enabled = true WHERE id = ${armed[0].task_id} AND user_id = ${args.userId}`;
    return { run: armed[0] };
  });
}

// ── Reads / counters ─────────────────────────────────────────────────────────

/** The run whose counter_key matches (any status) or, failing that, the ACTIVE run for the session. */
export async function findProofRunForRequest(args: { counterKey?: string | null; sessionId?: string | null }): Promise<ProofRun | null> {
  if (args.counterKey) {
    const byKey = await sql<ProofRun[]>`
      SELECT * FROM orchestrator_proof_runs WHERE counter_key = ${args.counterKey}
      ORDER BY armed_at DESC LIMIT 1
    `;
    if (byKey[0]) return byKey[0];
  }
  if (args.sessionId) {
    const bySession = await sql<ProofRun[]>`
      SELECT * FROM orchestrator_proof_runs
      WHERE session_id = ${args.sessionId} AND status IN ('armed','running')
      ORDER BY armed_at DESC LIMIT 1
    `;
    return bySession[0] ?? null;
  }
  return null;
}

/** The armed/running run for a repo (merge-routing refusal, plan 05-05). */
export async function findActiveProofRunForRepo(repoIdent: string): Promise<ProofRun | null> {
  const rows = await sql<ProofRun[]>`
    SELECT * FROM orchestrator_proof_runs
    WHERE repo_ident = ${repoIdent} AND status IN ('armed','running') LIMIT 1
  `;
  return rows[0] ?? null;
}

/** Live injects for a counter key since `since`: the Phase 4 ledger is the only counter (D-06). */
export async function countProofInjects(counterKey: string, since: Date | string): Promise<number> {
  const rows = await sql<{ n: string | number }[]>`
    SELECT COUNT(*) AS n FROM automation_inject_ledger
    WHERE counter_key = ${counterKey} AND kind = 'inject' AND released_at IS NULL AND created_at >= ${since}
  `;
  return Number(rows[0]?.n ?? 0);
}

export interface ProofObservationPatch {
  pr_url?: string | null;
  pr_number?: number | null;
  last_ci_state?: string | null;
  last_inject_outcome?: string | null;
  /** candidate token total; the stored tokens_hwm only ever rises (GREATEST). */
  tokens?: number | null;
}

/** Observation write while the run is ACTIVE; tokens_hwm is a monotone high-water mark. */
export async function recordProofObservation(runId: string, patch: ProofObservationPatch): Promise<ProofRun | null> {
  const rows = await sql<ProofRun[]>`
    UPDATE orchestrator_proof_runs
    SET pr_url = COALESCE(${patch.pr_url ?? null}, pr_url),
        pr_number = COALESCE(${patch.pr_number ?? null}, pr_number),
        last_ci_state = COALESCE(${patch.last_ci_state ?? null}, last_ci_state),
        last_inject_outcome = COALESCE(${patch.last_inject_outcome ?? null}, last_inject_outcome),
        tokens_hwm = GREATEST(tokens_hwm, ${patch.tokens ?? 0}),
        updated_at = now()
    WHERE id = ${runId} AND status IN ('armed','running')
    RETURNING *
  `;
  return rows[0] ?? null;
}

export async function listProofRunsForUser(userId: string, limit = 20): Promise<ProofRun[]> {
  return sql<ProofRun[]>`
    SELECT * FROM orchestrator_proof_runs WHERE user_id = ${userId}
    ORDER BY armed_at DESC LIMIT ${limit}
  `;
}
