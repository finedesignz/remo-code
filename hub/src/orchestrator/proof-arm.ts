// hub/src/orchestrator/proof-arm.ts
// PTYCAP-05-07 (D-05, D-06, D-09, D-17; verdict F1-2/F1-4/F1-5/F2-1/F2-2): the owner's one-shot
// arming core. DATA ONLY: it never flips a REMO_* flag, never sets a cap and never calls a
// hosting provider. Every external effect (GitHub reads, lookups, the DAL transactions) sits
// behind `ProofArmDeps`, and the caller environment is passed IN (deps.env), never read from the global here.
//
// Rule 6: the only deletion in the whole mechanism is the disarm transaction removing the one
// exact (user_id, repo_ident) allowlist configuration row; see disarmProofRunTx.

import { assertAgentNotAdmin, assertGithubPermissions, evaluateProtection } from './proof-protection.ts';
import type { ProofGithub, ProofRun } from './proof-types.ts';
import type { ArmProofRunArgs } from '../db/orchestrator-proof-dal.ts';

export type ArmRefusalCode =
  | 'github_app_unconfigured'
  | 'invalid_budget'
  | 'invalid_schedule'
  | 'installation_not_owned'
  | 'repo_not_in_installation'
  | 'session_repo_mismatch'
  | 'proof_permissions_missing'
  | 'no_ci_workflow'
  | 'proof_protection_unverifiable'
  | 'proof_protection_insufficient'
  | 'agent_credential_is_admin'
  | 'other_repo_allowlisted'
  | 'other_orchestrator_task_enabled'
  | 'proof_already_active';

export const DEFAULT_MAX_INJECTS = 6;
export const DEFAULT_MAX_TOKENS = 3_000_000;
export const DEFAULT_MAX_WALL_MS = 21_600_000;
export const DEFAULT_EVERY = 30;
export const DEFAULT_UNIT = 'minutes';

export interface ProofArmDeps {
  isGithubAppConfigured(): boolean;
  makeGithub(installationId: number): ProofGithub;
  getInstallation(userId: string, installationId: number): Promise<{ id: number | string; user_id: string; revoked_at: unknown } | null>;
  listInstallationRepos(installationId: number): Promise<Array<{ full_name: string; default_branch: string }>>;
  getSession(sessionId: string): Promise<{ user_id: string; repo_key: string | null } | null>;
  listAllowlist(userId: string): Promise<string[]>;
  /** Enabled orchestrator tasks (ANY user) other than the one arm will create/reuse for this session. */
  countOtherEnabledOrchestratorTasks(args: { userId: string; sessionId: string }): Promise<number>;
  armTx(args: ArmProofRunArgs): Promise<{ run: ProofRun; taskId: string }>;
  /** The caller's environment, passed in. Only REMO_PROOF_MAX_* are read, and only at arm time. */
  env: Record<string, string | undefined>;
  now(): Date;
}

export interface ArmProofArgs {
  userId: string;
  sessionId: string;
  repoIdent: string;
  installationId: number;
  agentLogin?: string;
  /** Flag values are text (or numbers); anything not a positive integer is refused. */
  maxInjects?: string | number;
  maxTokens?: string | number;
  maxWallMs?: string | number;
  every?: string | number;
  unit?: string;
  dryRun?: boolean;
}

export interface ArmSummary {
  repoIdent: string;
  installationId: number;
  sessionId: string;
  defaultBranch: string;
  baseSha: string;
  branchPreview: string;
  budget: { maxInjects: number; maxTokens: number; maxWallMs: number };
  schedule: { interval: number; unit: string };
  protectionShape: string;
  requiredContexts: string[];
  rulesetIds: number[];
  digestPrefix: string;
  allowlist: string[];
  bypassVerification: 'verified';
  agentPermission: 'verified' | 'unverified';
  warnings: string[];
  taskId?: string;
  runId?: string;
  branch?: string;
}

export type ArmProofResult =
  | { ok: true; dryRun: boolean; summary: ArmSummary }
  | { ok: false; code: ArmRefusalCode; detail: string };

const refuse = (code: ArmRefusalCode, detail: string): { ok: false; code: ArmRefusalCode; detail: string } => ({ ok: false, code, detail });

/** Strict positive integer: a number, or text that is only digits. Anything else is garbage. */
function parsePositiveInt(v: string | number | undefined): number | null | undefined {
  if (v === undefined) return undefined;
  if (typeof v === 'number') return Number.isSafeInteger(v) && v > 0 ? v : null;
  if (!/^[0-9]+$/.test(v)) return null;
  const n = Number(v);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** Flag, then env, then default. Garbage in either source refuses: no silent default. */
function resolveBudget(flag: string | number | undefined, envVal: string | undefined, fallback: number): number | null {
  const fromFlag = parsePositiveInt(flag);
  if (fromFlag !== undefined) return fromFlag;
  const fromEnv = parsePositiveInt(envVal);
  if (fromEnv !== undefined) return fromEnv;
  return fallback;
}

const REPO_IDENT_RE = /^github:\/\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/;

/** What the owner needs to read when the ruleset reader cannot see bypass actors. */
function explainProtectionDetail(detail: string): string {
  if (detail === 'bypass_actors_not_visible') {
    return (
      'bypass_actors_not_visible: the GitHub App token cannot see bypass actors on the ruleset, so the hub cannot prove ' +
      'nobody can bypass it. Arm refuses (fail closed on ambiguity; there is no attestation override).'
    );
  }
  return detail;
}

export async function armProof(args: ArmProofArgs, deps: ProofArmDeps): Promise<ArmProofResult> {
  // 1. GitHub App configured.
  if (!deps.isGithubAppConfigured()) {
    return refuse('github_app_unconfigured', 'the GitHub App is not configured on this host (no app id/key); the proof cannot verify protection');
  }

  // 2. Budgets (and cadence): frozen at arm time; garbage refuses.
  const maxInjects = resolveBudget(args.maxInjects, deps.env.REMO_PROOF_MAX_INJECTS, DEFAULT_MAX_INJECTS);
  const maxTokens = resolveBudget(args.maxTokens, deps.env.REMO_PROOF_MAX_TOKENS, DEFAULT_MAX_TOKENS);
  const maxWallMs = resolveBudget(args.maxWallMs, deps.env.REMO_PROOF_MAX_WALL_MS, DEFAULT_MAX_WALL_MS);
  if (maxInjects === null || maxTokens === null || maxWallMs === null) {
    const bad = [maxInjects === null && 'max injects', maxTokens === null && 'max tokens', maxWallMs === null && 'max wall ms'].filter(Boolean);
    return refuse('invalid_budget', `${bad.join(', ')} must be a positive integer (digits only); no default is applied to garbage`);
  }
  const every = parsePositiveInt(args.every);
  const unit = args.unit ?? DEFAULT_UNIT;
  if (every === null || (unit !== 'minutes' && unit !== 'hours')) {
    return refuse('invalid_schedule', '--every must be a positive integer and --unit minutes|hours');
  }
  const interval = every ?? DEFAULT_EVERY;

  // 3. The installation belongs to this user and is not revoked.
  const installation = Number.isSafeInteger(args.installationId) && args.installationId > 0
    ? await deps.getInstallation(args.userId, args.installationId)
    : null;
  if (!installation || installation.user_id !== args.userId || installation.revoked_at != null) {
    return refuse('installation_not_owned', `installation ${args.installationId} is not an active installation of this user`);
  }

  // 4. The repo resolves through that installation.
  const m = REPO_IDENT_RE.exec(args.repoIdent);
  if (!m) return refuse('repo_not_in_installation', `repo ident '${args.repoIdent}' is not github://owner/repo`);
  const [, owner, repo] = m;
  const fullName = `${owner}/${repo}`.toLowerCase();
  const repos = await deps.listInstallationRepos(args.installationId);
  const hit = repos.find((r) => r.full_name.toLowerCase() === fullName);
  if (!hit) return refuse('repo_not_in_installation', `${owner}/${repo} is not among the repositories of installation ${args.installationId}`);
  const defaultBranch = hit.default_branch;

  // 5. The session is this user's and is bound to exactly this repo.
  const session = await deps.getSession(args.sessionId);
  if (!session || session.user_id !== args.userId || session.repo_key !== args.repoIdent) {
    return refuse('session_repo_mismatch', `session ${args.sessionId} is missing, not this user's, or its repo_key is not ${args.repoIdent}`);
  }

  const github = deps.makeGithub(args.installationId);
  const target = { owner, repo };

  // 6. Permissions the verifier needs (F1-5).
  const perms = await assertGithubPermissions(github, target);
  if (!perms.ok) {
    return refuse('proof_permissions_missing', `the GitHub App lacks read permissions: ${perms.missing.join(', ')}`);
  }

  // 7. A CI workflow exists (no CI = the required-check gate is meaningless).
  let workflows: string[];
  try {
    workflows = await github.listWorkflowFiles(owner, repo, defaultBranch);
  } catch {
    return refuse('no_ci_workflow', 'could not list .github/workflows on the default branch (fail closed)');
  }
  if (!workflows.some((f) => /\.ya?ml$/i.test(f))) {
    return refuse('no_ci_workflow', 'no .yml/.yaml workflow under .github/workflows on the default branch');
  }

  // 8. The never-merge protection (frozen on success).
  const prot = await evaluateProtection(github, { owner, repo, defaultBranch });
  if (!prot.ok) return refuse(prot.reason, explainProtectionDetail(prot.detail));
  const frozen = prot.frozen;

  let baseSha: string;
  try {
    baseSha = await github.getBranchHeadSha(owner, repo, defaultBranch);
  } catch {
    return refuse('proof_protection_unverifiable', 'could not read the default-branch head sha (fail closed)');
  }

  // 9. The agent credential must not be able to edit the ruleset (unreadable = recorded, loudly).
  const admin = await assertAgentNotAdmin(github, target, args.agentLogin);
  if (!admin.ok) return refuse(admin.reason, `agent login '${args.agentLogin}' is a repository admin and could edit or delete the ruleset`);
  const warnings: string[] = [];
  const agentPermission: 'verified' | 'unverified' = admin.verified ? 'verified' : 'unverified';
  if (!admin.verified) {
    warnings.push(
      `WARNING: arm_preconditions.agent_permission = unverified (${admin.detail}). The hub could not prove the agent credential is not an admin; the runbook check is the control.`,
    );
  }

  // 10. Exactly-one allowlist invariant (re-checked authoritatively inside the arm transaction).
  const allowlist = await deps.listAllowlist(args.userId);
  if (allowlist.some((r) => r !== args.repoIdent)) {
    return refuse('other_repo_allowlisted', `the autospawn allowlist already holds another repo (${allowlist.filter((r) => r !== args.repoIdent).length}); it must be empty or exactly the target`);
  }

  // 11. Exclusivity (QC round 1): the hub flags are global, so any OTHER enabled orchestrator
  //     task would receive the ordinary dev macro once proof mode is on. Re-checked in the arm tx.
  const otherTasks = await deps.countOtherEnabledOrchestratorTasks({ userId: args.userId, sessionId: args.sessionId });
  if (otherTasks > 0) {
    return refuse('other_orchestrator_task_enabled', `${otherTasks} other orchestrator task(s) are enabled (any user); proof mode is hub-global and exclusive - disable them first`);
  }

  const summary: ArmSummary = {
    repoIdent: args.repoIdent,
    installationId: args.installationId,
    sessionId: args.sessionId,
    defaultBranch,
    baseSha,
    branchPreview: 'proof/<run-id>',
    budget: { maxInjects, maxTokens, maxWallMs },
    schedule: { interval, unit },
    protectionShape: frozen.shape,
    requiredContexts: frozen.requiredContexts,
    rulesetIds: frozen.rulesetIds,
    digestPrefix: frozen.digest.slice(0, 12),
    allowlist,
    bypassVerification: 'verified',
    agentPermission,
    warnings,
  };

  if (args.dryRun) return { ok: true, dryRun: true, summary };

  try {
    const { run, taskId } = await deps.armTx({
      userId: args.userId,
      sessionId: args.sessionId,
      repoIdent: args.repoIdent,
      installationId: args.installationId,
      repoOwner: owner,
      repoName: repo,
      defaultBranch,
      baseSha,
      rulesetIds: frozen.rulesetIds,
      rulesetDigest: frozen.digest,
      rulesetUpdatedAt: frozen.updatedAt,
      protectionShape: frozen.shape,
      requiredContexts: frozen.requiredContexts,
      // evaluateProtection only succeeds with bypass actors visible AND empty: 'verified' exactly (05-04 key).
      armPreconditions: {
        bypass_verification: 'verified',
        agent_permission: agentPermission,
        ...(args.agentLogin ? { agent_login: args.agentLogin } : {}),
        github_permissions: 'verified',
        ci_workflow: 'present',
        armed_at: deps.now().toISOString(),
      },
      maxInjects,
      maxTokens,
      maxWallMs,
      scheduleRule: { interval, unit, start_at: deps.now().toISOString() },
    });
    return { ok: true, dryRun: false, summary: { ...summary, taskId, runId: run.id, branch: run.branch } };
  } catch (err) {
    const code = stateErrorCode(err);
    if (code === 'other_repo_allowlisted' || code === 'proof_already_active' || code === 'other_orchestrator_task_enabled') return refuse(code, `refused inside the arm transaction: ${code}`);
    throw err;
  }
}

/** ProofStateError without importing the DAL (which would pull in the sql client). */
function stateErrorCode(err: unknown): string | null {
  const e = err as { name?: string; code?: string } | null;
  return e && e.name === 'ProofStateError' && typeof e.code === 'string' ? e.code : null;
}

// ── Disarm: transaction FIRST, kill switch second, flags last (owner, runbook) ──────────────

export interface ProofDisarmDeps {
  disarmTx(args: { userId: string; detail?: string | null }): Promise<{ disarmed: false } | { disarmed: true; run: ProofRun }>;
  engageKillSwitch(args: {
    scope: 'session';
    userId: string;
    sessionId: string;
    reason: string;
    engagedBy: string;
  }): Promise<unknown>;
}

export type DisarmProofResult =
  | { disarmed: false }
  | { disarmed: true; run: ProofRun; killSwitch: { engaged: boolean; error?: string } };

/**
 * An ONLINE session bypasses the autospawn branch, so flags alone would not stop it. Order is
 * therefore: (1) one transaction terminalizes the run, disables the task + its row and removes
 * only the exact allowlist row; (2) best-effort session kill switch (a failure is reported, it
 * never undoes the disarm and never throws); (3) the owner unsets flags, later, by hand.
 */
export async function disarmProof(args: { userId: string; detail?: string | null }, deps: ProofDisarmDeps): Promise<DisarmProofResult> {
  const out = await deps.disarmTx({ userId: args.userId, ...(args.detail !== undefined ? { detail: args.detail } : {}) });
  if (!out.disarmed) return { disarmed: false };
  try {
    await deps.engageKillSwitch({
      scope: 'session',
      userId: args.userId,
      sessionId: out.run.session_id,
      reason: 'proof disarmed',
      engagedBy: 'arm-orchestrator-proof',
    });
    return { disarmed: true, run: out.run, killSwitch: { engaged: true } };
  } catch (err) {
    return { disarmed: true, run: out.run, killSwitch: { engaged: false, error: String((err as Error)?.message ?? err) } };
  }
}

// ── Enable: the owner's final act, only on an armed run (D-17) ──────────────────────────────

export interface ProofEnableDeps {
  enableTx(args: { userId: string }): Promise<{ run: ProofRun }>;
}

export type EnableProofResult =
  | { ok: true; run: ProofRun; message: string }
  | { ok: false; code: 'proof_not_armed' | 'other_orchestrator_task_enabled'; detail: string };

export async function enableProof(args: { userId: string }, deps: ProofEnableDeps): Promise<EnableProofResult> {
  try {
    const { run } = await deps.enableTx({ userId: args.userId });
    return {
      ok: true,
      run,
      message:
        'task enabled: the first tick spawns the build session for the armed repo. Watch the proof status endpoint; --disarm stops it.',
    };
  } catch (err) {
    const code = stateErrorCode(err);
    if (code === 'proof_not_armed') return { ok: false, code: 'proof_not_armed', detail: 'no armed proof run to enable' };
    if (code === 'other_orchestrator_task_enabled') {
      return { ok: false, code: 'other_orchestrator_task_enabled', detail: 'another orchestrator task is enabled (any user); proof mode is exclusive - disable it first' };
    }
    throw err;
  }
}
