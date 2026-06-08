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
import { setCycleRunner, enqueueCycle, CyclePriority, type CycleRunner } from './queue.ts';
import { planWaves } from './waves.ts';
import { runWavePlan, STUB_SEAMS, makeLiveSeams, type WaveRunContext, type WaveRunSummary, type WaveSeams } from './wave-runner.ts';
import { runVerifyTail } from './verify-tail.ts';
import { MERGE_COMMAND, isMergeCommand, runMergeToMain, type MergeOutcome } from './merge-command.ts';
import { getSessionById } from '../db/dal.ts';
import {
  getOrchestratorTaskForSession,
  type LifecycleStage,
  type MacroTaskType,
} from '../db/orchestrator-rows-dal.ts';
import { runMacroCycle } from './macro-cycle.ts';

// Milestone TMAC: route an orchestrator cycle through the resume-heartbeat MACRO
// path (task_type → one autonomous macro prompt) instead of the legacy per-micro-
// command-row wave engine. Default ON (every task carries a macro_task_type,
// defaulting to 'dev'). The env escape hatch re-enables the legacy wave path for
// a controlled migration rollback only.
export function useMacroPath(): boolean {
  const raw = (process.env.REMO_ORCHESTRATOR_LEGACY_WAVES ?? '0').trim().toLowerCase();
  const legacy = raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
  return !legacy;
}

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

// ── Phase-24 wave dispatch (planner + runner wired) ──────────────────────────
/**
 * Dispatch the dependency-aware command waves for a parsed controller reply.
 *
 * Phase 24: the command set is taken from the controller's per-command RUNLOG
 * blocks (the agent emits one block per command it intends to run this tick).
 * Those commands are grouped into dependency waves (`planWaves`) and run with
 * the per-unit finish→PR→reviewer→run-log protocol (`runWavePlan`).
 *
 * The execute / PR / reviewer / propose mechanics are SEAMS:
 *   - executeCommand / createPrForUnit → Phase 25 (templated prompt injection).
 *   - dispatchReviewer                 → reviewer dispatch.
 *   - proposeToChat (ship/milestone/tag) → Phase 28 (surfaceProposal).
 * They default to `STUB_SEAMS` (inert: no gh / network / merge), so even on a
 * live (flag-ON) tick this only writes placeholder run-log rows until Phases
 * 25/28 fill the seams. merge-to-main is EXCLUDED (off-hours Phase 29).
 *
 * `seams` is injectable for tests; defaults to the inert stubs in prod.
 */
export async function runWaves(
  parsed: ParsedController,
  ctx: WaveRunContext,
  seams: WaveSeams = STUB_SEAMS,
): Promise<WaveRunSummary> {
  const commands = parsed.runLogBlocks.map((b) => b.command);
  const plan = planWaves(commands);
  return runWavePlan(plan, ctx, seams);
}

/**
 * Phase 32 — the LIVE driver: plan + run waves directly from the tick's DUE ROWS.
 *
 * This closes the Phase-25 controller→wave deferral. Instead of waiting for the
 * agent to emit RUNLOG blocks (parsed next tick), the hub takes the DUE command
 * rows as the authoritative command set for THIS tick: `planWaves` groups them
 * into dependency waves, and each unit's `micro_prompt` (free-text custom rows)
 * is carried onto the matching `WaveUnit.microPrompt` so the execution seam wraps
 * it in the finish→PR→reviewer envelope. `runWavePlan` then injects each unit's
 * templated prompt through the cost-capped dispatch pipeline (makeLiveSeams).
 *
 * merge-to-main is EXCLUDED by `planWaves` (off-hours special path — see
 * `dispatchMergeIfDue`). Returns the wave summary (empty when no rows are due).
 */
export async function runWavesFromDueRows(
  dueRows: DueRow[],
  ctx: WaveRunContext,
  seams: WaveSeams = STUB_SEAMS,
): Promise<WaveRunSummary> {
  const commands = dueRows.map((d) => d.row.command);
  const plan = planWaves(commands);
  // Carry each due row's micro_prompt onto its planned unit (first match by
  // command — rows are de-duped by planWaves, so one micro_prompt per command).
  const microByCommand = new Map<string, string | null>();
  for (const d of dueRows) {
    if (!microByCommand.has(d.row.command)) {
      microByCommand.set(d.row.command, d.row.micro_prompt ?? null);
    }
  }
  for (const wave of plan.waves) {
    for (const unit of wave) {
      const micro = microByCommand.get(unit.command);
      if (micro != null) unit.microPrompt = micro;
    }
  }
  return runWavePlan(plan, ctx, seams);
}

// ── Phase-29 off-hours merge-to-main (SPECIAL PATH — NOT the wave planner) ────
/**
 * Route a due `merge-to-main` row to the dedicated off-hours merge command.
 *
 * `merge-to-main` is EXCLUDED from `planWaves` (waves.ts EXCLUDED_COMMANDS) and is
 * the ONLY auto-merge-to-main path (R-ADO-24). This is the controller's seam that
 * carries the row's `schedule_rule` (off-hours active_window) into
 * `runMergeToMain`, which window-gates + selects PASS+approved PRs and injects the
 * agent merge turn (hub stays text-only). If no merge row is due, this is a no-op.
 *
 * Returns the merge outcome (tests assert on it) or null when no merge row is due.
 */
export async function dispatchMergeIfDue(
  dueRows: DueRow[],
  ctx: { sessionId: string; userId: string | null; repoKey: string | null; tz?: string },
): Promise<MergeOutcome | null> {
  const mergeDue = dueRows.find((d) => isMergeCommand(d.row.command));
  if (!mergeDue) return null;
  return runMergeToMain({
    sessionId: ctx.sessionId,
    userId: ctx.userId,
    repoKey: ctx.repoKey,
    scheduleRule: mergeDue.row.schedule_rule,
    tz: ctx.tz,
  });
}

// ── Session→task→user resolution (Phase 32 — closes the Phase-25 deferral) ────
/**
 * The resolved identity + context a claimed cycle needs to drive the waves. The
 * queue entry alone carries only `session_id`; this fans it out to the owning
 * user, the one orchestrator task, the lifecycle stage, the repo key, and the
 * tick's DUE rows + run-log + project-state context.
 */
export interface ResolvedCycleContext {
  sessionId: string;
  userId: string;
  taskId: string;
  repoKey: string | null;
  tz: string;
  controllerContext: ControllerContext;
  // Milestone TMAC: the macro task_type + repo path/ident drive the resume-
  // heartbeat macro path (REPLACES the wave path for these tasks).
  macroTaskType: MacroTaskType;
  repoPath: string;
  repoIdent: string;
}

/**
 * Resolve a queue entry's `session_id` → owning user + orchestrator task + stage,
 * then build the controller context (project state + run-log + DUE rows). Returns
 * `null` when the session is gone or has no orchestrator task (a stale/foreign
 * queue entry) — the caller treats that as a clean no-op (release 'done').
 *
 * `deps` is injectable for tests (mock the two DB reads + the context builder).
 */
export interface ResolveDeps {
  getSessionById: typeof getSessionById;
  getOrchestratorTaskForSession: typeof getOrchestratorTaskForSession;
  buildControllerContext: typeof buildControllerContext;
}
const REAL_RESOLVE_DEPS: ResolveDeps = {
  getSessionById,
  getOrchestratorTaskForSession,
  buildControllerContext,
};

export async function resolveCycleContext(
  sessionId: string,
  deps: ResolveDeps = REAL_RESOLVE_DEPS,
): Promise<ResolvedCycleContext | null> {
  const session = await deps.getSessionById(sessionId);
  if (!session) return null;
  const userId: string | null = (session as any).user_id ?? null;
  if (!userId) return null;

  const task = await deps.getOrchestratorTaskForSession(userId, sessionId);
  if (!task) return null;

  const repoKey: string | null = (session as any).repo_key ?? null;
  const projectDir: string | null = (session as any).project_dir ?? null;
  const tz: string = (task as any).timezone ?? 'UTC';
  const stage: LifecycleStage = task.lifecycle_stage ?? 'development';
  const macroTaskType: MacroTaskType = task.macro_task_type ?? 'dev';
  const repoPath = projectDir ?? repoKey ?? 'this repo';
  const repoIdent = repoKey ?? projectDir ?? 'this repo';

  const controllerContext = await deps.buildControllerContext({
    userId,
    sessionId,
    taskId: task.id,
    stage,
    repo: repoKey ?? undefined,
    tz,
  });

  return {
    sessionId,
    userId,
    taskId: task.id,
    repoKey,
    tz,
    controllerContext,
    macroTaskType,
    repoPath,
    repoIdent,
  };
}

// ── Cycle-runner factory + flag-gated registration (D10) ─────────────────────
/**
 * Build the CycleRunner injected into the Phase-22 queue. Per claimed cycle:
 *   1. resolve session→user→task→stage + build the controller context (DUE rows,
 *      run-log, project state) via `resolveCycleContext`;
 *   2. render the controller prompt → use it as the run-log decision_rationale
 *      (the prompt is context; the DUE ROWS are the authoritative command set);
 *   3. drive the dependency-aware waves directly from the DUE rows
 *      (`runWavesFromDueRows`) — each unit injects its templated prompt through
 *      the cost-capped dispatch pipeline (makeLiveSeams). The gsd work + PR +
 *      reviewer run ASYNC inside the agent turn; pr_url/verdict reconcile on a
 *      later tick when buildControllerContext re-reads routine_run_log;
 *   4. route a due off-hours `merge-to-main` row through `dispatchMergeIfDue`;
 *   5. always run the mandatory terminal verify tail (Phase 27).
 *
 * The queue owns claim/release; every step is best-effort (a throw is logged, not
 * propagated, so one bad step never wedges the tick). `runWaves`/`runWavePlan`
 * still DEFAULT to STUB_SEAMS, so only this flag-gated runner opts into the live
 * seams — non-live callers + tests stay inert.
 *
 * `resolveDeps` is injectable for tests; `seams` defaults to the live seams.
 */
export function makeCycleRunner(
  resolveDeps: ResolveDeps = REAL_RESOLVE_DEPS,
  seams: WaveSeams = makeLiveSeams(),
): CycleRunner {
  return async (entry) => {
    const resolved = await resolveCycleContext(entry.session_id, resolveDeps);
    if (!resolved) {
      console.log(
        `[orchestrator] cycle claimed session=${entry.session_id} — no orchestrator task ` +
          `(stale/foreign queue entry); no-op.`,
      );
      return;
    }

    const { sessionId, userId, repoKey, tz, controllerContext } = resolved;
    const dueRows = controllerContext.dueRows;

    // ── Milestone TMAC: resume-heartbeat MACRO path (REPLACES the wave path) ──
    // Resolve macro_task_type → one autonomous macro prompt, reconcile the prior
    // turn's sentinels, halt on an open mandatory gate, else (re)inject to resume.
    // The macro prompt itself owns release + deploy-verify (SPEC §4 STEP 4), so we
    // do NOT run the legacy merge/verify-tail seams on this path.
    if (useMacroPath()) {
      try {
        await runMacroCycle({
          userId,
          sessionId,
          taskId: resolved.taskId,
          macroTaskType: resolved.macroTaskType,
          stage: controllerContext.stage,
          repoPath: resolved.repoPath,
          repoIdent: resolved.repoIdent,
          repoKey,
        });
      } catch (err: any) {
        console.warn(`[orchestrator] macro cycle threw (ignored): ${err?.message ?? err}`);
      }
      return;
    }

    // ── Legacy wave path (rollback only, REMO_ORCHESTRATOR_LEGACY_WAVES=1) ────
    // The controller prompt is the tick's decision context; it is stamped as the
    // run-log decision_rationale (truncated). The DUE ROWS are the command set.
    const prompt = renderControllerPrompt(controllerContext);
    const decisionRationale = prompt.slice(0, 500);

    const ctx: WaveRunContext = { sessionId, repoKey, userId, decisionRationale };

    console.log(
      `[orchestrator] cycle session=${sessionId} due=${dueRows.length} ` +
        `commands=[${dueRows.map((d) => d.row.command).join(',')}]`,
    );

    // (a) drive the dependency-aware waves from the DUE rows (live inject).
    try {
      await runWavesFromDueRows(dueRows, ctx, seams);
    } catch (err: any) {
      console.warn(`[orchestrator] wave dispatch threw (ignored): ${err?.message ?? err}`);
    }

    // (b) off-hours merge-to-main (EXCLUDED from the wave planner) — window-gated.
    try {
      await dispatchMergeIfDue(dueRows, { sessionId, userId, repoKey, tz });
    } catch (err: any) {
      console.warn(`[orchestrator] merge-to-main path threw (ignored): ${err?.message ?? err}`);
    }
    void MERGE_COMMAND; // referenced for the special-path constant (see dispatchMergeIfDue).

    // (c) MANDATORY terminal verify tail (Phase 27 / D9). No-ops gracefully when
    // COOLIFY_TOKEN + REMO_VERIFY_* are unset (writes a `skipped` run-log row).
    try {
      await runVerifyTail({
        sessionId,
        repoKey,
        userId,
        decisionRationale,
      });
    } catch (err: any) {
      console.warn(`[orchestrator] verify-tail threw (ignored): ${err?.message ?? err}`);
    }
  };
}

// ── Due-scan enqueue tick (Phase 32 — feeds the queue; gated) ────────────────
/**
 * Periodic enqueue tick: scan every enabled orchestrator task, and for each whose
 * session has ≥1 DUE row this scan, `enqueueCycle(session_id, priority)`. The
 * queue's per-session running-lock coalesces a second enqueue for a session whose
 * cycle is still running (the drain claim filters running sessions), so a fast
 * tick interval cannot stack cycles.
 *
 * Priority: DEPLOY_FIX when a deploy-fix or merge-to-main row is due, else BUILD.
 *
 * Started ONLY by `registerCycleRunnerIfEnabled()` when REMO_ORCHESTRATOR_ENABLED
 * is ON. Flag OFF ⇒ never started ⇒ NOTHING is ever enqueued.
 */
let dueTickTimer: ReturnType<typeof setInterval> | null = null;

function parsePositiveIntEnv(raw: string | undefined, fallback: number): number {
  if (raw == null || raw === '') return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/** Due-scan interval (ms). Default 60000. */
export const DUE_TICK_INTERVAL_MS = parsePositiveIntEnv(
  process.env.REMO_ORCHESTRATOR_TICK_INTERVAL_MS,
  60_000,
);

/**
 * One due-scan pass: enqueue a cycle for every enabled orchestrator task whose
 * session has a DUE row. Exported for tests. Best-effort per task. Returns the
 * session ids enqueued this pass.
 */
export async function scanAndEnqueueDueCycles(now: Date = new Date()): Promise<string[]> {
  const enqueued: string[] = [];
  let tasks: { id: string; session_id: string | null; timezone: string | null }[] = [];
  try {
    const { sql } = await import('../db/postgres.ts');
    tasks = await sql<{ id: string; session_id: string | null; timezone: string | null }[]>`
      SELECT id, session_id, timezone FROM scheduled_tasks
      WHERE task_type = 'orchestrator' AND enabled = true AND session_id IS NOT NULL
    `;
  } catch (err: any) {
    console.warn(`[orchestrator] due-scan task load failed: ${err?.message ?? err}`);
    return enqueued;
  }

  for (const task of tasks) {
    if (!task.session_id) continue;
    try {
      const dueRows = await computeDueRowsForTask(task.id, {
        sessionId: task.session_id,
        now,
        tz: task.timezone ?? 'UTC',
      });
      if (dueRows.length === 0) continue;
      const hot = dueRows.some(
        (d) => d.row.command === 'deploy-fix' || isMergeCommand(d.row.command),
      );
      await enqueueCycle(task.session_id, hot ? CyclePriority.DEPLOY_FIX : CyclePriority.BUILD);
      enqueued.push(task.session_id);
    } catch (err: any) {
      console.warn(
        `[orchestrator] due-scan enqueue failed task=${task.id}: ${err?.message ?? err}`,
      );
    }
  }
  return enqueued;
}

export function startDueOrchestratorTick(): void {
  if (dueTickTimer) return;
  dueTickTimer = setInterval(() => {
    scanAndEnqueueDueCycles().catch((err) =>
      console.warn(`[orchestrator] due-scan tick error: ${err?.message ?? err}`),
    );
  }, DUE_TICK_INTERVAL_MS);
  (dueTickTimer as any).unref?.();
  console.log(`[orchestrator] due-scan tick started (interval=${DUE_TICK_INTERVAL_MS}ms).`);
}

export function stopDueOrchestratorTick(): void {
  if (dueTickTimer) {
    clearInterval(dueTickTimer);
    dueTickTimer = null;
  }
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
  startDueOrchestratorTick();
  console.log(
    '[orchestrator] cycle-runner registered + due-scan tick started (REMO_ORCHESTRATOR_ENABLED=ON).',
  );
  return true;
}
