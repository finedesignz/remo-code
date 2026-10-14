// hub/src/orchestrator/proof-verifier.ts
// PTYCAP-05 plan 03: the hub-side detective layer and the success test.
//
// verifyProof(github, run) classifies a running proof from GitHub facts ONLY:
// the frozen ProofRun fields (branch, default_branch, base_sha, required_contexts)
// and what the injected, read-only ProofGithub returns. Nothing the agent says is
// an input (D-12). No write call, no timer: verification is tick-driven by the
// existing controller tick (rule 23).

import {
  PROOF_BRANCH_PREFIX,
  PROOF_SUCCESS_OUTCOME,
  ProofGithubError,
  type CheckState,
  type CompareResult,
  type ProofGithub,
  type ProofOutcome,
  type ProofRun,
  type PullSummary,
} from './proof-types.ts';

export type ProofPendingState = 'no_pr' | 'ci_pending' | 'ci_red' | 'ci_unverifiable';

export type ProofObservation =
  | { kind: 'terminal'; outcome: ProofOutcome; detail: string; prUrl?: string; prNumber?: number }
  | {
      kind: 'pending';
      state: ProofPendingState;
      prUrl?: string;
      prNumber?: number;
      headSha?: string;
      detail: string;
    };

type Terminal = Extract<ProofObservation, { kind: 'terminal' }>;
type Pending = Extract<ProofObservation, { kind: 'pending' }>;

const prRef = (pr: PullSummary | null): { prUrl?: string; prNumber?: number } =>
  pr ? { prUrl: pr.htmlUrl, prNumber: pr.number } : {};

const terminal = (outcome: ProofOutcome, detail: string, pr: PullSummary | null = null): Terminal => ({
  kind: 'terminal',
  outcome,
  detail,
  ...prRef(pr),
});

const pending = (state: ProofPendingState, detail: string, pr: PullSummary | null = null): Pending => ({
  kind: 'pending',
  state,
  detail,
  ...prRef(pr),
  ...(pr?.headSha ? { headSha: pr.headSha } : {}),
});

/** compare(base_sha, default branch): null = unchanged, otherwise the verdict to return. */
async function checkDefaultBranch(
  github: ProofGithub,
  run: ProofRun,
  pr: PullSummary | null,
): Promise<Terminal | Pending | null> {
  let cmp: CompareResult;
  try {
    cmp = await github.compare(run.repo_owner, run.repo_name, run.base_sha, run.default_branch);
  } catch (err) {
    // A base that no longer exists (history rewrite) is "not identical", not a read failure.
    if (err instanceof ProofGithubError && err.kind === 'not_found') {
      return terminal('terminated:main_advanced', 'compare_base_not_found', pr);
    }
    return pending('ci_unverifiable', 'compare_unreadable', pr);
  }
  if (cmp.status !== 'identical') {
    return terminal('terminated:main_advanced', `compare_${cmp.status} aheadBy=${cmp.aheadBy} behindBy=${cmp.behindBy}`, pr);
  }
  return null;
}

/** Newest PR wins; an open one beats a closed one. */
function pickPr(mine: PullSummary[]): PullSummary | null {
  if (mine.length === 0) return null;
  return [...mine].sort((a, b) => {
    const open = Number(b.state === 'open') - Number(a.state === 'open');
    return open !== 0 ? open : b.number - a.number;
  })[0];
}

const RED_CONCLUSIONS = new Set(['failure', 'cancelled', 'timed_out', 'action_required', 'startup_failure', 'stale']);
const RED_COMMIT_STATUSES = new Set(['failure', 'error']);

/**
 * The CI evaluation step (D-13). Green only from complete, successful evidence that
 * covers every frozen required context; every ambiguity is non-green. 'neutral' and
 * 'skipped' are deliberately not success evidence.
 */
async function evaluateCi(github: ProofGithub, run: ProofRun, pr: PullSummary): Promise<Terminal | Pending> {
  if (!pr.headSha) return pending('ci_unverifiable', 'pr_head_sha_missing', pr);

  let state: CheckState;
  try {
    state = await github.getCheckState(run.repo_owner, run.repo_name, pr.headSha);
  } catch {
    return pending('ci_unverifiable', 'checks_unreadable', pr);
  }
  if (state.truncated) return pending('ci_unverifiable', 'checks_truncated', pr);

  const runs = state.checkRuns;
  const stats = state.statuses;
  if (
    runs.some((c) => c.status === 'completed' && c.conclusion != null && RED_CONCLUSIONS.has(c.conclusion)) ||
    stats.some((s) => RED_COMMIT_STATUSES.has(s.state))
  ) {
    return pending('ci_red', 'ci_red', pr);
  }
  if (runs.some((c) => c.status !== 'completed') || stats.some((s) => s.state === 'pending')) {
    return pending('ci_pending', 'ci_pending', pr);
  }

  const passed = new Set<string>([
    ...runs.filter((c) => c.conclusion === 'success').map((c) => c.name),
    ...stats.filter((s) => s.state === 'success').map((s) => s.context),
  ]);
  const missing = run.required_contexts.filter((ctx) => !passed.has(ctx));
  if (missing.length > 0) return pending('ci_pending', `required_not_success ${missing.join(',')}`, pr);
  if (passed.size === 0) return pending('ci_pending', 'no_passing_check', pr);

  // Re-compare after the CI read so a default-branch advance mid-verification is never green.
  const advanced = await checkDefaultBranch(github, run, pr);
  if (advanced) return advanced;

  return terminal(PROOF_SUCCESS_OUTCOME, 'pr_open_green', pr);
}

export async function verifyProof(github: ProofGithub, run: ProofRun): Promise<ProofObservation> {
  // (1) default branch: any commit since base_sha is terminal (F1-3).
  const advanced = await checkDefaultBranch(github, run, null);
  if (advanced) return advanced;

  // (2) PR scope (D-10 iii).
  let pulls: PullSummary[];
  try {
    pulls = await github.listPulls(run.repo_owner, run.repo_name, run.armed_at);
  } catch {
    return pending('ci_unverifiable', 'pulls_unreadable');
  }
  // QC round 1 (codex #5): a PR the run did not make, opened after arming from any head that is not
  // under proof/, is out of scope (D-10 iii). Older PRs predate the run and are not the agent's.
  const armedAt = Date.parse(String(run.armed_at instanceof Date ? run.armed_at.toISOString() : run.armed_at));
  const offPrefix = pulls.find((p) => {
    if (p.headRef.startsWith(PROOF_BRANCH_PREFIX)) return false;
    const created = p.createdAt ? Date.parse(p.createdAt) : NaN;
    return !Number.isFinite(created) || !Number.isFinite(armedAt) || created >= armedAt;
  });
  if (offPrefix) {
    return terminal('terminated:pr_scope_violation', `off_prefix_head ${offPrefix.headRef} by ${offPrefix.authorLogin ?? 'unknown'}`, offPrefix);
  }
  const foreign = pulls.find((p) => p.headRef.startsWith(PROOF_BRANCH_PREFIX) && p.headRef !== run.branch);
  if (foreign) return terminal('terminated:pr_scope_violation', `foreign_head ${foreign.headRef}`, foreign);

  const mine = pulls.filter((p) => p.headRef === run.branch);
  // The success PR must come from the armed repository itself; a fork can reuse the branch name.
  const armedFull = `${run.repo_owner}/${run.repo_name}`.toLowerCase();
  const fork = mine.find((p) => (p.headRepoFullName ?? '').toLowerCase() !== armedFull);
  if (fork) return terminal('terminated:pr_scope_violation', `foreign_head_repo ${fork.headRepoFullName ?? 'deleted'}`, fork);
  const wrongBase = mine.find((p) => p.baseRef !== run.default_branch);
  if (wrongBase) return terminal('terminated:pr_scope_violation', `wrong_base ${wrongBase.baseRef}`, wrongBase);
  const merged = mine.find((p) => p.merged || p.mergedAt);
  if (merged) return terminal('terminated:main_advanced', 'proof_pr_merged', merged);

  const pr = pickPr(mine);
  if (!pr) return pending('no_pr', 'no_pr');
  if (pr.state !== 'open') return pending('no_pr', 'pr_closed', pr);

  // (3) CI state for the PR head.
  return evaluateCi(github, run, pr);
}
