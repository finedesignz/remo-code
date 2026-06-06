// hub/src/orchestrator/wave-runner.ts
// Phase 24 (auto-dev-orchestrator) — execute a WavePlan with the per-unit
// finish→PR→reviewer protocol. Waves run SEQUENTIALLY; units within a wave run
// "in parallel" (Promise.allSettled). The REAL parallelism lives inside the bound
// session's agent turn (locked decision D6) — here we MODEL it: each unit invokes
// the Phase-25 `executeCommand` seam, which (later) injects the templated prompt
// and lets the agent spawn its own Task subagents. The hub does NOT itself fan out.
//
// Reqs:
//   R-ADO-12 — parallelism lives inside the agent turn; hub models it as
//              Promise.allSettled over the executeCommand seam (no hub-side fan-out).
//   R-ADO-13 — each unit MUST finish → create a PR → dispatch a reviewer; the
//              reviewer verdict is captured to routine_run_log. Units NEVER merge
//              to main (off-hours Phase-29 owns that).
//
// SEAMS filled by later phases (all stubbed here so prod stays inert):
//   executeCommand   → Phase 25 (templated prompt injection / gsd-skill invocation).
//   createPrForUnit  → Phase 25 mechanics (shell `gh pr create` later).
//   dispatchReviewer → reviewer dispatch (verdict capture).
//   proposeToChat    → Phase 28 (reuse P3 surfaceProposal for ship/milestone/tag).
//
// Isolation discipline mirrors the Phase-22 queue's release-on-throw: a unit that
// throws is caught, logged as outcome='failed', and does NOT wedge its wave or
// abort later waves.

import { appendRunLog } from './run-log.ts';
import type { WavePlan, WaveUnit } from './waves.ts';

// ── Execution context (minimal; what a run needs to log + later inject) ──────
export interface WaveRunContext {
  sessionId: string;
  repoKey: string | null;
  /** Decision rationale to stamp on each run-log row (D4). */
  decisionRationale?: string | null;
}

// ── Seam result types ────────────────────────────────────────────────────────
export interface ExecuteResult {
  /** success | failed | skipped | … — free text, persisted to run-log.outcome. */
  outcome: string;
  /** Optional gap dimension (gap-scan rotation, Phase 26) — logged if present. */
  gapDimension?: string | null;
}

export type ReviewerVerdict = 'PASS' | 'FAIL' | 'UNCERTAIN' | string;

// ── Injectable seams (default stubs = Phase-25/28 NOT wired ⇒ inert in prod) ─
export interface WaveSeams {
  /** Phase-25: inject the templated prompt → agent runs the gsd skill. */
  executeCommand(unit: WaveUnit, ctx: WaveRunContext): Promise<ExecuteResult>;
  /** Phase-25 mechanics: open a PR for the finished unit; returns its URL (or null). */
  createPrForUnit(unit: WaveUnit, ctx: WaveRunContext): Promise<string | null>;
  /** Dispatch a reviewer subagent to verify the PR; returns its verdict (or null). */
  dispatchReviewer(prUrl: string | null, unit: WaveUnit, ctx: WaveRunContext): Promise<ReviewerVerdict | null>;
  /** Phase-28: surface a propose-to-chat for high-tier (ship/milestone/tag) units. */
  proposeToChat(unit: WaveUnit, ctx: WaveRunContext): Promise<void>;
}

/**
 * Phase-24 DEFAULT SEAMS — intentionally inert. They DO NOT touch the network,
 * `gh`, git, or chat. With these defaults (and the orchestrator flag OFF) a live
 * tick would log placeholder rows only. Phases 25/28 replace them with the real
 * prompt-injection / PR / reviewer / surfaceProposal mechanics.
 */
export const STUB_SEAMS: WaveSeams = {
  async executeCommand(unit) {
    console.log(`[orchestrator] executeCommand STUB (Phase 25) command=${unit.command}`);
    return { outcome: 'skipped_phase25_stub' };
  },
  async createPrForUnit(unit) {
    console.log(`[orchestrator] createPrForUnit STUB (Phase 25) command=${unit.command}`);
    return null;
  },
  async dispatchReviewer() {
    console.log('[orchestrator] dispatchReviewer STUB');
    return null;
  },
  async proposeToChat(unit) {
    console.log(`[orchestrator] proposeToChat STUB (Phase 28) command=${unit.command}`);
  },
};

// ── Per-unit lifecycle outcome (returned for the wave summary) ───────────────
export interface UnitRunResult {
  command: string;
  proposed: boolean;
  outcome: string;
  prUrl: string | null;
  reviewerVerdict: ReviewerVerdict | null;
}

export interface WaveRunSummary {
  units: number;
  succeeded: number;
  failed: number;
  proposed: number;
  results: UnitRunResult[];
}

/**
 * Run ONE unit's lifecycle. Two paths:
 *   - propose unit (ship/complete-milestone/tag): proposeToChat → log outcome
 *     'proposed' (no execute, no PR, no merge). Phase-28 tier (D5).
 *   - normal unit: executeCommand (finish) → createPrForUnit (PR) → dispatchReviewer
 *     (verdict). The ORDER finish→PR→reviewer is the R-ADO-13 contract.
 * ALWAYS writes exactly one routine_run_log row. NEVER throws to the caller — a
 * seam throw is caught and recorded as outcome='failed' (per-unit isolation).
 */
async function runUnit(unit: WaveUnit, ctx: WaveRunContext, seams: WaveSeams): Promise<UnitRunResult> {
  let outcome = 'failed';
  let prUrl: string | null = null;
  let reviewerVerdict: ReviewerVerdict | null = null;
  let gapDimension: string | null = null;
  const proposed = unit.propose;

  try {
    if (proposed) {
      // High-tier: PROPOSE, don't execute / PR / merge.
      await seams.proposeToChat(unit, ctx);
      outcome = 'proposed';
    } else {
      // (a) finish
      const exec = await seams.executeCommand(unit, ctx);
      outcome = exec.outcome;
      gapDimension = exec.gapDimension ?? null;
      // (b) create PR (still attempted even on a non-success exec outcome so the
      //     run log carries whatever PR the agent opened; reviewer follows).
      prUrl = await seams.createPrForUnit(unit, ctx);
      // (c) dispatch reviewer to verify the PR
      reviewerVerdict = await seams.dispatchReviewer(prUrl, unit, ctx);
    }
  } catch (err: any) {
    outcome = 'failed';
    console.warn(`[orchestrator] unit failed command=${unit.command}: ${err?.message ?? err}`);
  }

  // (d) ALWAYS write one run-log row (best-effort; a log failure is swallowed so
  //     it can't wedge the wave). Mirrors writeRunLogFromBlocks discipline.
  try {
    await appendRunLog({
      session_id: ctx.sessionId,
      repo_key: ctx.repoKey,
      command: unit.command,
      decision_rationale: ctx.decisionRationale ?? null,
      outcome,
      gap_dimension: gapDimension,
      pr_url: prUrl,
      reviewer_verdict: reviewerVerdict,
      deploy_verify_result: null, // deploy/log-verify tail is Phase 27
    });
  } catch (err: any) {
    console.warn(`[orchestrator] run-log append failed command=${unit.command}: ${err?.message ?? err}`);
  }

  return { command: unit.command, proposed, outcome, prUrl, reviewerVerdict };
}

/**
 * Execute a WavePlan: waves SEQUENTIAL, units within a wave PARALLEL
 * (Promise.allSettled — a thrown unit can't reject the wave). A unit failure is
 * isolated (logged 'failed') and does NOT abort later waves. Returns a summary.
 *
 * `seams` defaults to STUB_SEAMS, so calling this in prod with the orchestrator
 * flag OFF is inert (the runner is only ever invoked from the flag-gated
 * cycle-runner). Tests inject spy seams to assert the lifecycle order.
 */
export async function runWavePlan(
  plan: WavePlan,
  ctx: WaveRunContext,
  seams: WaveSeams = STUB_SEAMS,
): Promise<WaveRunSummary> {
  const results: UnitRunResult[] = [];

  for (const wave of plan.waves) {
    const settled = await Promise.allSettled(wave.map((unit) => runUnit(unit, ctx, seams)));
    for (const s of settled) {
      // runUnit never rejects, but be defensive: a rejected settle counts failed.
      if (s.status === 'fulfilled') {
        results.push(s.value);
      } else {
        results.push({ command: '(unknown)', proposed: false, outcome: 'failed', prUrl: null, reviewerVerdict: null });
      }
    }
  }

  const proposed = results.filter((r) => r.proposed).length;
  const succeeded = results.filter((r) => !r.proposed && r.outcome !== 'failed').length;
  const failed = results.filter((r) => r.outcome === 'failed').length;

  return { units: results.length, succeeded, failed, proposed, results };
}
