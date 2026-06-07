// hub/src/orchestrator/propose.ts
// Phase 28 (auto-dev-orchestrator) — tiered-autonomy PROPOSE-to-chat (locked
// decision D5).
//
// Reqs:
//   R-ADO-22 — high-tier commands (gsd-ship / gsd-complete-milestone / version-tag /
//              production-merge) surface a propose-to-chat for one-tap approval
//              instead of executing. The controller STOPS that branch (the wave
//              runner routes propose units here, never to executeCommand).
//   R-ADO-23 — reuse the SHIPPED auto-dev P3 propose-to-chat machinery
//              (notify_email + notify_telegram senders + the `notifications_sent`
//              throttle) — do NOT fork a parallel notifier.
//
// REUSE (not fork): the P3 `surfaceProposal` (scheduler/post-run/propose-notify.ts)
// is bound to a ScheduledTask + a roadmap + the `pending_proposal` HITL record on
// `scheduled_tasks`. An orchestrator PROPOSE unit is a `WaveUnit` (a gsd command),
// not a task, and has no roadmap — so we reuse surfaceProposal's BUILDING BLOCKS:
// the exact same `executeEmail` / `executeTelegram` post-run senders and the same
// `notifications_sent` throttle pattern (kind `propose_roadmap`, record-before-send,
// TTL dedupe by sha(content)). One notify path, no second notifier.
//
// NO AUTO-EXECUTE: this module ONLY notifies. It never opens a PR, never merges,
// never tags. The human approves out-of-band; the off-hours Phase-29 merge command
// is the ONLY path that acts on an approval (see the HITL contract below).
//
// RUN-LOG: the single `routine_run_log` row for a propose unit (outcome='proposed')
// is written by the wave runner's `runUnit` AFTER `proposeToChat` returns — this
// module deliberately does NOT write a second row (that would double-log the unit).
//
// SAFETY: best-effort throughout — a failed send / DB write is log-only and never
// throws upstream (a notify failure must not wedge a wave or the verify tail). The
// live seams that call this only run from the `REMO_ORCHESTRATOR_ENABLED`-gated
// cycle-runner, so prod stays dormant with the flag OFF.
//
// ── HITL APPROVAL CONTRACT (the Phase-29 seam) ───────────────────────────────
// P28 PROPOSES; it does NOT reconcile approvals. The minimal contract a future
// approval path (and Phase-29 off-hours merge) MUST honour:
//   1. A proposal is identified by (sessionId, command, contentSha) — the same
//      tuple this module hashes into the throttle dedupe key.
//   2. A human approval writes an APPROVAL MARKER for that tuple (e.g. an
//      `orchestrator_approvals(session_id, command, content_sha, approved_at,
//      consumed_at)` row — schema TBD in Phase 29; intentionally NOT created here).
//   3. The dedicated off-hours merge command (Phase 29) reads UNCONSUMED markers and
//      THEN runs ship/merge for the approved tuple, marking it consumed. Nothing in
//      P28 ever acts on a marker — propose-only.
// We do NOT reuse the Telegram numeric-reply HITL path (telegram-webhook.ts →
// `captureApprovalReply`) for orchestrator units: that path resolves against
// `pending_proposal` on `scheduled_tasks` and writes `payload.notes`, which an
// orchestrator command (no task row) has nowhere to land. Wiring it would require
// the new approvals table above — Phase-29 scope.

import { createHash } from 'node:crypto';
import { sql } from '../db/postgres.ts';
import { executeEmail } from '../scheduler/post-run/email.ts';
import { executeTelegram } from '../scheduler/post-run/telegram.ts';
import type { WaveUnit } from './waves.ts';
import type { WaveRunContext } from './wave-runner.ts';

/** One propose-notify per (session, command, content) per 6h — a stable proposal pings once. */
export const ORCH_PROPOSE_TTL_SECONDS = 6 * 60 * 60;

/** Human label for each high-tier command (what the proposal says it will do). */
const COMMAND_LABEL: Readonly<Record<string, string>> = Object.freeze({
  ship: 'ship the current milestone (cut a release)',
  'gsd-ship': 'ship the current milestone (cut a release)',
  'complete-milestone': 'complete the current milestone',
  'gsd-complete-milestone': 'complete the current milestone',
  tag: 'cut a version tag',
  'gsd-tag': 'cut a version tag',
  'production-merge': 'merge to production',
});

function commandLabel(command: string): string {
  return COMMAND_LABEL[(command ?? '').trim()] ?? `run the high-tier command \`${command}\``;
}

/** Stable short hash of the message content — the dedupe key component. */
function contentSha(text: string): string {
  return createHash('sha256').update(text.trim()).digest('hex').slice(0, 16);
}

/**
 * Compose the human-facing approval message for a PROPOSE unit. PURE + testable.
 * The PR(s) involved are reconciled on a later tick (P25), so the message names
 * the COMMAND + repo + (optional) micro-prompt + a one-tap approval instruction —
 * it does NOT claim a specific PR diff it cannot see.
 */
export function composeProposalMessage(unit: WaveUnit, repoKey: string | null): string {
  const repo = repoKey?.trim() || 'this repo';
  const micro = unit.microPrompt?.trim();
  const lines = [
    `Auto-dev is ready to ${commandLabel(unit.command)} for ${repo}.`,
    '',
    `This is a HIGH-TIER action (command \`${unit.command}\`) — it is NOT run automatically.`,
    'Reply to APPROVE and it will run on the next off-hours cycle; otherwise it stays held.',
  ];
  if (micro) {
    lines.splice(1, 0, `Context: ${micro}`);
  }
  return lines.join('\n');
}

/**
 * Throttle gate over `notifications_sent` — mirrors the P3 propose-notify throttle
 * EXACTLY (kind `propose_roadmap`, record-before-send so a transient send failure
 * can't retry-storm the next identical tick). Returns true when a send is allowed.
 * Reuses the existing `propose_roadmap` kind so NO schema/constraint change is
 * needed; the dedupe key is namespaced (`orch-propose:` / `orch-verify:`) so it
 * never collides with a scheduled-task roadmap proposal.
 */
async function throttleAllow(dedupeKey: string, ttlSeconds: number): Promise<boolean> {
  try {
    const existing = await sql<{ id: string }[]>`
      SELECT id FROM notifications_sent
      WHERE kind = 'propose_roadmap'
        AND dedupe_key = ${dedupeKey}
        AND sent_at > now() - (${ttlSeconds} || ' seconds')::interval
      LIMIT 1
    `;
    if (existing.length > 0) return false;
  } catch (err: any) {
    // Better to risk a duplicate than to drop the proposal — fall through to send.
    console.error('[orchestrator-propose] throttle check failed:', err?.message);
  }
  try {
    await sql`
      INSERT INTO notifications_sent (kind, dedupe_key) VALUES ('propose_roadmap', ${dedupeKey})
    `;
  } catch (err: any) {
    console.error('[orchestrator-propose] throttle insert failed:', err?.message);
  }
  return true;
}

/**
 * Send a chat surface (email + Telegram) via the SHIPPED post-run senders. Reuses
 * the same in-memory synthesized notify actions as P3 surfaceProposal — formatting
 * + recipient resolution live in the senders. Both are log-only on failure and
 * never throw upstream.
 */
async function sendChat(userId: string, subject: string, message: string): Promise<void> {
  const templateVars = { proposal: message };
  await executeEmail(
    {
      type: 'notify_email',
      on: 'success',
      // `to` undefined → executeEmail resolves the account email.
      config: { subject, body: '{{proposal}}' },
    } as any,
    { userId, templateVars },
  );
  await executeTelegram(
    { type: 'notify_telegram', on: 'success', config: { body: '{{proposal}}' } } as any,
    { userId, templateVars },
  );
}

export interface ProposeResult {
  /** true ⇒ the proposal was sent this call. */
  surfaced: boolean;
  /** true ⇒ suppressed by the TTL throttle (an identical proposal already pinged). */
  throttled: boolean;
  /** the composed message (for logging/tests), or null when nothing was surfaced. */
  message: string | null;
}

/**
 * Phase-28 LIVE `proposeToChat` seam. Surfaces a high-tier (ship/complete-milestone/
 * tag) unit to chat for one-tap approval. NOTIFY-ONLY (no execute, no PR, no merge,
 * no run-log row — the wave runner writes the `proposed` row). Idempotent within the
 * TTL. Never throws.
 *
 * Returns a typed result; the wave seam adapter ignores it (its contract is
 * `Promise<void>`), but tests + future callers can assert surfaced/throttled.
 */
export async function proposeToChat(unit: WaveUnit, ctx: WaveRunContext): Promise<ProposeResult> {
  const message = composeProposalMessage(unit, ctx.repoKey);

  const userId = ctx.userId?.trim();
  if (!userId) {
    // No owning user → cannot resolve a recipient. Log + skip (best-effort).
    console.warn(
      `[orchestrator-propose] no userId for propose command=${unit.command}; not surfaced`,
    );
    return { surfaced: false, throttled: false, message: null };
  }

  const dedupeKey = `orch-propose:${ctx.sessionId}:${unit.command}:${contentSha(message)}`;
  const allowed = await throttleAllow(dedupeKey, ORCH_PROPOSE_TTL_SECONDS);
  if (!allowed) {
    console.log(
      `[orchestrator-propose] command=${unit.command} suppressed (throttle) key=${dedupeKey}`,
    );
    return { surfaced: false, throttled: true, message };
  }

  const subject = `[remo-code] Auto-dev proposes: ${unit.command}`;
  await sendChat(userId, subject, message);
  console.log(`[orchestrator-propose] surfaced propose command=${unit.command} session=${ctx.sessionId}`);
  return { surfaced: true, throttled: false, message };
}

/**
 * Phase-28 LIVE verify-tail surface — the real `NotifySeam` for verify-tail.ts.
 * Same shape as the verify-tail stub `{sessionId, userId, summary}`; surfaces an
 * exhausted/failed verify tail to chat via the SAME throttle + sender path. The
 * verify tail writes its OWN `verify_failed` run-log row, so this is notify-only.
 * Best-effort, never throws (verify-tail wraps the call in `.catch(() => {})` too).
 */
export async function notifyChatSurface(input: {
  sessionId: string;
  userId: string | null;
  summary: string;
}): Promise<void> {
  const userId = input.userId?.trim();
  if (!userId) {
    console.warn(
      `[orchestrator-propose] verify-tail surface has no userId session=${input.sessionId}; logging only:\n${input.summary}`,
    );
    return;
  }
  const dedupeKey = `orch-verify:${input.sessionId}:${contentSha(input.summary)}`;
  const allowed = await throttleAllow(dedupeKey, ORCH_PROPOSE_TTL_SECONDS);
  if (!allowed) {
    console.log(`[orchestrator-propose] verify surface suppressed (throttle) key=${dedupeKey}`);
    return;
  }
  await sendChat(userId, '[remo-code] Auto-dev verify tail FAILED', input.summary);
  console.log(`[orchestrator-propose] surfaced verify failure session=${input.sessionId}`);
}
