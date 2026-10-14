// hub/src/heal/sources/scheduled-task.ts
//
// PTYCAP-07-08 (SH-01, SH-02, SH-07, D-05, D-11, AM-F5-1..AM-F5-4): the scheduled-task failure
// source. A source that did not exist before: a failed non-internal, repo-bound task run becomes
// a HealEvent for routeHeal.
//
// Every guard here fails CLOSED (an error means no event and no notification suppression):
//   AM-F5-1  only a real failed transition: status failed, not reaper/race finalized
//            (only_if_active) and not a run_timeout error
//   AM-F5-3  recursion is impossible: internal tasks (flag OR __internal_ name) and any run in
//            the ledger's heal ancestry never produce an event
//   AM-F5-4  per-task daily ceiling
// The caller (finalizeRun) never lets this throw into the run lifecycle.

import { createHash } from 'node:crypto';
import { fenceUntrusted } from '../../dispatch/untrusted.ts';
import { healMaxPerTaskDay } from '../config.ts';
import { isInternalScheduledTask } from '../internal-task.ts';
import { canonicalRepoIdent, type RepoIdentSession } from '../repo-ident.ts';
import type { HealOutcome } from '../types.ts';

export interface HealableTask {
  id: string;
  name?: string | null;
  user_id: string;
  session_id?: string | null;
  is_internal?: boolean | null;
}

export interface FailedRunInput {
  runId: string;
  status: string;
  error: string | null | undefined;
  /** True for the reaper / TEAB race finalizers (claim-then-finalize). */
  onlyIfActive?: boolean;
  task: HealableTask;
}

export interface ScheduledSourceDeps {
  /** Throws on a probe error: the caller fails closed. */
  isHealGenerated(runId: string): Promise<boolean>;
  getSession(sessionId: string, userId: string): Promise<(RepoIdentSession & { runner_type?: string | null }) | null>;
  countTaskClaimsToday(userId: string, taskId: string): Promise<number>;
  routeHeal(event: unknown): Promise<HealOutcome>;
}

/** Real collaborators: lazy imports so importing this module never loads the DB or the route. */
export const REAL_SCHEDULED_SOURCE_DEPS: ScheduledSourceDeps = {
  isHealGenerated: async (runId) => (await import('../../db/heal-events-dal.ts')).isHealGenerated(runId),
  getSession: async (sessionId, userId) => {
    const { getSession } = await import('../../db/dal.ts');
    return (await getSession(sessionId, userId)) as (RepoIdentSession & { runner_type?: string | null }) | null;
  },
  countTaskClaimsToday: async (userId, taskId) => (await import('../../db/heal-events-dal.ts')).countTaskClaimsToday(userId, taskId),
  routeHeal: async (event) => (await import('../route.ts')).routeHeal(event),
};

/** Lowercased, uuid/hex/digit runs collapsed, whitespace squeezed, trimmed to 200 chars. */
export function normalizeError(error: string | null | undefined): string {
  return (error ?? '')
    .toLowerCase()
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<uuid>')
    .replace(/\b0x[0-9a-f]+\b/g, '<hex>')
    .replace(/\b[0-9a-f]{7,}\b/g, '<hex>')
    .replace(/\d+/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

function oneLine(s: string | null | undefined, max: number): string {
  return (s ?? '').replace(/[\r\n\t]+/g, ' ').slice(0, max);
}

/**
 * Heal a failed scheduled-task run. Resolves true ONLY when the heal path WON the owner
 * notification claim for this event (the caller then suppresses the default failure email), whether
 * or not that one send succeeded; every other result, including every error, resolves false so the
 * normal failure email proceeds. Exactly one owner notification per heal event.
 */
export async function healFailedScheduledRun(
  input: FailedRunInput,
  deps: ScheduledSourceDeps = REAL_SCHEDULED_SOURCE_DEPS,
): Promise<boolean> {
  const { runId, status, error, task } = input;
  if (status !== 'failed') return false;
  if (input.onlyIfActive === true) return false;
  if ((error ?? '').startsWith('run_timeout')) return false;
  if (isInternalScheduledTask(task)) return false;
  if (!task.session_id) return false;

  try {
    if (await deps.isHealGenerated(runId)) return false;
  } catch {
    return false; // fail closed
  }

  const session = await deps.getSession(task.session_id, task.user_id);
  if (!session) return false;
  const repoIdent = canonicalRepoIdent(session);
  if (!repoIdent) return false;

  if ((await deps.countTaskClaimsToday(task.user_id, task.id)) >= healMaxPerTaskDay()) return false;

  const normalized = normalizeError(error);
  const signature = createHash('sha256').update(normalized).digest('hex').slice(0, 16);
  const name = oneLine(task.name, 120);
  const prompt = [
    'A scheduled task run failed. Investigate the root cause in this repository and propose a fix as a pull request only.',
    'Do not push to main, merge or deploy.',
    '',
    fenceUntrusted('untrusted_task_failure', [`Task: ${name}`, `Run: ${runId}`, `Error: ${error ?? '(none)'}`].join('\n'), 4000),
  ].join('\n');

  const outcome = await deps.routeHeal({
    source: 'scheduled_task',
    user_id: task.user_id,
    repo_ident: repoIdent,
    prompt,
    stored_content: `[task failed: ${name}]\n\n${prompt}`,
    metadata_run_id: null,
    trigger_run_id: runId,
    dedupe_key: `task:${task.id}:${signature}`,
    bound_session_id: task.session_id,
    notify_summary: `Task "${name}" run ${runId} failed: ${oneLine(error, 300)}`.slice(0, 500),
    ctx: { task_id: task.id, task_name: name, error_signature: normalized },
  });
  if ('notifyClaimed' in outcome && outcome.notifyClaimed === true) return true;
  return 'notified' in outcome && outcome.notified === true;
}
