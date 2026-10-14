// hub/src/orchestrator/proof-types.ts
// PTYCAP-05 (throwaway-repo due->PR proof): flag predicates, closed status/outcome
// sets, the ProofRun row shape and the guard/hook seam types.
//
// TYPES AND PURE FUNCTIONS ONLY. macro-cycle.ts imports this module at the top
// level, so it must stay free of DB / network / heavy imports: with the flag stack
// OFF nothing beyond this file is ever loaded (D-03 true no-op).

import type { ParsedSentinels } from './sentinels.ts';

// ── Flag stack (D-03) ────────────────────────────────────────────────────────

export const PROOF_FLAG_ENV = 'REMO_ORCHESTRATOR_PROOF';

function envOn(name: string): boolean {
  const raw = (process.env[name] ?? '0').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

/** The proof's own flag. Default OFF. Reads process.env at call time. */
export function isProofFlagOn(): boolean {
  return envOn(PROOF_FLAG_ENV);
}

/**
 * The full flag stack: proof AND orchestrator AND autospawn must each be ON.
 * (Same 1|true|yes|on parse as controller.ts; deliberately NOT imported from it.)
 */
export function isProofEnabled(): boolean {
  return isProofFlagOn() && envOn('REMO_ORCHESTRATOR_ENABLED') && envOn('REMO_ORCHESTRATOR_AUTOSPAWN');
}

export const PROOF_BRANCH_PREFIX = 'proof/';

// ── Status / outcome closed sets (D-04) ──────────────────────────────────────

export const ACTIVE_STATUSES = ['armed', 'running'] as const;
export const TERMINAL_STATUSES = ['succeeded', 'nothing', 'terminated', 'disarmed'] as const;
export type ActiveProofStatus = (typeof ACTIVE_STATUSES)[number];
export type TerminalProofStatus = (typeof TERMINAL_STATUSES)[number];
export type ProofStatus = ActiveProofStatus | TerminalProofStatus;

export const PROOF_SUCCESS_OUTCOME = 'pr_open_green' as const;

export const NOTHING_REASONS = [
  'not_allowlisted',
  'supervisor_offline',
  'launch_cap',
  'over_token_cap',
  'kill_switch',
  'lifetime_exhausted',
  'cost_cap',
  'no_session',
  'no_pr_produced_within_budget',
  'agent_declined',
  'guard_error',
  'repo_mismatch',
] as const;
export type NothingReason = (typeof NOTHING_REASONS)[number];

export const TERMINATED_REASONS = [
  'pr_open_ci_red',
  'budget_injects',
  'budget_tokens',
  'budget_wall',
  'budget_attribution_lost',
  'main_advanced',
  'pr_scope_violation',
  'proof_protection_unverifiable',
  'proof_protection_drift',
] as const;
export type TerminatedReason = (typeof TERMINATED_REASONS)[number];

export type ProofOutcome =
  | typeof PROOF_SUCCESS_OUTCOME
  | `nothing:${NothingReason}`
  | `terminated:${TerminatedReason}`;

export function isProofOutcome(v: unknown): v is ProofOutcome {
  if (typeof v !== 'string') return false;
  if (v === PROOF_SUCCESS_OUTCOME) return true;
  if (v.startsWith('nothing:')) return (NOTHING_REASONS as readonly string[]).includes(v.slice('nothing:'.length));
  if (v.startsWith('terminated:')) {
    return (TERMINATED_REASONS as readonly string[]).includes(v.slice('terminated:'.length));
  }
  return false;
}

/** The terminal status an outcome maps to ('disarmed' has no outcome). */
export function outcomeToStatus(outcome: ProofOutcome): 'succeeded' | 'nothing' | 'terminated' {
  if (outcome === PROOF_SUCCESS_OUTCOME) return 'succeeded';
  return outcome.startsWith('nothing:') ? 'nothing' : 'terminated';
}

// ── Row shape (snake_case exactly as the DDL) ────────────────────────────────

export interface ProofRun {
  id: string;
  user_id: string;
  task_id: string;
  session_id: string;
  repo_ident: string;
  counter_key: string;
  branch: string;
  installation_id: number | string;
  repo_owner: string;
  repo_name: string;
  default_branch: string;
  base_sha: string;
  ruleset_ids: Array<number | string>;
  ruleset_digest: string;
  ruleset_updated_at: string | Date | null;
  protection_shape: string;
  required_contexts: string[];
  arm_preconditions: Record<string, unknown>;
  max_injects: number;
  max_tokens: number | string;
  max_wall_ms: number | string;
  status: ProofStatus;
  outcome: string | null;
  outcome_detail: string | null;
  pr_url: string | null;
  pr_number: number | null;
  last_ci_state: string | null;
  last_inject_outcome: string | null;
  tokens_hwm: number | string;
  armed_at: string | Date;
  updated_at: string | Date;
  started_at: string | Date | null;
  terminal_at: string | Date | null;
}

// ── Guard / hook seam ────────────────────────────────────────────────────────

/** What macro-cycle hands the guard (a subset of MacroCycleInput + the reconcile result). */
export interface ProofGuardInput {
  userId: string;
  sessionId: string;
  taskId: string;
  repoIdent: string;
  repoKey: string | null;
  /** Parsed sentinels of the prior assistant reply, or null when there was none. */
  sentinels: ParsedSentinels | null;
  /** true when a turn is already in flight for the session (evaluated BEFORE the guard). */
  runLive: boolean;
}

export type ProofGuardDecision =
  | { kind: 'pass_through' }
  | { kind: 'proceed'; run: ProofRun }
  | { kind: 'wait'; run: ProofRun }
  | { kind: 'terminal'; outcome: ProofOutcome; run: ProofRun | null; won: boolean }
  | { kind: 'blocked'; reason: string };

export type ProofDecisionKind = ProofGuardDecision['kind'];

/** Injectable seam: macro-cycle only ever talks to the proof code through this. */
export interface ProofCycleHooks {
  guard: (input: ProofGuardInput) => Promise<ProofGuardDecision>;
  /** Render the proof prompt from the CLAIMED snapshot (throws unless it is running). */
  render: (run: ProofRun) => string;
  /** Best-effort: persist what the inject did (never throws). */
  observeInject: (run: ProofRun, outcomeKind: string) => Promise<void>;
  /** End a claimed run when the cycle itself failed after the claim (never throws). */
  abort: (run: ProofRun, reason: NothingReason, detail: string, input: ProofGuardInput) => Promise<void>;
}

// ── ProofGithub: the READ-ONLY, injectable GitHub contract (D-12) ────────────
// The hub never shells out to `gh`. Plan 05-02 wraps hub/src/auth/github-app.ts in the
// real adapter; every other plan builds against this interface and the shared fake in
// hub/test/fixtures/proof-fake-github.ts. NO method writes anything to GitHub.

export type ProofGithubErrorKind = 'forbidden' | 'not_found' | 'unavailable';

/** Typed failure: 403 -> forbidden, 404 -> not_found, everything else -> unavailable. */
export class ProofGithubError extends Error {
  constructor(
    public kind: ProofGithubErrorKind,
    public status: number | null,
    message?: string,
  ) {
    super(message ?? `github ${kind}${status != null ? ` (${status})` : ''}`);
    this.name = 'ProofGithubError';
  }
}

export interface RepoInfo {
  fullName: string;
  defaultBranch: string;
}

export interface EffectiveRule {
  type: string;
  rulesetId: number | null;
  rulesetSourceType: string | null;
  parameters: Record<string, unknown> | null;
}

export interface RulesetDetail {
  id: number;
  name: string;
  target: string;
  sourceType: string;
  enforcement: string;
  /** null means "not returned to this token" (GitHub shows it only to callers with write access). */
  bypassActors: unknown[] | null;
  conditions: unknown;
  rules: Array<{ type: string; parameters: Record<string, unknown> | null }>;
  updatedAt: string | null;
}

export interface CompareResult {
  status: 'identical' | 'ahead' | 'behind' | 'diverged';
  aheadBy: number;
  behindBy: number;
}

export interface PullSummary {
  number: number;
  htmlUrl: string;
  state: string;
  merged: boolean;
  mergedAt: string | null;
  headRef: string;
  headSha: string;
  baseRef: string;
  draft: boolean;
}

export interface CheckState {
  checkRuns: Array<{ name: string; status: string; conclusion: string | null }>;
  statuses: Array<{ context: string; state: string }>;
  truncated: boolean;
}

export interface PermissionProbe {
  administrationRead: boolean;
  checksRead: boolean;
  statusesRead: boolean;
  pullsRead: boolean;
  contentsRead: boolean;
}

export interface ProofGithub {
  getRepo(owner: string, repo: string): Promise<RepoInfo>;
  getBranchHeadSha(owner: string, repo: string, branch: string): Promise<string>;
  getEffectiveBranchRules(owner: string, repo: string, branch: string): Promise<EffectiveRule[]>;
  getRuleset(owner: string, repo: string, rulesetId: number): Promise<RulesetDetail>;
  compare(owner: string, repo: string, base: string, head: string): Promise<CompareResult>;
  listPullsWithHeadPrefix(owner: string, repo: string, headPrefix: string): Promise<PullSummary[]>;
  getCheckState(owner: string, repo: string, sha: string): Promise<CheckState>;
  listWorkflowFiles(owner: string, repo: string, ref: string): Promise<string[]>;
  getCollaboratorPermission(owner: string, repo: string, username: string): Promise<string>;
  probePermissions(owner: string, repo: string): Promise<PermissionProbe>;
}
