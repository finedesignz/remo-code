// hub/src/orchestrator/controller.ts
// Phase 23 (auto-dev-orchestrator) — the per-tick controller DECISION CORE.
// Decisions D1 (controller arbitrates, runs ALL due rows) and D4 (run log fed
// into the controller's runtime context each tick).
//
// Reqs:
//   R-ADO-08 — status-check/decide + run-log read each tick (implicit rows).
//   R-ADO-09 — compute + run ALL due rows.
//   R-ADO-10 — assemble the SPEC §4 controller prompt with run-log + project
//              state + due-rows injected, and parse the agent's structured
//              decision/outcome back into routine_run_log writes (one per
//              command), mirroring the existing parseControllerDecision.
//
// SCOPE NOTE (Phase 23 = decision core ONLY): this module computes the decision,
// renders the prompt, and writes a run-log entry. It does NOT dispatch the
// per-command waves — `runWaves()` is a clearly-marked Phase-24 SEAM (no-op).
// The gsd-command injection seam is Phase 25. The live cycle-runner is gated
// behind REMO_ORCHESTRATOR_ENABLED (default OFF) so prod stays dormant on the
// e2e-unproven queue (carried Phase-22 gate, decision D10).

import {
  buildRuntimeContext,
  renderRuntimeContextBlock,
  type RuntimeContext,
} from '../scheduler/context/runtime-context.ts';
import { humanizeRule } from '../scheduler/schedule-rules.ts';
import { computeDueRowsForTask, type DueRow } from './due-rows.ts';
import { appendRunLog, recentRunLog, type RoutineRunLogEntry } from './run-log.ts';
import { setCycleRunner, type CycleRunner } from './queue.ts';
import type { LifecycleStage } from '../db/orchestrator-rows-dal.ts';

// ── Live-path gate (carried Phase-22 gate; decision D10) ─────────────────────
/**
 * REMO_ORCHESTRATOR_ENABLED gates the LIVE controller path. Default OFF ('0').
 * When OFF, registerCycleRunnerIfEnabled() does NOT call setCycleRunner(), so
 * the Phase-22 drain worker claims nothing and prod stays fully dormant.
 */
export function isOrchestratorEnabled(): boolean {
  const raw = (process.env.REMO_ORCHESTRATOR_ENABLED ?? '0').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

// ── Tick context assembly (R-ADO-08) ─────────────────────────────────────────

export interface ControllerContext {
  repo: string;
  stage: LifecycleStage;
  runtimeContext: RuntimeContext;
  runLog: RoutineRunLogEntry[];
  dueRows: DueRow[];
}

/**
 * Assemble the per-tick controller context: project state (via the existing
 * buildRuntimeContext — open roadmap phases / commits / PRs / deploy status are
 * best-effort hub-side fields), the last N run-log entries, and the DUE rows.
 * Best-effort: DB failures degrade to empty rather than throwing (a tick should
 * still render a safe prompt).
 */
export async function buildControllerContext(input: {
  userId: string;
  sessionId: string;
  taskId: string;
  stage?: LifecycleStage;
  repo?: string;
  now?: Date;
  tz?: string;
  runLogLimit?: number;
}): Promise<ControllerContext> {
  const stage: LifecycleStage = input.stage ?? 'development';

  let runtimeContext: RuntimeContext = {};
  try {
    runtimeContext = await buildRuntimeContext({
      userId: input.userId,
      sessionId: input.sessionId,
      taskKind: 'orchestrator',
      taskId: input.taskId,
    });
  } catch {
    /* degrade to empty context */
  }

  let runLog: RoutineRunLogEntry[] = [];
  try {
    runLog = await recentRunLog(input.sessionId, input.runLogLimit ?? 20);
  } catch {
    /* degrade to empty run log */
  }

  let dueRows: DueRow[] = [];
  try {
    dueRows = await computeDueRowsForTask(input.taskId, {
      sessionId: input.sessionId,
      now: input.now,
      tz: input.tz,
    });
  } catch {
    /* degrade to no due rows */
  }

  const repo = input.repo ?? runtimeContext.repo ?? 'this repo';

  return { repo, stage, runtimeContext, runLog, dueRows };
}

// ── Prompt render (SPEC §4 skeleton; R-ADO-10) ───────────────────────────────

function renderDueRows(dueRows: DueRow[]): string {
  if (dueRows.length === 0) return '(none this tick — run only the implicit status-check + deploy-verify)';
  return dueRows
    .map((d) => {
      const r = d.row;
      const cadence = r.schedule_rule ? humanizeRule(r.schedule_rule) : (r.frequency_label ?? 'on-demand');
      const once = d.autoDisableAfter ? ' [ONCE — auto-disables after this run]' : '';
      const micro = r.micro_prompt ? ` — micro-prompt: ${r.micro_prompt}` : '';
      return `- ${r.command} (${cadence})${once}${micro}`;
    })
    .join('\n');
}

function renderRunLog(runLog: RoutineRunLogEntry[]): string {
  if (runLog.length === 0) return '(empty — no prior runs recorded)';
  return runLog
    .map((e) => {
      const parts = [
        e.created_at,
        e.command,
        e.outcome ? `outcome=${e.outcome}` : null,
        e.pr_url ? `pr=${e.pr_url}` : null,
        e.reviewer_verdict ? `review=${e.reviewer_verdict}` : null,
        e.gap_dimension ? `gap=${e.gap_dimension}` : null,
        e.deploy_verify_result ? `deploy=${e.deploy_verify_result}` : null,
      ].filter(Boolean);
      return `- ${parts.join(' · ')}`;
    })
    .join('\n');
}

/**
 * Render the standard controller prompt (SPEC §4) with repo / stage / due_rows /
 * run_log / project-state substituted. Always-on implicit rows are stated:
 * `status-check/decide` FIRST and `deploy+log-verify` TERMINAL.
 */
export function renderControllerPrompt(ctx: ControllerContext): string {
  const projectState = renderRuntimeContextBlock(ctx.runtimeContext);
  return [
    `You are the auto-dev orchestrator for **${ctx.repo}** (lifecycle stage: **${ctx.stage}**).`,
    '',
    'FIRST run the implicit `status-check/decide` step: read the RUN LOG below (last N entries)',
    'and the current project state (open roadmap phases, last commits, open PRs, deploy status),',
    'then decide what to do this tick.',
    '',
    '## PROJECT STATE',
    projectState,
    '',
    '## RUN LOG (newest first)',
    renderRunLog(ctx.runLog),
    '',
    '## DUE COMMAND ROWS (this tick)',
    renderDueRows(ctx.dueRows),
    '',
    'Plan a **dependency-aware wave schedule**: run independent commands as parallel Task',
    'subagents; sequence dependent ones (plan→execute→ship). For each command, run the',
    'corresponding gsd skill. Every unit of work MUST finish, create a PR, and dispatch a',
    'reviewer subagent to verify the PR. Do NOT merge to main here (that is the off-hours',
    'command). For ship/complete-milestone/tag, PROPOSE to chat and stop that branch.',
    '',
    'FINALLY, ALWAYS run the implicit `deploy+log-verify` terminal step: redeploy, probe real',
    'routes, scan Coolify logs for errors; if broken, dispatch a fix agent and re-verify up to',
    '3×, then surface.',
    '',
    'Append a RUN LOG entry per command. Emit ONE block per command in the form:',
    '<<RUNLOG',
    'command: <command>',
    'outcome: <success|failed|skipped|...>',
    'pr_url: <url or empty>',
    'reviewer_verdict: <PASS|FAIL|... or empty>',
    'gap_dimension: <dimension or empty>',
    'deploy_verify_result: <ok|broken|... or empty>',
    'RUNLOG',
    '',
    'Then emit a single top-level decision block:',
    '<<DECISION',
    'action: <bootstrap|continue|ship|plan|propose>',
    'reason: <short rationale>',
    'next_goal: <what to do next>',
    'roadmap: <roadmap item or empty>',
    'DECISION',
    '',
    'Respect the daily cost cap and chain-depth — they are non-bypassable.',
  ].join('\n');
}

// ── Decision + per-command run-log parsing (R-ADO-10) ────────────────────────
// Mirrors hub/src/scheduler/controller-schema.ts parseControllerDecision: a
// missing/unparseable structure falls back to a SAFE no-op (action `continue`,
// zero run-log entries) so a malformed agent turn never stalls or writes junk.

export type ControllerAction = 'bootstrap' | 'continue' | 'ship' | 'plan' | 'propose';
const ACTIONS: ReadonlySet<string> = new Set(['bootstrap', 'continue', 'ship', 'plan', 'propose']);

export interface ParsedRunLogBlock {
  command: string;
  outcome: string | null;
  pr_url: string | null;
  reviewer_verdict: string | null;
  gap_dimension: string | null;
  deploy_verify_result: string | null;
}

export interface ControllerDecision {
  action: ControllerAction;
  reason: string;
  next_goal: string;
  roadmap: string | null;
}

export interface ParsedController {
  decision: ControllerDecision;
  runLogBlocks: ParsedRunLogBlock[];
}

const DECISION_RE = /<<DECISION\b([\s\S]*?)(?:^|\n)\s*DECISION(?:>>)?(?:\s|$)/i;
const RUNLOG_RE = /<<RUNLOG\b([\s\S]*?)(?:^|\n)\s*RUNLOG(?:>>)?(?:\s|$)/gi;

const SAFE_FALLBACK: ControllerDecision = {
  action: 'continue',
  reason: 'controller_decision_unparseable_fallback',
  next_goal: 'Continue where you left off.',
  roadmap: null,
};

/** Parse `key: value` lines from a block body into a lower-cased field map. */
function parseFields(body: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const line of body.split('\n')) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const val = line.slice(idx + 1).trim();
    if (key) fields[key] = val;
  }
  return fields;
}

function emptyToNull(v: string | undefined): string | null {
  const t = (v ?? '').trim();
  return t.length > 0 ? t : null;
}

/**
 * Parse the controller's reply: zero-or-more `<<RUNLOG ... RUNLOG>>` per-command
 * blocks + one top-level `<<DECISION ... DECISION>>` block. Returns
 * `{ ok:true, value }` on a recognized decision block, else `{ ok:false, reason,
 * fallback }` carrying the SAFE no-op (continue, zero run-log entries). A RUNLOG
 * block missing `command` is dropped (can't key a run-log row without it).
 */
export function parseControllerDecisions(
  raw: string,
):
  | { ok: true; value: ParsedController }
  | { ok: false; reason: string; fallback: ParsedController } {
  const text = raw ?? '';

  const runLogBlocks: ParsedRunLogBlock[] = [];
  for (const m of text.matchAll(RUNLOG_RE)) {
    const f = parseFields(m[1] ?? '');
    const command = (f.command ?? '').trim();
    if (!command) continue; // a run-log row must have a command key
    runLogBlocks.push({
      command,
      outcome: emptyToNull(f.outcome),
      pr_url: emptyToNull(f.pr_url),
      reviewer_verdict: emptyToNull(f.reviewer_verdict),
      gap_dimension: emptyToNull(f.gap_dimension),
      deploy_verify_result: emptyToNull(f.deploy_verify_result),
    });
  }

  const dm = text.match(DECISION_RE);
  if (!dm) {
    return {
      ok: false,
      reason: 'no_decision_block',
      // Fallback carries the safe decision but still surfaces any parsed run-log
      // blocks — they are independently valid and worth persisting.
      fallback: { decision: SAFE_FALLBACK, runLogBlocks },
    };
  }

  const f = parseFields(dm[1] ?? '');
  const actionRaw = (f.action ?? '').toLowerCase();
  if (!ACTIONS.has(actionRaw)) {
    return {
      ok: false,
      reason: `invalid_action:${actionRaw || '(empty)'}`,
      fallback: { decision: SAFE_FALLBACK, runLogBlocks },
    };
  }

  return {
    ok: true,
    value: {
      decision: {
        action: actionRaw as ControllerAction,
        reason: f.reason ?? '',
        next_goal: f.next_goal ?? '',
        roadmap: emptyToNull(f.roadmap),
      },
      runLogBlocks,
    },
  };
}

/**
 * Persist one routine_run_log row per parsed RUNLOG block. Best-effort; returns
 * the count written. Called by the cycle-runner after the agent turn settles.
 */
export async function writeRunLogFromBlocks(
  sessionId: string,
  repoKey: string | null,
  decisionReason: string | null,
  blocks: ParsedRunLogBlock[],
): Promise<number> {
  let written = 0;
  for (const b of blocks) {
    try {
      await appendRunLog({
        session_id: sessionId,
        repo_key: repoKey,
        command: b.command,
        decision_rationale: decisionReason,
        outcome: b.outcome,
        gap_dimension: b.gap_dimension,
        pr_url: b.pr_url,
        reviewer_verdict: b.reviewer_verdict,
        deploy_verify_result: b.deploy_verify_result,
      });
      written++;
    } catch (err: any) {
      console.warn(`[orchestrator] run-log append failed command=${b.command}: ${err?.message}`);
    }
  }
  return written;
}

// ── Phase-24 SEAM (NOT IMPLEMENTED HERE) ─────────────────────────────────────
/**
 * Dispatch the dependency-aware command waves for a parsed decision.
 *
 * **Phase-24 SEAM — intentionally a no-op in Phase 23.** Phase 23 is the
 * decision core only: it computes the decision, renders the prompt, and writes
 * the run log. Actual wave fan-out / per-command gsd-skill injection land in
 * Phases 24 (waves) and 25 (command seam).
 */
export async function runWaves(_decision: ParsedController): Promise<void> {
  console.log('[orchestrator] runWaves: deferred to Phase 24 (no-op in Phase 23)');
}

// ── Cycle-runner factory + flag-gated registration (D10) ─────────────────────
/**
 * Build the CycleRunner injected into the Phase-22 queue. Per claimed cycle it
 * would: build context → render prompt → (Phase 24/25) inject the turn → parse
 * the reply → write run-log. In Phase 23 the dispatch step is the no-op seam, so
 * this runner only exercises the decision-core path. The queue owns claim/release.
 *
 * NOTE: a full runner needs the firing session's identity (userId/taskId/stage),
 * which the queue entry alone does not carry. Resolving session→task→user is a
 * Phase-24 wiring concern; here the runner is a minimal placeholder that proves
 * the registration seam works and logs that execution is deferred.
 */
export function makeCycleRunner(): CycleRunner {
  return async (entry) => {
    console.log(
      `[orchestrator] cycle claimed session=${entry.session_id} — decision-core only ` +
        `(wave dispatch deferred to Phase 24)`,
    );
    await runWaves({ decision: SAFE_FALLBACK, runLogBlocks: [] });
  };
}

/**
 * Register the cycle-runner with the queue IFF REMO_ORCHESTRATOR_ENABLED is ON.
 * This is the ONLY call site of setCycleRunner in normal boot. With the flag OFF
 * (default), the queue worker stays dormant (claims nothing). Returns whether a
 * runner was registered.
 */
export function registerCycleRunnerIfEnabled(): boolean {
  if (!isOrchestratorEnabled()) {
    console.log(
      '[orchestrator] REMO_ORCHESTRATOR_ENABLED is OFF — cycle-runner NOT registered ' +
        '(queue dormant). Set REMO_ORCHESTRATOR_ENABLED=1 to enable the live path.',
    );
    return false;
  }
  setCycleRunner(makeCycleRunner());
  console.log('[orchestrator] cycle-runner registered (REMO_ORCHESTRATOR_ENABLED=ON).');
  return true;
}
