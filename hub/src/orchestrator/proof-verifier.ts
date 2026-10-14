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
  ProofGithubError,
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

/**
 * The CI evaluation step (D-13). Task 2 of plan 03 fills this in; until then it can
 * only ever answer "not green".
 */
async function evaluateCi(_github: ProofGithub, _run: ProofRun, pr: PullSummary): Promise<Terminal | Pending> {
  return pending('ci_pending', 'ci_not_evaluated', pr);
}

export async function verifyProof(github: ProofGithub, run: ProofRun): Promise<ProofObservation> {
  // (1) default branch: any commit since base_sha is terminal (F1-3).
  const advanced = await checkDefaultBranch(github, run, null);
  if (advanced) return advanced;

  // (2) PR scope (D-10 iii).
  let pulls: PullSummary[];
  try {
    pulls = await github.listPullsWithHeadPrefix(run.repo_owner, run.repo_name, PROOF_BRANCH_PREFIX);
  } catch {
    return pending('ci_unverifiable', 'pulls_unreadable');
  }
  const foreign = pulls.find((p) => p.headRef.startsWith(PROOF_BRANCH_PREFIX) && p.headRef !== run.branch);
  if (foreign) return terminal('terminated:pr_scope_violation', `foreign_head ${foreign.headRef}`, foreign);

  const mine = pulls.filter((p) => p.headRef === run.branch);
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
