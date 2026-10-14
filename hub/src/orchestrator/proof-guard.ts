// hub/src/orchestrator/proof-guard.ts
// PTYCAP-05 (D-04, D-07, D-11, D-12, D-13): the proof guard that macro-cycle calls
// (only when isProofEnabled()) before every inject.
//
// Contract (verdict F3): the guard returns the CLAIMED snapshot the prompt is
// rendered from (atomic armed->running, no second lookup); any lookup/render error
// or a proof-owned task with no active run means NO injection and NEVER the dev
// macro prompt. The guard FAILS CLOSED (opposite of macro-cycle's fail-open).
//
// finishProofRun is the ONLY place that ends a run: the conditional terminalize
// decides a single winner; only the winner disables the task, engages a SESSION
// kill switch, appends ONE run-log row and sends ONE notification.

import type {
  NothingReason,
  ProofCycleHooks,
  ProofGuardDecision,
  ProofGuardInput,
  ProofOutcome,
  ProofRun,
} from './proof-types.ts';
import { isProofEnabled, PROOF_SUCCESS_OUTCOME } from './proof-types.ts';
import { renderProofPrompt } from './proof-prompt.ts';
import type { NotifyInput } from './notify.ts';
import type { NewRoutineRunLogEntry } from '../db/orchestrator-rows-dal.ts';

// ── Evaluator seam (plan 05-06 registers the rest) ───────────────────────────

export type ProofEvaluatorVerdict =
  | { kind: 'continue' }
  | { kind: 'wait' }
  | { kind: 'terminal'; outcome: ProofOutcome; detail: string; prUrl?: string | null; prNumber?: number | null }
  | { kind: 'blocked'; reason: string };

export interface ProofEvaluatorCtx {
  run: ProofRun;
  input: ProofGuardInput;
  now: number;
}

export type ProofEvaluator = (ctx: ProofEvaluatorCtx) => Promise<ProofEvaluatorVerdict> | ProofEvaluatorVerdict;

const DECLINE_REASON_MAX = 200;

/** D-13: the agent's own `last_action: nothing - <reason>` ends the run as agent_declined. */
export const agentDeclinedEvaluator: ProofEvaluator = ({ input }) => {
  const last = input.sentinels?.state?.last_action;
  if (typeof last !== 'string') return { kind: 'continue' };
  const t = last.trim();
  if (!/^nothing\b/i.test(t)) return { kind: 'continue' };
  const reason = t.replace(/^nothing\b[\s:\-\u2013\u2014]*/i, '').trim().slice(0, DECLINE_REASON_MAX);
  return {
    kind: 'terminal',
    outcome: 'nothing:agent_declined',
    detail: reason || 'agent declined (no reason given)',
  };
};

// ── Deps ─────────────────────────────────────────────────────────────────────

export interface ProofGuardDeps {
  isEnabled: () => boolean;
  claimActiveRun: (taskId: string) => Promise<ProofRun | null>;
  taskHasAnyRun: (taskId: string) => Promise<boolean>;
  terminalize: (args: {
    runId: string;
    outcome: ProofOutcome;
    detail: string;
    prUrl?: string | null;
    prNumber?: number | null;
  }) => Promise<ProofRun | null>;
  /** Claim-threw path: terminalize whatever active run the task owns. */
  terminalizeByTask: (args: { taskId: string; outcome: ProofOutcome; detail: string }) => Promise<ProofRun | null>;
  disableTask: (userId: string, taskId: string) => Promise<void>;
  engageSessionKill: (args: { userId: string; sessionId: string; reason: string; engagedBy: string }) => Promise<unknown>;
  appendRunLog: (entry: NewRoutineRunLogEntry) => Promise<unknown>;
  fanOut: (input: NotifyInput) => Promise<unknown>;
  recordInjectOutcome: (runId: string, outcomeKind: string) => Promise<void>;
  evaluators: ProofEvaluator[];
  now: () => number;
}

// ── The single-winner terminalizer ───────────────────────────────────────────

function notifyFor(outcome: ProofOutcome, detail: string): Pick<NotifyInput, 'event' | 'level' | 'channels'> & { detail: string } {
  if (outcome === PROOF_SUCCESS_OUTCOME) {
    return { event: 'ship', level: 'blocking', channels: ['telegram', 'inapp', 'email', 'push'], detail: `proof succeeded: ${detail}` };
  }
  if (outcome.startsWith('terminated:')) {
    return { event: 'failure', level: 'blocking', channels: ['telegram', 'inapp', 'email', 'push'], detail: `proof ${outcome}: ${detail}` };
  }
  // nothing:* - a quiet end, no page storm (D-14).
  return { event: 'info', level: 'info', channels: ['inapp', 'email'], detail: `proof ${outcome}: ${detail}` };
}

async function bestEffort(label: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (err: any) {
    console.warn(`[orchestrator.proof] ${label} failed (ignored):`, err?.message ?? err);
  }
}

/** Ends a run exactly once. Returns the winning terminal row, or null when the claim was lost. */
export async function finishProofRun(
  deps: ProofGuardDeps,
  run: ProofRun | null,
  input: ProofGuardInput,
  outcome: ProofOutcome,
  detail: string,
  extra: { prUrl?: string | null; prNumber?: number | null } = {},
): Promise<ProofRun | null> {
  let won: ProofRun | null;
  if (run) {
    won = await deps.terminalize({ runId: run.id, outcome, detail, ...extra });
  } else {
    won = await deps.terminalizeByTask({ taskId: input.taskId, outcome, detail });
  }
  if (!won) return null; // lost the race / already terminal: do nothing further

  await bestEffort('disableTask', () => deps.disableTask(input.userId, input.taskId));
  await bestEffort('engageSessionKill', () =>
    deps.engageSessionKill({
      userId: input.userId,
      sessionId: input.sessionId,
      reason: `proof_terminal:${outcome}`,
      engagedBy: 'proof-guard',
    }),
  );
  await bestEffort('appendRunLog', () =>
    deps.appendRunLog({
      session_id: input.sessionId,
      repo_key: input.repoKey,
      command: 'proof-outcome',
      decision_rationale: `${outcome}: ${detail}`,
      outcome,
      pr_url: won.pr_url ?? extra.prUrl ?? null,
    }),
  );
  const n = notifyFor(outcome, detail);
  await bestEffort('fanOut', () =>
    deps.fanOut({ userId: input.userId, sessionId: input.sessionId, event: n.event, level: n.level, detail: n.detail, channels: n.channels }),
  );
  return won;
}

// ── The guard ────────────────────────────────────────────────────────────────

export async function proofGuard(deps: ProofGuardDeps, input: ProofGuardInput): Promise<ProofGuardDecision> {
  // Flag OFF -> pass_through BEFORE any dep call (true no-op).
  if (!deps.isEnabled()) return { kind: 'pass_through' };

  let run: ProofRun | null;
  try {
    run = await deps.claimActiveRun(input.taskId);
  } catch (err: any) {
    // Fail CLOSED: no snapshot, so end whatever active run the task owns by task id.
    const detail = `claim threw: ${err?.message ?? String(err)}`;
    try {
      await finishProofRun(deps, null, input, 'nothing:guard_error', detail);
    } catch (e: any) {
      console.error('[orchestrator.proof] guard_error terminalize failed:', e?.message ?? e);
      await bestEffort('disableTask', () => deps.disableTask(input.userId, input.taskId));
    }
    return { kind: 'blocked', reason: 'guard_error' };
  }

  if (!run) {
    let owns: boolean;
    try {
      owns = await deps.taskHasAnyRun(input.taskId);
    } catch {
      owns = true; // cannot tell: never fall through to the dev macro
    }
    if (!owns) return { kind: 'pass_through' };
    await bestEffort('disableTask', () => deps.disableTask(input.userId, input.taskId));
    return { kind: 'blocked', reason: 'proof_task_without_active_run' };
  }

  // Evaluate in order; the first non-continue verdict wins.
  try {
    for (const evaluate of deps.evaluators) {
      const v = await evaluate({ run, input, now: deps.now() });
      if (v.kind === 'continue') continue;
      if (v.kind === 'wait') return { kind: 'wait', run };
      if (v.kind === 'blocked') return { kind: 'blocked', reason: v.reason };
      const won = await finishProofRun(deps, run, input, v.outcome, v.detail, { prUrl: v.prUrl, prNumber: v.prNumber });
      return { kind: 'terminal', outcome: v.outcome, run: won ?? run, won: won != null };
    }
  } catch (err: any) {
    const reason: NothingReason = 'guard_error';
    const won = await finishProofRun(deps, run, input, `nothing:${reason}`, `evaluator threw: ${err?.message ?? String(err)}`);
    return { kind: 'terminal', outcome: `nothing:${reason}`, run: won ?? run, won: won != null };
  }
  return { kind: 'proceed', run };
}

// ── Hooks wiring ─────────────────────────────────────────────────────────────

/** Compose the macro-cycle hooks over a deps bundle (tests pass fakes; prod passes real adapters). */
export function makeProofHooks(deps: ProofGuardDeps): ProofCycleHooks {
  return {
    guard: (input) => proofGuard(deps, input),
    render: renderProofPrompt,
    observeInject: async (run, outcomeKind) => {
      try {
        await deps.recordInjectOutcome(run.id, outcomeKind);
      } catch (err: any) {
        console.warn('[orchestrator.proof] observeInject failed (ignored):', err?.message ?? err);
      }
    },
    abort: async (run, reason, detail, input) => {
      try {
        await finishProofRun(deps, run, input, `nothing:${reason}`, detail);
      } catch (err: any) {
        console.error('[orchestrator.proof] abort failed:', err?.message ?? err);
      }
    },
  };
}

/** The real adapters. Dynamic imports so nothing heavy loads unless the flag stack is ON. */
export async function realProofHooks(): Promise<ProofCycleHooks> {
  const dal = await import('../db/orchestrator-proof-dal.ts');
  const controls = await import('../dispatch/automation-controls.ts');
  const { appendRunLog } = await import('./run-log.ts');
  const { fanOutNotify } = await import('./notify.ts');
  return makeProofHooks({
    isEnabled: isProofEnabled,
    claimActiveRun: dal.claimActiveProofRunForTask,
    taskHasAnyRun: dal.taskHasAnyProofRun,
    terminalize: dal.terminalizeProofRun,
    terminalizeByTask: dal.terminalizeActiveProofRunForTask,
    disableTask: dal.disableProofTask,
    engageSessionKill: (a) => controls.engageKillSwitch({ scope: 'session', ...a }),
    appendRunLog,
    fanOut: fanOutNotify,
    recordInjectOutcome: async (runId, kind) => {
      await dal.recordProofObservation(runId, { last_inject_outcome: kind });
    },
    evaluators: [agentDeclinedEvaluator],
    now: Date.now,
  });
}
