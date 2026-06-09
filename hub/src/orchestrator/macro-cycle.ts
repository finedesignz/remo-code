// hub/src/orchestrator/macro-cycle.ts
// Milestone TMAC (autonomous task-type macro prompts) — Phase TMAC-04.
//
// The RESUME-HEARTBEAT macro path that REPLACES the per-micro-command-row wave
// engine for an orchestrator task carrying a `macro_task_type` (SPEC §2.1–2.3).
//
// Per tick, for one resolved session:
//   1. RECONCILE the previous turn — parse the latest assistant reply for the
//      three sentinels (sentinels.ts): write a <<STATE>> run-log row, fan out any
//      <<NOTIFY>> per the stage matrix (notify.ts), and if a <<GATE>> is open AND
//      the stage HALTs, stop (do NOT re-inject — wait for the human).
//   2. RESUME — if not halted, resolve `macro_task_type` → the macro prompt
//      (task-macros.ts) and inject it through the cost-capped dispatch pipeline
//      (injectOrchestratorPrompt — IR-1 cost cap non-bypassable). The per-session
//      cycle lock (queue.ts) already guarantees no overlapping inject; an offline
//      session reports `no_session` and reconciles next tick.
//
// Resume is the repo's OWN `.planning/STATE.md` (the macro prompt's STEP 0 reads
// it) — the hub keeps NO parallel state machine. routine_run_log is observability.
//
// Everything is best-effort: a throw in any step is logged, never propagated, so
// one bad tick never wedges the session.

import { renderMacro, type MacroContext } from './task-macros.ts';
import { parseSentinels, type ParsedSentinels } from './sentinels.ts';
import { shouldNotify, fanOutNotify, type NotifyEvent } from './notify.ts';
import { appendRunLog } from './run-log.ts';
import { injectOrchestratorPrompt } from './inject.ts';
import type { LifecycleStage, MacroTaskType } from '../db/orchestrator-rows-dal.ts';

export interface MacroCycleInput {
  userId: string;
  sessionId: string;
  taskId: string;
  macroTaskType: MacroTaskType;
  stage: LifecycleStage;
  repoPath: string;
  repoIdent: string;
  repoKey: string | null;
}

// Injectable seams (tests swap these; defaults are the real adapters).
export interface MacroCycleDeps {
  getLatestAssistantReply: (sessionId: string, userId: string) => Promise<string | null>;
  appendRunLog: typeof appendRunLog;
  inject: typeof injectOrchestratorPrompt;
  fanOut: typeof fanOutNotify;
  /** true when a run is already in flight for this session (per-session lock held). */
  isRunLive: (sessionId: string) => boolean;
}

async function realDeps(): Promise<MacroCycleDeps> {
  const dal = await import('../db/dal.ts');
  const { getQueue } = await import('../dispatch/pipeline.ts');
  return {
    getLatestAssistantReply: async (sessionId, userId) => {
      try {
        const rows = (await dal.listMessages(sessionId, userId)) as Array<{
          role: string;
          content: string | null;
        }>;
        for (let i = rows.length - 1; i >= 0; i--) {
          if (rows[i].role === 'assistant') return rows[i].content ?? null;
        }
      } catch {
        /* best-effort */
      }
      return null;
    },
    appendRunLog,
    inject: injectOrchestratorPrompt,
    fanOut: fanOutNotify,
    isRunLive: (sessionId) => getQueue().currentInFlight(sessionId) != null,
  };
}

export interface MacroCycleResult {
  reconciled: boolean;
  halted: boolean;
  injected: boolean;
  /** true when the tick skipped resume because a run is already live (SPEC §2.3). */
  skipped: boolean;
  /** true when resume was suppressed because the macro for this task_type is a stub (complete=false). */
  stubNotReady: boolean;
  /** the parsed sentinels from the prior reply (for tests/observability). */
  sentinels: ParsedSentinels | null;
}

/**
 * Reconcile the prior turn's sentinels into run-log + notify, decide whether the
 * run is halted on an open mandatory gate, and (if not halted) re-inject the macro
 * to resume. PURE-ish: all IO behind `deps`; never throws.
 */
export async function runMacroCycle(
  input: MacroCycleInput,
  deps?: MacroCycleDeps,
): Promise<MacroCycleResult> {
  const result: MacroCycleResult = { reconciled: false, halted: false, injected: false, skipped: false, stubNotReady: false, sentinels: null };
  let d: MacroCycleDeps;
  try {
    d = deps ?? (await realDeps());
  } catch (err: any) {
    console.error('[orchestrator.macro] dep load failed:', err?.message ?? err);
    return result;
  }

  const { userId, sessionId, stage, macroTaskType, repoKey } = input;

  // 1. RECONCILE the previous turn.
  let sentinels: ParsedSentinels | null = null;
  try {
    const reply = await d.getLatestAssistantReply(sessionId, userId);
    if (reply) {
      sentinels = parseSentinels(reply);
      result.sentinels = sentinels;
      result.reconciled = true;
      await reconcileSentinels(input, sentinels, d);
    }
  } catch (err: any) {
    console.warn('[orchestrator.macro] reconcile threw (ignored):', err?.message ?? err);
  }

  // 2. HALT check — an open GATE at a halting stage stops the resume.
  if (sentinels?.gate && stageHalts(stage)) {
    result.halted = true;
    console.log(
      `[orchestrator.macro] session=${sessionId} HALTED on gate: ${sentinels.gate.reason ?? 'unspecified'} ` +
        `(stage=${stage}); awaiting human reply.`,
    );
    return result;
  }

  // 2b. SKIP if a run is already live (SPEC §2.3): the per-session lock is held,
  //     so the macro is still working — do NOT queue a duplicate resume. The next
  //     heartbeat reconciles once the run finishes.
  if (d.isRunLive(sessionId)) {
    result.skipped = true;
    try {
      await d.appendRunLog({
        session_id: sessionId,
        repo_key: repoKey,
        command: `macro:${macroTaskType}`,
        decision_rationale: `resume-heartbeat skipped (run live, stage=${stage})`,
        outcome: 'skipped',
      });
    } catch {
      /* best-effort */
    }
    return result;
  }

  // 3. RESUME — resolve the macro and inject (cost-capped).
  try {
    const ctx: MacroContext = {
      repo_path: input.repoPath,
      repo_ident: input.repoIdent,
      lifecycle_stage: stage,
    };
    const macro = renderMacro(macroTaskType, ctx);

    // F-12: never inject a half-authored stub prompt on an unattended run. A
    // stub (complete=false) finalizes the tick cleanly with a recognizable
    // run-log row instead of a silent dead run.
    if (!macro.complete) {
      result.stubNotReady = true;
      console.log(
        `[orchestrator.macro] session=${sessionId} macro_task_type=${macroTaskType} is a STUB ` +
          `(complete=false) — skipping inject (stub_not_ready).`,
      );
      try {
        await d.appendRunLog({
          session_id: sessionId,
          repo_key: repoKey,
          command: `macro:${macroTaskType}`,
          decision_rationale: `stub_not_ready (macro for ${macroTaskType} not authored; stage=${stage})`,
          outcome: 'stub_not_ready',
        });
      } catch {
        /* best-effort */
      }
      return result;
    }

    const token = `orch:${sessionId}:macro:${macroTaskType}:${Date.now()}`;
    const outcome = await d.inject({ userId, sessionId, token, prompt: macro.prompt });
    result.injected = outcome.kind === 'dispatched' || outcome.kind === 'queued';

    // Observability: stamp this resume into the run-log.
    try {
      await d.appendRunLog({
        session_id: sessionId,
        repo_key: repoKey,
        command: `macro:${macroTaskType}`,
        decision_rationale: `resume-heartbeat inject (stage=${stage}); outcome=${outcome.kind}`,
        outcome: outcome.kind,
      });
    } catch {
      /* best-effort */
    }

    if (!result.injected) {
      const reason = ('reason' in outcome && (outcome as any).reason) ? (outcome as any).reason : outcome.kind;
      console.log(
        `[orchestrator.macro] session=${sessionId} inject not dispatched: ${outcome.kind} (${reason})`,
      );
      // F-10: a refused/failed unattended resume must surface to the user (even
      // in dev). `no_session` is benign (offline session reconciles next tick) —
      // do NOT page on it; everything else is a real failure/refusal.
      if (outcome.kind !== 'no_session') {
        await emitFailure(d, input, `resume inject ${outcome.kind}: ${reason}`);
      }
    }
  } catch (err: any) {
    console.warn('[orchestrator.macro] inject threw (ignored):', err?.message ?? err);
    // F-10: a thrown resume is a failure — surface it.
    await emitFailure(d, input, `resume inject threw: ${err?.message ?? String(err)}`);
  }

  return result;
}

/**
 * F-10: fan out a `failure` notify for a failed/refused unattended resume. Fires
 * regardless of stage (shouldNotify('failure', ...) is always fire=true). Never
 * throws — fanOut is best-effort and we wrap defensively.
 */
async function emitFailure(deps: MacroCycleDeps, input: MacroCycleInput, detail: string): Promise<void> {
  try {
    const decision = shouldNotify('failure', input.stage, { level: 'blocking', channel: 'all' });
    if (!decision.fire) return;
    await deps.fanOut({
      userId: input.userId,
      sessionId: input.sessionId,
      event: 'failure',
      level: 'blocking',
      detail,
      channels: decision.channels,
    });
  } catch {
    /* fanOut already never-throws; defensive */
  }
}

/** Stages whose blocking gate forces a HALT (SPEC §3): beta + production-maint. */
function stageHalts(stage: LifecycleStage): boolean {
  return stage === 'beta' || stage === 'production-maintenance';
}

/**
 * Reconcile a parsed sentinel set into routine_run_log + notify fan-out. The
 * STATE block becomes a run-log row; NOTIFY blocks + an open GATE drive the
 * stage-gated fan-out (notify.ts shouldNotify owns the policy). Best-effort.
 */
export async function reconcileSentinels(
  input: MacroCycleInput,
  sentinels: ParsedSentinels,
  deps: MacroCycleDeps,
): Promise<void> {
  const { userId, sessionId, stage, repoKey } = input;

  // STATE → one run-log row (observability + resume display).
  if (sentinels.state) {
    const s = sentinels.state;
    const rationale = [
      s.lifecycle && `lifecycle=${s.lifecycle}`,
      s.milestone && `milestone=${s.milestone}`,
      s.phase && `phase=${s.phase}`,
      s.last_action && `last=${s.last_action}`,
      s.next_action && `next=${s.next_action}`,
      s.decisions && s.decisions !== 'none' && `decisions=${s.decisions}`,
    ]
      .filter(Boolean)
      .join('; ');
    try {
      await deps.appendRunLog({
        session_id: sessionId,
        repo_key: repoKey,
        command: 'state',
        decision_rationale: rationale || null,
        outcome: s.lifecycle ?? null,
        deploy_verify_result: s.deployed_live ?? null,
      });
    } catch {
      /* best-effort */
    }
  }

  // NOTIFY blocks — fan out per the stage matrix (info/ship requests).
  //
  // Dedup (SPEC §4 STEP 5): a paused-on-gate turn emits BOTH a `<<GATE>>` AND a
  // `<<NOTIFY level=blocking>>`. Both map to event:'gate', so fanning out both
  // would page the user twice for one gate. When a GATE block is present, let it
  // own the gate fan-out (below) and skip the blocking NOTIFYs here — exactly one
  // gate fan-out per turn.
  for (const n of sentinels.notifies) {
    if (n.level === 'blocking' && sentinels.gate) continue;
    const event: NotifyEvent = n.level === 'blocking' ? 'gate' : 'info';
    const decision = shouldNotify(event, stage, { level: n.level, channel: n.channel });
    if (!decision.fire) continue;
    try {
      await deps.fanOut({
        userId,
        sessionId,
        event,
        level: n.level,
        detail: n.detail ?? '(no detail)',
        channels: decision.channels,
      });
    } catch {
      /* fanOut already never-throws; defensive */
    }
  }

  // GATE block — a mandatory gate. Fan out per stage (the HALT itself is decided
  // by the caller). development suppresses the page; beta/prod fan out.
  if (sentinels.gate) {
    const decision = shouldNotify('gate', stage, { level: 'blocking', channel: 'all' });
    if (decision.fire) {
      const detail = sentinels.gate.detail ?? sentinels.gate.reason ?? 'mandatory gate';
      try {
        await deps.fanOut({
          userId,
          sessionId,
          event: 'gate',
          level: 'blocking',
          detail,
          channels: decision.channels,
        });
      } catch {
        /* defensive */
      }
    }
  }
}
