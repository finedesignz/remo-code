// hub/src/orchestrator/proof-protection.ts
// PTYCAP-05 (D-08, D-09; verdict F1-1/2/4/5/6): the never-merge control's verifier.
//
// The PREVENTIVE control is GitHub's (a ruleset on the default branch). The hub only
// proves it exists, freezes a digest of it at arm, and re-asserts before EVERY dispatch.
// Pure functions over the read-only ProofGithub contract; everything fails CLOSED:
// an unreadable field is never defaulted to the safe value.
//
// Credential scrubbing is deliberately NOT a control here (the orchestrator session is
// exempt from the git-push scrub), so nothing in the proof modules relies on it.

import { createHash } from 'node:crypto';
import { ProofGithubError, type EffectiveRule, type ProofGithub, type RulesetDetail } from './proof-types.ts';

export type ProtectionShape = 'branch_lock' | 'review_gate';

export interface ProofRepoTarget {
  owner: string;
  repo: string;
}

export interface FrozenProtection {
  owner: string;
  repo: string;
  defaultBranch: string;
  /** Contributing ruleset ids, sorted ascending. */
  rulesetIds: number[];
  digest: string;
  /** Max updated_at across the contributing rulesets. */
  updatedAt: string;
  /** Required status-check contexts, sorted and de-duplicated. */
  requiredContexts: string[];
  shape: ProtectionShape;
}

export type ProtectionFailReason = 'proof_protection_unverifiable' | 'proof_protection_insufficient';

export type EvaluateProtectionResult =
  | { ok: true; frozen: FrozenProtection }
  | { ok: false; reason: ProtectionFailReason; detail: string };

export type ReassertProtectionResult =
  | { ok: true }
  | { ok: false; reason: 'proof_protection_drift' | 'proof_protection_unverifiable'; detail: string };

// ── Canonical digest ─────────────────────────────────────────────────────────

/** JSON with object keys sorted recursively (arrays keep their order). */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
}

/** Rules sorted by type, then by their serialized form (parameters / ruleset id). */
function sortRules<T extends { type: string }>(rules: T[]): T[] {
  return rules
    .map((r) => ({ r, k: canonicalJson(r) }))
    .sort((a, b) => (a.r.type < b.r.type ? -1 : a.r.type > b.r.type ? 1 : a.k < b.k ? -1 : a.k > b.k ? 1 : 0))
    .map((x) => x.r);
}

/** sha256 hex over the canonical form of the effective rules and the contributing rulesets. */
export function protectionDigest(effective: EffectiveRule[], rulesets: RulesetDetail[]): string {
  const payload = {
    effectiveRules: sortRules(effective),
    rulesets: [...rulesets]
      .sort((a, b) => a.id - b.id)
      .map((r) => ({
        id: r.id,
        enforcement: r.enforcement,
        target: r.target,
        sourceType: r.sourceType,
        conditions: r.conditions,
        rules: sortRules(r.rules),
        bypassActors: r.bypassActors,
        updatedAt: r.updatedAt,
      })),
  };
  return createHash('sha256').update(canonicalJson(payload)).digest('hex');
}

// ── Evaluate ─────────────────────────────────────────────────────────────────

const unverifiable = (detail: string): EvaluateProtectionResult => ({ ok: false, reason: 'proof_protection_unverifiable', detail });
const insufficient = (detail: string): EvaluateProtectionResult => ({ ok: false, reason: 'proof_protection_insufficient', detail });

const BRANCH_LOCK_TYPES = new Set(['update', 'required_status_checks']);
const REVIEW_GATE_TYPES = new Set(['pull_request', 'non_fast_forward', 'required_status_checks']);

function errDetail(e: unknown): string {
  if (e instanceof ProofGithubError) return `github_${e.kind}`;
  return 'github_error';
}

/** Required contexts of one required_status_checks rule; null = malformed. */
function contextsOf(rule: EffectiveRule): string[] | null {
  const list = rule.parameters?.required_status_checks;
  if (!Array.isArray(list)) return null;
  const out: string[] = [];
  for (const c of list) {
    const ctx = (c as { context?: unknown } | null)?.context;
    if (typeof ctx !== 'string' || ctx === '') return null;
    out.push(ctx);
  }
  return out;
}

/**
 * Accepts exactly two shapes on the default branch (verdict F1-1):
 *  - branch_lock: `update` rule + required status checks
 *  - review_gate: `pull_request` (>=1 approval AND last-push approval) + `non_fast_forward`
 *    + required status checks
 * Both need >=1 required context and ZERO, VISIBLE bypass actors on every contributing
 * ruleset. 'PR + green check' alone is NOT preventive (the dev macro squash-merges on green).
 */
export async function evaluateProtection(
  github: ProofGithub,
  target: ProofRepoTarget & { defaultBranch: string },
): Promise<EvaluateProtectionResult> {
  try {
    const { owner, repo, defaultBranch } = target;

    const info = await github.getRepo(owner, repo);
    if (info.defaultBranch !== defaultBranch) return unverifiable('default_branch_mismatch');

    const effective = await github.getEffectiveBranchRules(owner, repo, defaultBranch);
    if (!Array.isArray(effective) || effective.length === 0) return unverifiable('no_effective_rules');
    if (effective.some((r) => typeof r?.type !== 'string' || typeof r.rulesetId !== 'number')) {
      return unverifiable('rule_without_ruleset');
    }

    const ofType = (t: string) => effective.filter((r) => r.type === t);

    // required_status_checks: malformed parameters are unverifiable; zero contexts is not a gate.
    const contexts = new Set<string>();
    for (const r of ofType('required_status_checks')) {
      const c = contextsOf(r);
      if (c === null) return unverifiable('malformed_required_status_checks');
      c.forEach((x) => contexts.add(x));
    }
    const hasChecks = contexts.size > 0;

    // pull_request: strongest approval count, any last-push approval.
    let approvals = 0;
    let lastPush = false;
    for (const r of ofType('pull_request')) {
      const n = r.parameters?.required_approving_review_count;
      if (typeof n !== 'number') return unverifiable('malformed_pull_request');
      approvals = Math.max(approvals, n);
      if (r.parameters?.require_last_push_approval === true) lastPush = true;
    }

    const branchLock = ofType('update').length > 0 && hasChecks;
    const reviewGate = approvals >= 1 && lastPush && ofType('non_fast_forward').length > 0 && hasChecks;
    if (!branchLock && !reviewGate) return insufficient('shape_not_preventive');
    const shape: ProtectionShape = branchLock ? 'branch_lock' : 'review_gate';

    // Every ruleset contributing a rule this shape relies on must be active, branch-scoped,
    // fully readable and bypass-free.
    const used = shape === 'branch_lock' ? BRANCH_LOCK_TYPES : REVIEW_GATE_TYPES;
    const ids = [...new Set(effective.filter((r) => used.has(r.type)).map((r) => r.rulesetId as number))].sort((a, b) => a - b);

    const rulesets: RulesetDetail[] = [];
    for (const id of ids) {
      const rs = await github.getRuleset(owner, repo, id);
      if (!rs || rs.id !== id) return unverifiable('ruleset_id_mismatch');
      if (rs.enforcement !== 'active') return unverifiable('ruleset_not_active');
      if (rs.target !== 'branch') return unverifiable('ruleset_not_branch');
      if (!Array.isArray(rs.rules) || rs.rules.length === 0) return unverifiable('ruleset_empty_rules');
      if (!Array.isArray(rs.bypassActors)) return unverifiable('bypass_actors_not_visible');
      if (rs.bypassActors.length > 0) return insufficient('ruleset_has_bypass_actors');
      if (typeof rs.updatedAt !== 'string' || Number.isNaN(Date.parse(rs.updatedAt))) return unverifiable('ruleset_updated_at_missing');
      rulesets.push(rs);
    }

    const updatedAt = rulesets.reduce((max, r) => (Date.parse(r.updatedAt as string) > Date.parse(max) ? (r.updatedAt as string) : max), rulesets[0]!.updatedAt as string);

    return {
      ok: true,
      frozen: {
        owner,
        repo,
        defaultBranch,
        rulesetIds: ids,
        digest: protectionDigest(effective, rulesets),
        updatedAt,
        requiredContexts: [...contexts].sort(),
        shape,
      },
    };
  } catch (e) {
    return unverifiable(errDetail(e));
  }
}

// ── Re-assert (before EVERY dispatch and each tick) ──────────────────────────

/** Re-evaluates and compares to the arm-time freeze. Never throws. */
export async function reassertProtection(github: ProofGithub, frozen: FrozenProtection): Promise<ReassertProtectionResult> {
  try {
    const fresh = await evaluateProtection(github, frozen);
    if (!fresh.ok) {
      // The default branch moved or protection weakened since arm: that is a change, not a read failure.
      if (fresh.detail === 'default_branch_mismatch' || fresh.reason === 'proof_protection_insufficient') {
        return { ok: false, reason: 'proof_protection_drift', detail: fresh.detail };
      }
      return { ok: false, reason: 'proof_protection_unverifiable', detail: fresh.detail };
    }
    const f = fresh.frozen;
    if (f.digest !== frozen.digest) return { ok: false, reason: 'proof_protection_drift', detail: 'digest_changed' };
    if (f.updatedAt !== frozen.updatedAt) return { ok: false, reason: 'proof_protection_drift', detail: 'updated_at_changed' };
    if (JSON.stringify(f.rulesetIds) !== JSON.stringify([...frozen.rulesetIds].sort((a, b) => a - b))) {
      return { ok: false, reason: 'proof_protection_drift', detail: 'ruleset_ids_changed' };
    }
    if (f.defaultBranch !== frozen.defaultBranch) return { ok: false, reason: 'proof_protection_drift', detail: 'default_branch_changed' };
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: 'proof_protection_unverifiable', detail: errDetail(e) };
  }
}

// ── Permission probe (F1-5) ──────────────────────────────────────────────────

const PERMISSION_NAMES = [
  ['administrationRead', 'administration_read'],
  ['checksRead', 'checks_read'],
  ['statusesRead', 'commit_statuses_read'],
  ['pullsRead', 'pull_requests_read'],
  ['contentsRead', 'contents_read'],
] as const;

export type PermissionResult = { ok: true } | { ok: false; reason: 'proof_permissions_missing'; missing: string[] };

/** The App must be able to READ everything the verifier needs; any absence fails closed. */
export async function assertGithubPermissions(github: ProofGithub, target: ProofRepoTarget): Promise<PermissionResult> {
  try {
    const probe = await github.probePermissions(target.owner, target.repo);
    const missing = PERMISSION_NAMES.filter(([k]) => probe[k] !== true).map(([, name]) => name as string);
    return missing.length === 0 ? { ok: true } : { ok: false, reason: 'proof_permissions_missing', missing };
  } catch {
    return { ok: false, reason: 'proof_permissions_missing', missing: PERMISSION_NAMES.map(([, name]) => name as string) };
  }
}

// ── Agent credential admin check (F1-4) ──────────────────────────────────────

export type AgentAdminResult =
  | { ok: false; reason: 'agent_credential_is_admin' }
  | { ok: true; verified: true }
  | { ok: true; verified: false; detail: string };

/** An admin agent could edit or delete the ruleset. Unreadable is recorded 'unverified', never 'ok'. */
export async function assertAgentNotAdmin(
  github: ProofGithub,
  target: ProofRepoTarget,
  agentLogin: string | undefined,
): Promise<AgentAdminResult> {
  if (!agentLogin) return { ok: true, verified: false, detail: 'no_agent_login' };
  try {
    const perm = await github.getCollaboratorPermission(target.owner, target.repo, agentLogin);
    if (perm.toLowerCase() === 'admin') return { ok: false, reason: 'agent_credential_is_admin' };
    return { ok: true, verified: true };
  } catch (e) {
    return { ok: true, verified: false, detail: errDetail(e) };
  }
}
