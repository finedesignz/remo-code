/**
 * Deploy decoupling policy (Phase 6).
 *
 * Per master plan D5/D6:
 *   - Coolify watches `main` (AUTOMERGE_BRANCH) only.
 *   - `minor` risk → squash-merge directly to AUTOMERGE_BRANCH (auto-deploy).
 *   - `major`/`breaking` → open PR with base=STAGING_BRANCH; human review;
 *     no auto-merge, no auto-deploy.
 *   - `local_path` repos: commit on sandbox branch + leave; never call Coolify
 *     and never auto-merge (user owns deploy).
 *
 * Env vars (no new config files):
 *   REVANOTE_AUTOMERGE_BRANCH   default 'main'
 *   REVANOTE_STAGING_BRANCH     default 'agent-staging'
 *   REVANOTE_DEPLOY_BRANCH      default 'main'  (informational; Coolify-side)
 */
import type { RiskClass } from './risk-classifier.ts'
import type { MergeDecision } from './merge-gate.ts'
import type { RepoKind } from './sandbox.ts'

export interface DeployPolicy {
  automergeBranch: string
  stagingBranch: string
  deployBranch: string
}

export function loadDeployPolicy(): DeployPolicy {
  return {
    automergeBranch: process.env.REVANOTE_AUTOMERGE_BRANCH || 'main',
    stagingBranch: process.env.REVANOTE_STAGING_BRANCH || 'agent-staging',
    deployBranch: process.env.REVANOTE_DEPLOY_BRANCH || 'main',
  }
}

export interface PolicyDecisionInput {
  riskClass: RiskClass
  repoKind: RepoKind
  ciGreen: boolean
}

export interface PolicyDecision {
  /** Outcome the gate should emit. */
  decision: MergeDecision
  /** Branch the PR should target (when applicable). */
  baseBranch: string
  /** Whether the gate should actually squash-merge after PR open. */
  performMerge: boolean
  /** Whether to send an emails4agents notification on PR open. */
  notify: boolean
  /** Short rationale string for the callback `reasons` list. */
  rationale: string
}

/**
 * Decide what the merge-gate should do.
 *
 * Hard rules:
 *   - local_path repos NEVER auto-merge and NEVER trigger notification —
 *     user's machine, user's git. Just leave a sandbox branch.
 *   - github + minor + ci_green → auto_merged to AUTOMERGE_BRANCH.
 *   - github + minor + ci_not_green → pr_opened against AUTOMERGE_BRANCH
 *     (so reviewer can decide to merge after CI lands).
 *   - github + major → pr_opened against STAGING_BRANCH; notify.
 *   - github + breaking → pr_opened against STAGING_BRANCH; notify.
 */
export function decidePolicy(
  input: PolicyDecisionInput,
  policy: DeployPolicy = loadDeployPolicy(),
): PolicyDecision {
  // local_path: never auto-merge, never notify, no PR (no remote anyway).
  if (input.repoKind === 'local_path') {
    return {
      decision: 'pr_opened', // synthetic — represents "sandbox branch left for user"
      baseBranch: policy.automergeBranch,
      performMerge: false,
      notify: false,
      rationale: 'local_path_no_remote_action',
    }
  }

  // github + minor: try to auto-merge.
  if (input.riskClass === 'minor') {
    if (input.ciGreen) {
      return {
        decision: 'auto_merged',
        baseBranch: policy.automergeBranch,
        performMerge: true,
        notify: false,
        rationale: 'minor_ci_green_automerge',
      }
    }
    return {
      decision: 'pr_opened',
      baseBranch: policy.automergeBranch,
      performMerge: false,
      notify: false, // CI-pending PR isn't a human-needed event yet
      rationale: 'minor_ci_pending',
    }
  }

  // github + major/breaking: PR against staging, notify.
  return {
    decision: 'pr_opened',
    baseBranch: policy.stagingBranch,
    performMerge: false,
    notify: true,
    rationale: `${input.riskClass}_human_review_required`,
  }
}
