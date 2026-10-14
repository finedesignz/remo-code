// hub/src/orchestrator/proof-gates.ts
// PTYCAP-05 (D-02, D-03, D-06, F1-2, F2-3): the code-enforced stops on the orchestrator
// dispatch path for a proof run.
//
//  - proofBudgetGate     hard per-proof budget (injects / four-bucket tokens / wall) read
//                        from the FROZEN row, plus the counter-key pin and terminal block.
//  - proofProtectionGate re-asserts the frozen GitHub ruleset before EVERY proof dispatch,
//                        including a replay out of the grace buffer (the full list re-runs).
//
// Both are NON-consuming (the lifetime counter reserves after the gates) and never
// terminalize: a gate only blocks; the next tick's guard ends the run.
//
// With the flag stack OFF both gates are pass-through with ZERO db/network work: the real
// deps are dynamic-imported inside check(), only after the flag test passes (D-03). With the
// flag ON any lookup error fails CLOSED.

import type { DispatchGate, DispatchRequest } from '../dispatch/pipeline.ts';
import { ACTIVE_STATUSES, isProofEnabled, type ProofGithub, type ProofRun } from './proof-types.ts';
import type { FrozenProtection, ReassertProtectionResult, ProtectionShape } from './proof-protection.ts';

export const PROOF_BUDGET_GATE_NAME = 'proof_budget';
export const PROOF_PROTECTION_GATE_NAME = 'proof_protection';

type GateResult = { ok: true } | { ok: false; reason: string };

export interface ProofGateDeps {
  findRun(args: { requestKey?: string | null; sessionId: string }): Promise<ProofRun | null>;
  countInjects(key: string, since: Date | string): Promise<number>;
  sumTokens(sessionId: string, since: Date | string): Promise<{ tokens: number; sessionExists: boolean; attributionLost?: boolean }>;
  /** Monotone tokens_hwm write (best-effort, errors swallowed by the gate). */
  recordTokens(runId: string, tokens: number): Promise<unknown>;
  githubFor(run: ProofRun): ProofGithub;
  reassert(github: ProofGithub, frozen: FrozenProtection): Promise<ReassertProtectionResult>;
  now(): number;
}

/** Real deps, resolved lazily: nothing here is imported until the flag stack is ON. */
async function realDeps(): Promise<ProofGateDeps> {
  const [dal, tokens, gh, prot] = await Promise.all([
    import('../db/orchestrator-proof-dal.ts'),
    import('../db/token-usage-dal.ts'),
    import('./proof-github.ts'),
    import('./proof-protection.ts'),
  ]);
  return {
    findRun: (a) => dal.findProofRunForRequest(a),
    countInjects: (k, s) => dal.countProofInjects(k, s),
    sumTokens: (sid, s) => tokens.sumSessionTokensSince(sid, s),
    recordTokens: (id, t) => dal.recordProofObservation(id, { tokens: t }),
    githubFor: (run) => gh.makeProofGithub({ installationId: run.installation_id }),
    reassert: (g, f) => prot.reassertProtection(g, f),
    now: () => Date.now(),
  };
}

const isActive = (run: ProofRun): boolean => (ACTIVE_STATUSES as readonly string[]).includes(run.status);
const ms = (v: string | Date): number => (v instanceof Date ? v.getTime() : Date.parse(v));

/** The frozen arm-time protection, rebuilt from the run row (ids/installation are BIGINT-safe). */
function frozenOf(run: ProofRun): FrozenProtection {
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

/**
 * QC round 1 (codex #2): THE run-identity verdict, shared by the budget gate and the final
 * pre-send check. A proof dispatch is authentic only when its SERVER-ONLY `proofRunId` equals the
 * id of the ACTIVE run for the request. A prompt queued or parked before the arm (an ordinary dev
 * prompt that carries the reusable `task:<id>` counter key) has no `proofRunId`, so it can never
 * be authorized as proof traffic. Pure; null = authentic.
 */
export function proofIdentityRefusal(run: ProofRun | null, req: DispatchRequest): string | null {
  // Exclusive proof mode: a dispatch that matches no proof run is some other task.
  if (!run) return 'proof_mode_non_proof_task';
  // D-02 pin: a proof task may only dispatch with its own task:<id> counter key.
  if (req.counterKey !== run.counter_key || run.counter_key !== `task:${run.task_id}`) {
    return 'lifetime_counter_key_missing';
  }
  // A parked/replayed send must not outlive the run.
  if (!isActive(run)) return `proof_run_terminal:${run.outcome ?? run.status}`;
  if (req.proofRunId !== run.id) return 'proof_run_mismatch';
  return null;
}

/**
 * The LAST proof check, called by finalHaltCheck immediately before deps.send (and before a
 * lazy start): re-reads the run and re-applies the identity verdict, so a disarm / terminal that
 * committed after the gate list ran still stops the send. Fail closed; flag stack OFF = ok.
 */
export async function proofFinalCheck(req: DispatchRequest, deps?: ProofGateDeps): Promise<GateResult> {
  if (!isProofEnabled()) return { ok: true };
  try {
    const d = deps ?? (await realDeps());
    const run = await d.findRun({ requestKey: req.counterKey ?? null, sessionId: req.sessionId });
    const refusal = proofIdentityRefusal(run, req);
    return refusal ? { ok: false, reason: refusal } : { ok: true };
  } catch (err) {
    console.error(`[proof-gates] final identity check failed (fail closed): ${(err as Error)?.message ?? err}`);
    return { ok: false, reason: 'proof_budget_unverifiable' };
  }
}

export function makeProofBudgetGate(deps?: ProofGateDeps): DispatchGate {
  return {
    name: PROOF_BUDGET_GATE_NAME,
    async check(req: DispatchRequest): Promise<GateResult> {
      if (!isProofEnabled()) return { ok: true };
      try {
        const d = deps ?? (await realDeps());
        const run = await d.findRun({ requestKey: req.counterKey ?? null, sessionId: req.sessionId });
        const refusal = proofIdentityRefusal(run, req);
        if (refusal) return { ok: false, reason: refusal };
        if (!run) return { ok: false, reason: 'proof_mode_non_proof_task' }; // narrows the type

        const now = d.now();
        const since = run.started_at ?? run.armed_at;

        if (run.started_at && now - ms(run.started_at) >= Number(run.max_wall_ms)) {
          return { ok: false, reason: 'proof_budget_wall' };
        }

        const injects = await d.countInjects(run.counter_key, since);
        if (injects >= run.max_injects) {
          return { ok: false, reason: `proof_budget_injects:${injects}>=${run.max_injects}` };
        }

        const sum = await d.sumTokens(run.session_id, since);
        if (!sum.sessionExists || sum.attributionLost) return { ok: false, reason: 'proof_budget_attribution_lost' };
        const hwm = Number(run.tokens_hwm);
        const tokens = Math.max(hwm, sum.tokens);
        if (tokens > hwm) await d.recordTokens(run.id, tokens).catch(() => undefined);
        if (tokens >= Number(run.max_tokens)) {
          return { ok: false, reason: `proof_budget_tokens:${tokens}>=${Number(run.max_tokens)}` };
        }
        return { ok: true };
      } catch (err) {
        console.error(`[proof-gates] budget lookup failed (fail closed): ${(err as Error)?.message ?? err}`);
        return { ok: false, reason: 'proof_budget_unverifiable' };
      }
    },
  };
}

export function makeProofProtectionGate(deps?: ProofGateDeps): DispatchGate {
  return {
    name: PROOF_PROTECTION_GATE_NAME,
    async check(req: DispatchRequest): Promise<GateResult> {
      if (!isProofEnabled()) return { ok: true };
      try {
        const d = deps ?? (await realDeps());
        const run = await d.findRun({ requestKey: req.counterKey ?? null, sessionId: req.sessionId });
        // No run / terminal run: the budget gate (ahead of this one) owns the verdict.
        if (!run || !isActive(run)) return { ok: true };
        const res = await d.reassert(d.githubFor(run), frozenOf(run));
        if (res.ok) return { ok: true };
        // Digest equal but updated_at text differs = timestamptz round-trip format only
        // (the digest already covers every ruleset updated_at), not a real change.
        if (res.reason === 'proof_protection_drift' && res.detail === 'updated_at_changed') return { ok: true };
        return { ok: false, reason: res.reason };
      } catch (err) {
        console.error(`[proof-gates] protection re-assert failed (fail closed): ${(err as Error)?.message ?? err}`);
        return { ok: false, reason: 'proof_protection_unverifiable' };
      }
    },
  };
}

export const proofBudgetGate: DispatchGate = makeProofBudgetGate();
export const proofProtectionGate: DispatchGate = makeProofProtectionGate();
