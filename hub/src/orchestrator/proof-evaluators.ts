// hub/src/orchestrator/proof-evaluators.ts
// PTYCAP-05 plan 06 (D-06, D-07, D-12, D-13; verdict F1-2, F1-3, F2-3, F3-2): the ordered
// evaluator chain the proof guard runs on EVERY controller tick.
//
// Order is locked: killSwitch, repoMatch, protection, verifier, agentDeclined, budget.
// The first non-continue verdict wins. Facts come from GitHub (verifyProof) and the hub's
// own ledgers; the agent's STATE text is read only to END a run as agent_declined when no
// PR exists. Tick-driven (rule 23): no timer, no retry loop, no poll in this module.

import type { ProofEvaluator } from './proof-guard.ts';
import {
  reassertProtection,
  type FrozenProtection,
  type ProtectionShape,
  type ReassertProtectionResult,
} from './proof-protection.ts';
import type { ProofGithub, ProofOutcome, ProofRun } from './proof-types.ts';
import { verifyProof, type ProofObservation } from './proof-verifier.ts';

const DECLINE_REASON_MAX = 200;

export type BudgetReason = 'budget_wall' | 'budget_injects' | 'budget_tokens';

/** Refusal reasons from the closed `nothing:` set that are recoverable (the run keeps ticking). */
const RECOVERABLE_REASONS = ['supervisor_offline', 'launch_cap', 'no_session'] as const;

export interface ProofEvaluatorDeps {
  isHalted(args: { userId: string; sessionId: string }): Promise<{ halted: boolean }>;
  githubFor(run: ProofRun): ProofGithub;
  recordObservation(
    runId: string,
    patch: { pr_url?: string | null; pr_number?: number | null; last_ci_state?: string | null; tokens?: number | null },
  ): Promise<unknown>;
  countInjects(key: string, since: Date | string): Promise<number>;
  sumTokens(sessionId: string, since: Date | string): Promise<{ tokens: number; sessionExists: boolean; attributionLost?: boolean }>;
  /** Default: verifyProof. Injectable for tests. */
  verify?(github: ProofGithub, run: ProofRun): Promise<ProofObservation>;
  /** Default: reassertProtection. Injectable for tests. */
  reassert?(github: ProofGithub, frozen: FrozenProtection): Promise<ReassertProtectionResult>;
}

const ms = (v: string | Date): number => (v instanceof Date ? v.getTime() : Date.parse(v));

/** The arm-time protection freeze, rebuilt from the run row (owner/repo come from the row). */
export function frozenFromRun(run: ProofRun): FrozenProtection {
  const u = run.ruleset_updated_at;
  return {
    owner: run.repo_owner,
    repo: run.repo_name,
    defaultBranch: run.default_branch,
    rulesetIds: run.ruleset_ids.map(Number).sort((a, b) => a - b),
    digest: run.ruleset_digest,
    updatedAt: u instanceof Date ? u.toISOString() : String(u ?? ''),
    requiredContexts: [...run.required_contexts],
    shape: run.protection_shape as ProtectionShape,
  };
}

/** `<kind>` or `<kind>:<reason>` -> the reason part (or the bare kind when there is none). */
function lastInjectReason(lastInject: string | null | undefined): string | null {
  if (!lastInject) return null;
  const i = lastInject.indexOf(':');
  return i >= 0 ? lastInject.slice(i + 1) : lastInject;
}

/**
 * Outcome naming for a budget ending (D-13), pure:
 *  - red PR                -> terminated:pr_open_ci_red
 *  - any other PR          -> terminated:<reason>
 *  - no PR                 -> nothing:<last recoverable refusal> | nothing:no_pr_produced_within_budget
 */
export function selectBudgetOutcome(a: {
  reason: BudgetReason;
  ciState: string | null | undefined;
  hasPr: boolean;
  lastInject: string | null | undefined;
}): ProofOutcome {
  if (a.ciState === 'ci_red') return 'terminated:pr_open_ci_red';
  if (a.hasPr) return `terminated:${a.reason}`;
  const r = lastInjectReason(a.lastInject);
  if (r && (RECOVERABLE_REASONS as readonly string[]).includes(r)) return `nothing:${r}` as ProofOutcome;
  return 'nothing:no_pr_produced_within_budget';
}

export function defaultProofEvaluators(deps: ProofEvaluatorDeps): ProofEvaluator[] {
  const verify = deps.verify ?? verifyProof;
  const reassert = deps.reassert ?? reassertProtection;

  const killSwitch: ProofEvaluator = async function killSwitch({ input }) {
    try {
      const h = await deps.isHalted({ userId: input.userId, sessionId: input.sessionId });
      if (h.halted) return { kind: 'terminal', outcome: 'nothing:kill_switch', detail: 'automation kill switch engaged' };
      return { kind: 'continue' };
    } catch (err: any) {
      return { kind: 'terminal', outcome: 'nothing:guard_error', detail: `kill switch read failed: ${err?.message ?? String(err)}` };
    }
  };

  const repoMatch: ProofEvaluator = function repoMatch({ run, input }) {
    if (input.repoIdent !== run.repo_ident) {
      return { kind: 'terminal', outcome: 'nothing:repo_mismatch', detail: `task repo ${input.repoIdent} != run repo ${run.repo_ident}` };
    }
    return { kind: 'continue' };
  };

  const protection: ProofEvaluator = async function protection({ run }) {
    const res = await reassert(deps.githubFor(run), frozenFromRun(run));
    if (res.ok) return { kind: 'continue' };
    // Digest equal but updated_at text differs = timestamptz round-trip format only (the
    // digest already covers every ruleset updated_at), not a real change. Same as the gate.
    if (res.reason === 'proof_protection_drift' && res.detail === 'updated_at_changed') return { kind: 'continue' };
    return {
      kind: 'terminal',
      outcome: res.reason === 'proof_protection_drift' ? 'terminated:proof_protection_drift' : 'terminated:proof_protection_unverifiable',
      detail: res.detail,
    };
  };

  const verifier: ProofEvaluator = async function verifier(ctx) {
    const obs = await verify(deps.githubFor(ctx.run), ctx.run);
    if (obs.kind === 'terminal') {
      return { kind: 'terminal', outcome: obs.outcome, detail: obs.detail, prUrl: obs.prUrl ?? null, prNumber: obs.prNumber ?? null };
    }
    await deps.recordObservation(ctx.run.id, {
      pr_url: obs.prUrl ?? null,
      pr_number: obs.prNumber ?? null,
      last_ci_state: obs.state,
    });
    ctx.observation = obs;
    return { kind: 'continue' };
  };

  // The agent's claim is honored only when GitHub shows no PR; otherwise it is ignored.
  const agentDeclined: ProofEvaluator = function agentDeclined({ input, observation }) {
    if (!(observation?.kind === 'pending' && observation.state === 'no_pr')) return { kind: 'continue' };
    const last = input.sentinels?.state?.last_action;
    if (typeof last !== 'string') return { kind: 'continue' };
    const t = last.trim();
    if (!/^nothing\b/i.test(t)) return { kind: 'continue' };
    const reason = t.replace(/^nothing\b[\s:\-\u2013\u2014]*/i, '').trim().slice(0, DECLINE_REASON_MAX);
    return { kind: 'terminal', outcome: 'nothing:agent_declined', detail: reason || 'agent declined (no reason given)' };
  };

  const budget: ProofEvaluator = async function budget({ run, input, now, observation }) {
    const pend = observation?.kind === 'pending' ? observation : null;
    const state = pend?.state ?? null;
    const hasPr = pend?.prNumber != null;
    const name = (reason: BudgetReason): ProofOutcome =>
      selectBudgetOutcome({ reason, ciState: state, hasPr, lastInject: run.last_inject_outcome });

    const since = run.started_at ?? run.armed_at;

    // Wall always terminates, even when no inject is attempted (tick-side termination).
    const elapsed = now - ms(since);
    if (Number.isFinite(elapsed) && elapsed >= Number(run.max_wall_ms)) {
      return { kind: 'terminal', outcome: name('budget_wall'), detail: `wall ${elapsed}ms>=${Number(run.max_wall_ms)}ms` };
    }

    const injects = await deps.countInjects(run.counter_key, since);
    const sum = await deps.sumTokens(run.session_id, since);
    if (!sum.sessionExists || sum.attributionLost) {
      return {
        kind: 'terminal',
        outcome: 'terminated:budget_attribution_lost',
        detail: sum.sessionExists ? 'a usage_event failed to persist; token spend is under-counted' : 'session row missing; token spend cannot be attributed',
      };
    }
    const hwm = Number(run.tokens_hwm);
    const tokens = Math.max(hwm, sum.tokens);
    if (tokens > hwm) {
      try {
        await deps.recordObservation(run.id, { tokens });
      } catch {
        /* the hwm is monotone and re-derived next tick */
      }
    }

    const spent: BudgetReason | null =
      injects >= run.max_injects ? 'budget_injects' : tokens >= Number(run.max_tokens) ? 'budget_tokens' : null;
    const ciWaiting = state === 'ci_pending' || state === 'ci_unverifiable';

    if (spent) {
      // A turn still in flight, or CI still running on an open PR: wait, never inject.
      if (input.runLive || ciWaiting) return { kind: 'wait' };
      const detail = spent === 'budget_injects' ? `injects ${injects}>=${run.max_injects}` : `tokens ${tokens}>=${Number(run.max_tokens)}`;
      return { kind: 'terminal', outcome: name(spent), detail };
    }
    if (ciWaiting) return { kind: 'wait' };
    return { kind: 'continue' };
  };

  return [killSwitch, repoMatch, protection, verifier, agentDeclined, budget];
}
