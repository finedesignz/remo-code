// hub/src/orchestrator/merge-command.ts
// Phase 29 (auto-dev-orchestrator) — the dedicated OFF-HOURS merge-to-main command.
//
// Locked decision D8 / R-ADO-24 / R-ADO-25: this is the ONLY auto-merge-to-main
// path. It is its OWN command — EXCLUDED from the wave planner (waves.ts
// EXCLUDED_COMMANDS) — and is routed here directly by the controller.
//
//   WINDOW GATE  — runs ONLY inside the merge row's configured off-hours
//                  `schedule_rule.active_window` (reuse `isWithinActiveWindow`
//                  from scheduler/schedule-rules.ts — NO new window logic).
//                  Outside the window ⇒ a skipped run-log row, nothing injected.
//   SELECTION    — (decision D8 / D5) PRs whose dispatched reviewer marked PASS
//                  (verdict read from routine_run_log). For an ORDINARY dev-command
//                  PR (command NOT in PROPOSE_ONLY_COMMANDS) a reviewer PASS is
//                  SUFFICIENT ⇒ auto-merge in-window, NO approval marker required.
//                  For a POWERFUL-command PR (command ∈ PROPOSE_ONLY_COMMANDS —
//                  ship / complete-milestone / tag + aliases) PASS is NOT enough:
//                  it also needs an UNCONSUMED approval marker (P28 HITL contract —
//                  orchestrator_approvals, keyed by content_sha = sha256(pr_url)).
//                  FAIL / UNCERTAIN (any command), or a powerful-command PR without
//                  an approval, are HELD and surfaced to chat (notifyChatSurface).
//   IDEMPOTENCY  — a consumed powerful-command approval is marked CONSUMED at
//                  selection time, so a re-fired window cannot re-select it
//                  (R-ADO-25). Dev-PR auto-merges consume no marker; the merged PR
//                  closes, so a re-fired window finds no open PASS row for it.
//   HUB STAYS TEXT-ONLY — the hub NEVER shells gh/git/merge. It injects a templated
//                  prompt (cost-cap-gated via injectOrchestratorPrompt) instructing
//                  the bound session AGENT to `gh pr merge --squash` ONLY the
//                  selected PRs in-turn. The hub writes ONE run-log row.
//
// Behind REMO_ORCHESTRATOR_ENABLED (default OFF) — the controller only routes here
// when the flag is on; this module is otherwise dormant.

import { createHash } from 'node:crypto';
import { isWithinActiveWindow } from '../scheduler/schedule-rules.ts';
import type { ScheduleRule } from '../scheduler/schedule-rules.ts';
import { recentRunLog, appendRunLog } from './run-log.ts';
import {
  listUnconsumedApprovals,
  markApprovalConsumed,
} from '../db/orchestrator-rows-dal.ts';
import { injectOrchestratorPrompt } from './inject.ts';
import { notifyChatSurface } from './propose.ts';
import { PROPOSE_ONLY_COMMANDS } from './command-prompts.ts';

/** The canonical command name. EXCLUDED from the wave planner; routed here. */
export const MERGE_COMMAND = 'merge-to-main';

export function isMergeCommand(command: string): boolean {
  return command === MERGE_COMMAND;
}

/** sha256(pr_url) — the proposal content hash the merge command keys approvals on. */
export function prContentSha(prUrl: string): string {
  return createHash('sha256').update(prUrl).digest('hex');
}

// How far back to scan the run log for PASS PRs awaiting merge. Bounded so a long
// session's history does not blow up the read; newest-first.
const RUN_LOG_SCAN = 50;

export interface MergeRunContext {
  sessionId: string;
  userId: string | null;
  repoKey: string | null;
  /** The merge row's schedule rule — carries the off-hours active_window. */
  scheduleRule: ScheduleRule | null;
  /** Task-local timezone for window resolution (defaults to UTC). */
  tz?: string;
}

/** Injectable seams — tests swap these to avoid DB / inject / clock / network. */
export interface MergeDeps {
  now: () => Date;
  recentRunLog: typeof recentRunLog;
  listUnconsumedApprovals: typeof listUnconsumedApprovals;
  markApprovalConsumed: typeof markApprovalConsumed;
  injectOrchestratorPrompt: typeof injectOrchestratorPrompt;
  notifyChatSurface: typeof notifyChatSurface;
  appendRunLog: typeof appendRunLog;
}

const REAL_DEPS: MergeDeps = {
  now: () => new Date(),
  recentRunLog,
  listUnconsumedApprovals,
  markApprovalConsumed,
  injectOrchestratorPrompt,
  notifyChatSurface,
  appendRunLog,
};

export type MergeOutcome =
  | { kind: 'skipped_out_of_window' }
  | { kind: 'no_candidates' }
  | { kind: 'dispatched'; merged: string[]; held: string[] }
  | { kind: 'held_only'; held: string[] }
  | { kind: 'refused'; reason: string; held: string[] };

interface Candidate {
  prUrl: string;
  command: string;
  verdict: string;
}

/**
 * Run the off-hours merge-to-main command for one session.
 *
 * Returns a typed outcome (tests assert on it). Best-effort: a hold-notify failure
 * never aborts the merge dispatch, and vice-versa.
 */
export async function runMergeToMain(
  ctx: MergeRunContext,
  deps: MergeDeps = REAL_DEPS,
): Promise<MergeOutcome> {
  const now = deps.now();
  const tz = ctx.tz ?? 'UTC';

  // ── WINDOW GATE (R-ADO-24) ────────────────────────────────────────────────
  // Outside the configured off-hours window ⇒ no-op (skipped run-log row). A null
  // rule has no window ⇒ isWithinActiveWindow returns true (no gate) — but the
  // merge row is expected to carry one; we honour whatever is configured.
  if (ctx.scheduleRule && !isWithinActiveWindow(ctx.scheduleRule, now, tz)) {
    await deps.appendRunLog({
      session_id: ctx.sessionId,
      repo_key: ctx.repoKey,
      command: MERGE_COMMAND,
      outcome: 'skipped_out_of_window',
      decision_rationale: 'Outside the configured off-hours active_window — held.',
    });
    return { kind: 'skipped_out_of_window' };
  }

  // ── GATHER PASS PRs from the run log (newest-first, deduped per pr_url) ────
  const log = await deps.recentRunLog(ctx.sessionId, RUN_LOG_SCAN);
  const candidates = new Map<string, Candidate>(); // pr_url → newest entry
  for (const e of log) {
    const prUrl = (e.pr_url ?? '').trim();
    if (!prUrl) continue;
    if (e.command === MERGE_COMMAND) continue; // never re-merge our own log rows
    if (!candidates.has(prUrl)) {
      candidates.set(prUrl, {
        prUrl,
        command: e.command,
        verdict: (e.reviewer_verdict ?? '').trim().toUpperCase(),
      });
    }
  }

  // ── SELECT (decision D8 / D5) ─────────────────────────────────────────────
  // Dev-command PRs: reviewer PASS ⇒ auto-merge (NO approval marker needed).
  // Powerful-command PRs (∈ PROPOSE_ONLY_COMMANDS): PASS AND an unconsumed
  // approval marker; otherwise HELD. FAIL / UNCERTAIN (any command) ⇒ HELD.
  const approvals = await deps.listUnconsumedApprovals(ctx.sessionId);
  // index unconsumed approvals by content_sha for O(1) match per PR.
  const approvalBySha = new Map<string, { id: string }>();
  for (const a of approvals) approvalBySha.set(a.content_sha, { id: a.id });

  const merged: string[] = [];
  const held: string[] = [];

  for (const c of candidates.values()) {
    if (c.verdict !== 'PASS') {
      held.push(c.prUrl); // FAIL / UNCERTAIN ⇒ HOLD (any command).
      continue;
    }
    const needsApproval = PROPOSE_ONLY_COMMANDS.has(c.command);
    if (!needsApproval) {
      merged.push(c.prUrl); // ordinary dev PR + PASS ⇒ auto-merge.
      continue;
    }
    const approval = approvalBySha.get(prContentSha(c.prUrl));
    if (approval) {
      // Powerful command: mark consumed BEFORE inject so a re-fired window cannot
      // re-select it, even if the agent's merge turn is still in flight.
      await deps.markApprovalConsumed(approval.id);
      merged.push(c.prUrl);
    } else {
      held.push(c.prUrl); // powerful-command PR awaiting approval ⇒ HOLD.
    }
  }

  // ── HOLD + surface (R-ADO-25) ─────────────────────────────────────────────
  if (held.length > 0) {
    await deps
      .notifyChatSurface({
        sessionId: ctx.sessionId,
        userId: ctx.userId,
        summary:
          `Off-hours merge held ${held.length} PR(s) (FAIL / uncertain, or ship/milestone/tag awaiting approval) — ` +
          `not auto-merged:\n${held.map((u) => `- ${u}`).join('\n')}`,
      })
      .catch(() => {});
  }

  if (merged.length === 0) {
    await deps.appendRunLog({
      session_id: ctx.sessionId,
      repo_key: ctx.repoKey,
      command: MERGE_COMMAND,
      outcome: held.length > 0 ? 'held_only' : 'no_candidates',
      decision_rationale:
        held.length > 0
          ? `No mergeable PRs; held ${held.length}: ${held.join(', ')}`
          : 'No PRs awaiting merge.',
    });
    return held.length > 0 ? { kind: 'held_only', held } : { kind: 'no_candidates' };
  }

  // ── INJECT: agent does `gh pr merge --squash` ONLY the selected PRs ───────
  // Hub stays TEXT-ONLY (IR): it never shells gh/git/merge — it injects this
  // prompt, cost-cap-gated, and the bound session agent merges in-turn.
  const prompt = composeMergePrompt(merged, ctx.repoKey);
  const token = `orch:${ctx.sessionId}:${MERGE_COMMAND}:${now.getTime()}`;
  const userId = (ctx.userId ?? '').trim();

  if (!userId) {
    await deps.appendRunLog({
      session_id: ctx.sessionId,
      repo_key: ctx.repoKey,
      command: MERGE_COMMAND,
      outcome: 'refused_no_user',
      decision_rationale: `Selected ${merged.length} PR(s) but no owning user to dispatch.`,
    });
    return { kind: 'refused', reason: 'no_user', held };
  }

  const inj = await deps.injectOrchestratorPrompt({
    userId,
    sessionId: ctx.sessionId,
    token,
    prompt,
  });

  const dispatched = inj.kind === 'dispatched' || inj.kind === 'queued';
  await deps.appendRunLog({
    session_id: ctx.sessionId,
    repo_key: ctx.repoKey,
    command: MERGE_COMMAND,
    outcome: dispatched ? 'merge_dispatched' : `refused_${inj.kind}`,
    decision_rationale:
      `Merging ${merged.length} PR(s) (dev PASS auto-merge; ship/milestone/tag approved): ${merged.join(', ')}.` +
      (held.length > 0 ? ` Held ${held.length}: ${held.join(', ')}.` : '') +
      ` Inject=${inj.kind}.`,
  });

  if (!dispatched) {
    return { kind: 'refused', reason: inj.kind, held };
  }
  return { kind: 'dispatched', merged, held };
}

/**
 * The templated prompt the agent runs in-turn. The hub composes TEXT only; the
 * agent does the `gh pr merge` + marks the approval consumed in its own report.
 */
export function composeMergePrompt(prUrls: string[], repoKey: string | null): string {
  const repo = repoKey ?? 'this repo';
  return [
    `Off-hours auto-merge for ${repo}. The following PRs passed review AND were approved:`,
    ...prUrls.map((u) => `- ${u}`),
    '',
    'For EACH PR above (and ONLY these — do not touch any other PR or branch):',
    '1. `gh pr merge <pr> --squash --delete-branch` (squash-merge to main).',
    '2. If a merge fails (conflict, checks red, branch protection), STOP that PR,',
    '   leave it open, and note it — do NOT force.',
    '',
    'This is the ONLY sanctioned merge-to-main path. Do not merge anything not listed.',
    'Respect the daily cost cap and chain-depth — they are non-bypassable.',
    'Report which PRs merged and which you could not, one per line.',
  ].join('\n');
}
